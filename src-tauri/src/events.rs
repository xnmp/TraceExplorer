//! Structured events supplied by the process transport, not an app handle.
use crate::error::AppError;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

type EventSink = dyn Fn(&str, Value) -> Result<(), AppError> + Send + Sync;

#[derive(Clone)]
pub struct EventEmitter {sink:Arc<EventSink>, invalidate_active_profile:bool}

impl EventEmitter {
    pub fn new(sink: impl Fn(&str, Value) -> Result<(), AppError> + Send + Sync + 'static) -> Self {
        Self {sink:Arc::new(sink),invalidate_active_profile:true}
    }
    /// Fixture databases are independent of the process's active profile.
    /// Their captured events must not invalidate another fixture's paging token.
    #[cfg(test)]
    pub(crate) fn isolated(sink:impl Fn(&str,Value)->Result<(),AppError>+Send+Sync+'static)->Self {
        Self {sink:Arc::new(sink),invalidate_active_profile:false}
    }
    pub(crate) fn emit(&self, name: &str, payload: impl Serialize) -> Result<(), AppError> {
        if name == "trace:changed" && self.invalidate_active_profile {
            crate::trace::folders::invalidate();
        }
        let payload =
            serde_json::to_value(payload).map_err(|error| AppError::Other(error.to_string()))?;
        (self.sink)(name, payload)
    }
}
