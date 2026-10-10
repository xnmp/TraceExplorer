//! Owned process adapter over the shared connection-wide host RPC client.
use crate::error::AppError;
use serde_json::{json, Value};
use std::{
    io::Read,
    process::{Command, Output},
    sync::atomic::{AtomicBool, Ordering},
};
static ENABLED: AtomicBool = AtomicBool::new(false);
pub(crate) fn enable(enabled: bool) {
    ENABLED.store(enabled, Ordering::Release);
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
    if !ENABLED.load(Ordering::Acquire) {
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
        let result = crate::host_rpc::invoke(
            "host.process.run",
            json!({"program":command.get_program().to_string_lossy(),"args":command.get_args().map(|arg|arg.to_string_lossy().into_owned()).collect::<Vec<_>>(),"cwd":command.get_current_dir(),"env":env,"stdoutLimit":limits.0,"stderrLimit":limits.1}),
            cancelled,
            None,
            Some(("host.process.cancel", Value::Null)),
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
        let _ = crate::host_rpc::notify("host.process.release", json!({"handle":result["handle"]}));
        output
    })())
}
