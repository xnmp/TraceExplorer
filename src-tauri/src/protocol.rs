//! Versioned, bounded stdio protocol. No Tauri types cross this boundary.
use crate::{error::AppError, events::EventEmitter, trace};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn field<T: serde::de::DeserializeOwned>(params: &Value, name: &str) -> Result<T, AppError> {
    serde_json::from_value(
        params
            .get(name)
            .cloned()
            .ok_or_else(|| AppError::Other(format!("Missing parameter: {name}")))?,
    )
    .map_err(|error| AppError::Other(format!("Invalid parameter {name}: {error}")))
}

/// An optional parameter; absent and `null` both mean "not given".
fn optional_field<T: serde::de::DeserializeOwned>(
    params: &Value,
    name: &str,
) -> Result<Option<T>, AppError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => field(params, name).map(Some),
    }
}

fn to_json(value: impl serde::Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|error| AppError::Other(error.to_string()))
}

fn run(params: &Value) -> Result<trace::TraceRunHandle, AppError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Run {
        id: i64,
    }
    let handle: Run = field(params, "run")?;
    trace::rpc_handle(handle.id)
}

async fn execute(app: EventEmitter, request: &Request) -> Result<Value, AppError> {
    if request.jsonrpc != "2.0" {
        return Err(AppError::Other("Unsupported RPC version".into()));
    }
    let p = &request.params;
    if request.method != "initialize"
        && request.method != "lifecycle.activate"
        && !trace::owner_ready()
    {
        return Err(AppError::Other(
            "Host initialization handshake required".into(),
        ));
    }
    match request.method.as_str() {
        "initialize" => {
            let version: u32 = field(p, "protocolVersion")?;
            if version != 1 {
                return Err(AppError::Other("Incompatible host protocol".into()));
            }
            let defer_recovery = p
                .get("deferRecovery")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            trace::initialize_owner(field(p, "activeRunIds")?, defer_recovery)?;
            crate::host_process::enable(
                p.get("processService")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
            if trace::owner_ready() {
                let _ = app.emit("trace:changed", ());
            }
            Ok(
                json!({"protocolVersion":1,"ready":trace::owner_ready(),"pluginVersion":env!("CARGO_PKG_VERSION")}),
            )
        }
        "lifecycle.activate" => {
            trace::activate_owner()?;
            let _ = app.emit("trace:changed", ());
            Ok(Value::Null)
        }
        "folder_has_trace" => Ok(json!(
            trace::folders::has_trace(field(p, "directory")?).await?
        )),
        "trace_for_job" => Ok(serde_json::to_value(
            trace::trace_for_job(field(p, "jobId")?).await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "trace_for_image" => Ok(serde_json::to_value(
            trace::trace_for_image(field(p, "path")?).await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "trace_folder_components" => to_json(
            trace::folder_graph::components(
                field(p, "directory")?,
                optional_field(p, "offset")?.unwrap_or(0),
            )
            .await?,
        ),
        "trace_folder_members" => to_json(
            trace::folder_graph::members(
                field(p, "directory")?,
                field(p, "token")?,
                optional_field(p, "offset")?.unwrap_or(0),
            )
            .await?,
        ),
        "trace_component_nodes" => to_json(
            trace::folder_graph::component_nodes(
                field(p, "directory")?,
                field(p, "token")?,
                field(p, "componentId")?,
                optional_field(p, "offset")?.unwrap_or(0),
            )
            .await?,
        ),
        "trace_run_details" => {
            to_json(trace::folder_graph::run_details(field(p, "runIds")?).await?)
        }
        "trace_revision_status" => {
            to_json(trace::folder_graph::revision_status(field(p, "artifactId")?).await?)
        }
        "image_save_suggestion" => Ok(serde_json::to_value(
            trace::save::suggestion(field(p, "artifactId")?).await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "save_generated_image" => {
            let target = p
                .get("target")
                .map(|_| field::<String>(p, "target"))
                .transpose()?;
            let path = trace::save::save(field(p, "artifactId")?, target).await?;
            let _ = app.emit("trace:changed", serde_json::json!({"path":path}));
            Ok(json!({"path":path}))
        }
        "trace_prompt_title" => Ok(json!(
            trace::titles::title(
                field(p, "runId")?,
                p.get("codexPath")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            )
            .await?
        )),
        "trace_title_connection" => {
            let executable = p
                .get("codexPath")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            Ok(json!(tokio::task::spawn_blocking(move || {
                crate::openai_image::title_connection(&executable)
            })
            .await
            .map_err(|error| AppError::WorkerFailed(error.to_string()))?))
        }
        "discard_generated_image" => {
            let view_path = trace::save::discard(field(p, "artifactId")?).await?;
            let _ = app.emit("trace:changed", ());
            Ok(json!({"viewPath":view_path}))
        }
        "openai_image_inputs" => Ok(serde_json::to_value(
            crate::openai_image::describe_inputs(field(p, "paths")?).await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "recent_openai_image_runs" => Ok(serde_json::to_value(
            trace::recent_openai_image_runs().await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "jobs.start" => {
            if field::<String>(p, "kind")? != "openai-image" {
                return Err(AppError::Other("Unsupported image job kind".into()));
            }
            Ok(json!(
                crate::openai_image::start_openai_image_job(
                    app,
                    field(p, "request")?,
                    field(p, "apiKey")?,
                    field(p, "jobId")?,
                    field(p, "operationId")?
                )
                .await?
            ))
        }
        "jobs.status" => Ok(serde_json::to_value(
            trace::jobs::status(field(p, "operationId")?).await?,
        )
        .map_err(|error| AppError::Other(error.to_string()))?),
        "provenance.begin" => Ok(
            serde_json::to_value(trace::begin_operation(field(p, "start")?)?)
                .map_err(|error| AppError::Other(error.to_string()))?,
        ),
        "provenance.prepare" => {
            let run = run(p)?;
            let target: String = field(p, "target")?;
            let digest: String = field(p, "digest")?;
            let staged: String = field(p, "staged")?;
            trace::prepare_operation_output(
                &run,
                Path::new(&target),
                &digest,
                Some(Path::new(&staged)),
            )?;
            Ok(Value::Null)
        }
        #[cfg(target_os = "linux")]
        "provenance.prepareLinked" => {
            let target: String = field(p, "target")?;
            let digest: String = field(p, "digest")?;
            let publisher: String = field(p, "publisher")?;
            trace::prepare_linked_output(
                &run(p)?,
                Path::new(&target),
                &digest,
                Path::new(&publisher),
            )?;
            Ok(Value::Null)
        }
        "provenance.complete" => {
            trace::complete_operation(&run(p)?, &field::<String>(p, "path")?)?;
            Ok(Value::Null)
        }
        "provenance.fail" => {
            trace::fail_operation(&run(p)?, &field::<String>(p, "reason")?)?;
            Ok(Value::Null)
        }
        "provenance.cancel" => {
            trace::cancel_operation(&run(p)?)?;
            Ok(Value::Null)
        }
        "provenance.details" => {
            trace::record_operation_details(&run(p)?, &field(p, "details")?)?;
            Ok(Value::Null)
        }
        "provenance.uncertain" => {
            trace::mark_operation_uncertain(&run(p)?, &field::<String>(p, "reason")?)?;
            Ok(Value::Null)
        }
        "provenance.relocate" => {
            let source: String = field(p, "source")?;
            let target: String = field(p, "target")?;
            trace::relocate_image(Path::new(&source), Path::new(&target))?;
            Ok(Value::Null)
        }
        _ => Err(AppError::Other(format!(
            "Unknown plugin method: {}",
            request.method
        ))),
    }
}

pub async fn dispatch(app: EventEmitter, request: Request) -> Value {
    let id = request.id;
    match execute(app, &request).await {
        Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
        Err(error) => {
            json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32000,"message":error.to_string(),"data":error}})
        }
    }
}
