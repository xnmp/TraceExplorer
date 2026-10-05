//! Structured events supplied by the process transport, not an app handle.
use crate::error::AppError;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

type EventSink = dyn Fn(&str, Value) -> Result<(), AppError> + Send + Sync;

#[derive(Clone)]
pub struct EventEmitter(Arc<EventSink>);

impl EventEmitter {
    pub fn new(sink: impl Fn(&str, Value) -> Result<(), AppError> + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }
    pub(crate) fn emit(&self, name: &str, payload: impl Serialize) -> Result<(), AppError> {
        let payload =
            serde_json::to_value(payload).map_err(|error| AppError::Other(error.to_string()))?;
        (self.0)(name, payload)
    }
}
