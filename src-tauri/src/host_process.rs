//! Blocking provider adapter over an independently routed host RPC service.
//! The host owns process creation, cancellation, descendants and output spools.
use crate::error::AppError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Output},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::Duration,
};
type SendFrame = dyn Fn(Value) -> Result<(), AppError> + Send + Sync;
type Reply = Result<Value, AppError>;
struct Service {
    send: Arc<SendFrame>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    enabled: AtomicBool,
    sequence: AtomicU64,
}
static SERVICE: OnceLock<Service> = OnceLock::new();

pub fn configure(send: impl Fn(Value) -> Result<(), AppError> + Send + Sync + 'static) {
    let _ = SERVICE.set(Service {
        send: Arc::new(send),
        pending: Mutex::new(HashMap::new()),
        enabled: AtomicBool::new(false),
        sequence: AtomicU64::new(1),
    });
}
pub(crate) fn enable(enabled: bool) {
    if let Some(service) = SERVICE.get() {
        service.enabled.store(enabled, Ordering::Release);
    }
}
pub fn deliver(frame: &Value) -> bool {
    let Some(id) = frame.get("id").and_then(Value::as_str) else {
        return false;
    };
    let Some(service) = SERVICE.get() else {
        return false;
    };
    let sender = service
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(id);
    if let Some(sender) = sender {
        let valid = frame["jsonrpc"] == "2.0"
            && frame.get("result").is_some() != frame.get("error").is_some();
        let result = if !valid {
            Err(AppError::Other("Malformed host process reply".into()))
        } else if let Some(error) = frame.get("error") {
            Err(AppError::Other(
                error["message"]
                    .as_str()
                    .unwrap_or("Host process service failed")
                    .into(),
            ))
        } else {
            Ok(frame["result"].clone())
        };
        let _ = sender.send(result);
    }
    id.starts_with("host:")
}
pub fn disconnected() {
    if let Some(service) = SERVICE.get() {
        for (_, sender) in service
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
        {
            let _ = sender.send(Err(AppError::Other("Plugin host disconnected".into())));
        }
    }
}

fn invoke(method: &str, params: Value, cancelled: &impl Fn() -> bool) -> Reply {
    let service = SERVICE
        .get()
        .ok_or_else(|| AppError::Other("Host process service is unavailable".into()))?;
    let id = format!("host:{}", service.sequence.fetch_add(1, Ordering::Relaxed));
    let (sender, receiver) = mpsc::channel();
    service
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id.clone(), sender);
    if let Err(error) =
        (service.send)(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
    {
        service
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
        return Err(error);
    }
    loop {
        if cancelled() {
            service
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            let _ = (service.send)(
                json!({"jsonrpc":"2.0","method":"host.process.cancel","params":{"requestId":id}}),
            );
            return Err(AppError::Other("Codex image job cancelled".into()));
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err(AppError::Other("Host process reply was lost".into())),
        }
    }
}

fn spool(path: &Value, limit: usize) -> Result<Vec<u8>, AppError> {
    let path = path
        .as_str()
        .ok_or_else(|| AppError::Other("Invalid host output handle".into()))?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() > limit as u64 {
        return Err(AppError::Other(
            "Host process output exceeds its limit".into(),
        ));
    }
    let mut bytes = vec![];
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(AppError::Other(
            "Host process output exceeds its limit".into(),
        ));
    }
    Ok(bytes)
}

pub(crate) fn execute(
    command: &Command,
    cancelled: &impl Fn() -> bool,
    limits: (usize, usize),
) -> Option<Result<Output, AppError>> {
    if !SERVICE
        .get()
        .is_some_and(|service| service.enabled.load(Ordering::Acquire))
    {
        return None;
    }
    Some((|| {
        let env: Vec<_> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let result = invoke(
            "host.process.run",
            json!({"program":command.get_program().to_string_lossy(),"args":command.get_args().map(|arg|arg.to_string_lossy().into_owned()).collect::<Vec<_>>(),"cwd":command.get_current_dir(),"env":env,"stdoutLimit":limits.0,"stderrLimit":limits.1}),
            cancelled,
        )?;
        let output = (|| {
            let raw = result["status"]
                .as_i64()
                .ok_or_else(|| AppError::Other("Invalid host process status".into()))?;
            #[cfg(unix)]
            let status = {
                use std::os::unix::process::ExitStatusExt;
                std::process::ExitStatus::from_raw(raw as i32)
            };
            #[cfg(windows)]
            let status = {
                use std::os::windows::process::ExitStatusExt;
                std::process::ExitStatus::from_raw(raw as u32)
            };
            Ok(Output {
                status,
                stdout: spool(&result["stdout"], limits.0)?,
                stderr: spool(&result["stderr"], limits.1)?,
            })
        })();
        if let Some(service) = SERVICE.get() {
            let _ = (service.send)(
                json!({"jsonrpc":"2.0","method":"host.process.release","params":{"handle":result["handle"]}}),
            );
        }
        output
    })())
}
