//! Trace facade over the package-independent connection-wide host client.
use crate::AppError;
use serde_json::Value;
use std::time::Instant;
pub use te_plugin_runtime::HostRpcClient;
pub fn configure(send: impl Fn(Value) -> Result<(), AppError> + Send + Sync + 'static) {
    te_plugin_runtime::configure(move |frame| {
        send(frame).map_err(|error| te_plugin_runtime::Error::Other(error.to_string()))
    });
}
pub fn deliver(frame: &Value) -> bool {
    te_plugin_runtime::deliver(frame)
}
pub fn disconnected() {
    te_plugin_runtime::disconnected();
}
pub(crate) fn invoke(
    method: &str,
    params: Value,
    cancelled: &impl Fn() -> bool,
    deadline: Option<Instant>,
    cancel: Option<(&str, Value)>,
) -> Result<Value, AppError> {
    te_plugin_runtime::invoke(method, params, cancelled, deadline, cancel).map_err(|error| {
        match error {
            te_plugin_runtime::Error::Remote { code, message } => {
                AppError::Service { code, message }
            }
            other => AppError::Other(other.to_string()),
        }
    })
}
pub(crate) fn notify(method: &str, params: Value) -> Result<(), AppError> {
    te_plugin_runtime::notify(method, params).map_err(|error| AppError::Other(error.to_string()))
}
