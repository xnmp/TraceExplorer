//! Bounded stdio reader always routes reverse replies before handler admission.
use image_generation_backend::{
    error::{error, Result},
    host::NativeHost,
    service::{text, Service},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use te_image_generation_contract::{Caller, PrepareRequest, StartRequest};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    caller: Caller,
    request: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostOperationControl {
    control_token: String,
    consumer_package: String,
    operation_id: String,
}
fn send(stdout: &Mutex<io::Stdout>, frame: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > 1024 * 1024 {
        return Err(io::Error::other("Image service reply exceeds frame bound"));
    }
    let mut output = stdout
        .lock()
        .map_err(|_| io::Error::other("Output mutex failed"))?;
    output.write_all(&bytes)?;
    output.write_all(b"\n")?;
    output.flush()
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| error("invalid_request", "Malformed image service request"))
}
fn execute(
    service: &Arc<Service>,
    initialized: &AtomicBool,
    control: &OnceLock<String>,
    validation_only: &OnceLock<bool>,
    normal_handlers: &tokio::sync::Semaphore,
    control_handlers: &tokio::sync::Semaphore,
    request: Request,
) -> Result<Value> {
    if request.jsonrpc != "2.0" {
        return Err(error("invalid_request", "Unsupported protocol"));
    }
    if request.method == "initialize" {
        if request.params["protocolVersion"] != 1 {
            return Err(error("unavailable", "Incompatible host protocol"));
        }
        for capability in [
            "serviceService",
            "artifactService",
            "credentialService",
            "jobService",
        ] {
            if request.params[capability]["version"] != 1 {
                return Err(error(
                    "unavailable",
                    "Host image-service capabilities are required",
                ));
            }
        }
        if request.params["processService"] != true {
            return Err(error(
                "unavailable",
                "Host-owned process execution is required",
            ));
        }
        if request.params["validationOnly"] == true {
            service.validate_preflight()?;
        }
        let readonly = request.params["validationOnly"] == true;
        if validation_only.get().is_some_and(|old| *old != readonly) {
            return Err(error(
                "permission_denied",
                "Initialization validation mode cannot change",
            ));
        }
        let token = request.params["hostControl"]["token"]
            .as_str()
            .filter(|s| te_image_generation_contract::valid_digest(s))
            .ok_or_else(|| error("unavailable", "Native host control token is required"))?;
        if let Some(previous) = control.get() {
            if previous != token {
                return Err(error(
                    "permission_denied",
                    "Native host control token cannot change",
                ));
            }
        } else if control.set(token.into()).is_err()
            && control.get().is_some_and(|previous| previous != token)
        {
            return Err(error(
                "permission_denied",
                "Native host control token cannot change",
            ));
        }
        if validation_only.set(readonly).is_err() && validation_only.get() != Some(&readonly) {
            return Err(error(
                "permission_denied",
                "Initialization validation mode cannot change",
            ));
        }
        initialized.store(true, Ordering::Release);
        return Ok(
            json!({"protocolVersion":1,"ready":false,"pluginVersion":env!("CARGO_PKG_VERSION")}),
        );
    }
    if request.method == "lifecycle.activate" {
        if validation_only.get() == Some(&true) {
            return Err(error(
                "permission_denied",
                "Read-only preflight cannot activate generation",
            ));
        }
        if !initialized.load(Ordering::Acquire) {
            return Err(error(
                "unavailable",
                "Host initialization handshake is required",
            ));
        }
        service.activate()?;
        return Ok(json!({"ready":true}));
    }
    if request.method == "lifecycle.quiesce" {
        if !initialized.load(Ordering::Acquire) {
            return Err(error(
                "unavailable",
                "Host initialization handshake is required",
            ));
        }
        return service.quiesce_with_handlers(|| {
            normal_handlers.available_permits() == 32 && control_handlers.available_permits() == 7
        });
    }
    if !service.ready() {
        return Err(error(
            "unavailable",
            "Image service activation is not ready",
        ));
    }
    if let Some(method) = request.method.strip_prefix("control.") {
        if !initialized.load(Ordering::Acquire) || validation_only.get() == Some(&true) {
            return Err(error(
                "permission_denied",
                "Native active host controls are required",
            ));
        }
        let params: HostOperationControl = parse(request.params)?;
        if control.get().map(String::as_str) != Some(params.control_token.as_str()) {
            return Err(error(
                "permission_denied",
                "Native host control token is required",
            ));
        }
        return match method {
            "operationIdle" => Ok(
                json!({"idle":service.operation_idle(&params.consumer_package,&params.operation_id)?}),
            ),
            "discardOperation" => serde_json::to_value(
                service.discard_operation(&params.consumer_package, &params.operation_id)?,
            )
            .map_err(|_| error("unavailable", "Image receipt serialization failed")),
            _ => Err(error("method_not_found", "Unknown native host control")),
        };
    }
    if let Some(method) = request.method.strip_prefix("migration.") {
        let expected = control
            .get()
            .ok_or_else(|| error("permission_denied", "Native host control token is required"))?;
        if request.params["controlToken"].as_str() != Some(expected.as_str()) {
            return Err(error(
                "permission_denied",
                "Native host control token is required",
            ));
        }
        return service.migration(method, request.params);
    }
    if let Some(method) = request.method.strip_prefix("settings.") {
        return service.settings(method, request.params);
    }
    let method = request
        .method
        .strip_prefix("services.image-generation.v1.")
        .ok_or_else(|| error("method_not_found", "Unknown image service method"))?;
    let envelope: Envelope = parse(request.params)?;
    let caller = envelope.caller;
    let value = match method {
        "describe" => service.describe()?,
        "prepare" => serde_json::to_value(
            service.prepare(caller, parse::<PrepareRequest>(envelope.request)?)?,
        )
        .unwrap(),
        "start" => serde_json::to_value(service.start(
            caller,
            parse::<StartRequest>(envelope.request)?,
            false,
        )?)
        .unwrap(),
        "status" => serde_json::to_value(
            service.status(&caller.package_id, &text(&envelope.request, "operationId")?)?,
        )
        .unwrap(),
        "cancel" => serde_json::to_value(
            service.cancel(&caller.package_id, &text(&envelope.request, "operationId")?)?,
        )
        .unwrap(),
        "acknowledge" => serde_json::to_value(service.journal.acknowledge(
            &caller.package_id,
            &text(&envelope.request, "operationId")?,
            &text(&envelope.request, "outputSha256")?,
            &text(&envelope.request, "disposition")?,
            envelope.request["transferReceipt"].as_str(),
        )?)
        .unwrap(),
        _ => return Err(error("method_not_found", "Unknown image service method")),
    };
    Ok(value)
}
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--data-dir")) {
        return Err("Usage: image-generation-backend --data-dir <absolute-directory>".into());
    }
    let directory = PathBuf::from(args.next().ok_or("Missing data directory")?);
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    let output = Arc::new(Mutex::new(io::stdout()));
    let transport = output.clone();
    te_plugin_runtime::configure(move |frame| send(&transport, &frame).map_err(Into::into));
    let service = Service::new(&directory, Arc::new(NativeHost))
        .map_err(|_| "Image service initialization failed")?;
    let initialized = Arc::new(AtomicBool::new(false));
    let control_token = Arc::new(OnceLock::new());
    let validation_only = Arc::new(OnceLock::new());
    let normal = Arc::new(tokio::sync::Semaphore::new(32));
    let control = Arc::new(tokio::sync::Semaphore::new(8));
    let active = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let handle = tokio::runtime::Handle::current();
    let reader = std::thread::spawn({
        let service = service.clone();
        move || {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            loop {
                let mut bytes = vec![];
                match input
                    .by_ref()
                    .take(1024 * 1024 + 2)
                    .read_until(b'\n', &mut bytes)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_)
                        if bytes.len() - usize::from(bytes.last() == Some(&b'\n'))
                            > 1024 * 1024 =>
                    {
                        break
                    }
                    _ => {}
                }
                let frame: Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = send(
                            &output,
                            &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Malformed JSON"}}),
                        );
                        continue;
                    }
                };
                if te_plugin_runtime::deliver(&frame) {
                    continue;
                }
                let request: Request = match serde_json::from_value(frame) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = send(
                            &output,
                            &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Malformed request"}}),
                        );
                        continue;
                    }
                };
                let id = request.id;
                let control_method = request.method.ends_with(".cancel")
                    || request.method.ends_with(".status")
                    || request.method.ends_with(".acknowledge")
                    || request.method == "settings.test.discard"
                    || request.method == "settings.cancelTest"
                    || request.method == "initialize"
                    || request.method == "lifecycle.activate"
                    || request.method == "lifecycle.quiesce"
                    || request.method == "control.operationIdle"
                    || request.method == "control.discardOperation";
                let permit = match if control_method {
                    control.clone()
                } else {
                    normal.clone()
                }
                .try_acquire_owned()
                {
                    Ok(p) => p,
                    Err(_) => {
                        let _ = send(
                            &output,
                            &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Image service request capacity reached"}}),
                        );
                        continue;
                    }
                };
                if !active.lock().unwrap().insert(id) {
                    let _ = send(
                        &output,
                        &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"Duplicate request ID"}}),
                    );
                    continue;
                }
                let initialized = initialized.clone();
                let control_token = control_token.clone();
                let validation_only = validation_only.clone();
                let service = service.clone();
                let output = output.clone();
                let active = active.clone();
                let normal_handlers = normal.clone();
                let control_handlers = control.clone();
                handle.spawn_blocking(move || {
                    let _permit = permit;
                    let response = match execute(&service, &initialized, &control_token, &validation_only, &normal_handlers, &control_handlers, request) {
                        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                        Err(failure) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":failure.message,"data":failure}}),
                    };
                    let _ = send(&output, &response);
                    active.lock().unwrap().remove(&id);
                });
            }
            service.shutdown();
            te_plugin_runtime::disconnected();
        }
    });
    tokio::task::spawn_blocking(move || reader.join())
        .await
        .ok();
    std::process::exit(0)
}
