//! Versioned host text facade; image connection settings never enter this API.
use crate::{error::AppError, host_rpc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
static ENABLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Context {
    pub profile_id: String,
    pub configuration_revision: u64,
    pub fingerprint: String,
    pub transport: String,
    pub requested_model: String,
    pub actual_model: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Description {
    pub version: u32,
    pub enabled: bool,
    pub available: bool,
    pub configuration_revision: u64,
    pub context: Option<Context>,
}
#[derive(Deserialize)]
pub(crate) struct ResultText {
    pub text: String,
    pub context: Context,
}

pub(crate) fn enable(capability: &Value) {
    ENABLED.store(capability["version"] == 1, Ordering::Release);
}
pub(crate) fn describe() -> Result<Description, AppError> {
    if !ENABLED.load(Ordering::Acquire) {
        return Ok(Description {
            version: 1,
            enabled: false,
            available: false,
            configuration_revision: 0,
            context: None,
        });
    }
    let result = host_rpc::invoke(
        "host.text.describe",
        json!({}),
        &|| false,
        Some(Instant::now() + Duration::from_secs(5)),
        None,
    )?;
    let description: Description = serde_json::from_value(result)
        .map_err(|_| AppError::Other("Invalid host text configuration".into()))?;
    if description.version != 1
        || description.context.as_ref().is_some_and(|context| {
            context.configuration_revision != description.configuration_revision
                || context.fingerprint.len() != 64
        })
    {
        return Err(AppError::Other(
            "Incompatible host text configuration".into(),
        ));
    }
    Ok(description)
}

pub(crate) fn validate_request_id(id: &str) -> Result<(), AppError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err(AppError::Other("Invalid prompt title request ID".into()));
    }
    Ok(())
}
pub(crate) fn generate(
    request_id: &str,
    instructions: &str,
    input: &str,
    context: &Context,
    cancelled: &impl Fn() -> bool,
    deadline: Instant,
) -> Result<ResultText, AppError> {
    let request = json!({"requestId":request_id,"instructions":instructions,"input":input,"maxOutputTokens":64,"timeoutMs":45000,"expectedConfigurationRevision":context.configuration_revision});
    let result = host_rpc::invoke(
        "host.text.generate",
        request,
        cancelled,
        Some(deadline),
        Some(("host.text.cancel", json!({"requestId":request_id}))),
    )?;
    let result: ResultText = serde_json::from_value(result)
        .map_err(|_| AppError::Other("Invalid host text result".into()))?;
    if result.context.configuration_revision != context.configuration_revision
        || result.context.fingerprint != context.fingerprint
        || result.context.profile_id != context.profile_id
        || result.context.requested_model != context.requested_model
        || result.context.transport != context.transport
    {
        return Err(AppError::Other(
            "Language model configuration changed".into(),
        ));
    }
    Ok(result)
}
pub(crate) fn cancel(request_id: &str) -> Result<Value, AppError> {
    validate_request_id(request_id)?;
    if !ENABLED.load(Ordering::Acquire) {
        return Ok(json!({"cancelled":false}));
    }
    host_rpc::invoke(
        "host.text.cancel",
        json!({"requestId":request_id}),
        &|| false,
        Some(Instant::now() + Duration::from_secs(2)),
        None,
    )
}
