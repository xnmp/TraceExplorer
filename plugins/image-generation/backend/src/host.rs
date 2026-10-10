//! All host calls use the shared connection allocator. Tests inject one host.
use crate::error::{error, Result};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
pub trait Host: Send + Sync {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value>;
    fn event(&self, name: &str, payload: Value) -> Result<()>;
}
pub struct NativeHost;
impl Host for NativeHost {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        te_plugin_runtime::invoke(
            method,
            params,
            &|| cancelled.load(Ordering::Acquire),
            Some(
                Instant::now()
                    + Duration::from_secs(if method == "host.process.run" {
                        600
                    } else {
                        30
                    }),
            ),
            if method == "host.process.run" {
                Some(("host.process.cancel", Value::Null))
            } else {
                None
            },
        )
        .map_err(|failure| match failure {
            te_plugin_runtime::Error::Remote { code, message } => error(&code, &message),
            _ => error("host_unavailable", "Host service failed or was cancelled"),
        })
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        te_plugin_runtime::notify("event", serde_json::json!({"name":name,"payload":payload}))
            .map_err(|_| error("host_unavailable", "Could not publish image service event"))
    }
}
