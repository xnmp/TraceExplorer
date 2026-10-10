//! All host calls use the shared connection allocator. Tests inject one host.
use crate::error::{error, Result};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
pub trait Host: Send + Sync {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value>;
    fn event(&self, name: &str, payload: Value) -> Result<()>;
    /// Bytes of stdin `host.process.run` accepts, or `None` when the host
    /// predates stdin. Learned from initialization, never from a version.
    fn process_stdin_bound(&self) -> Option<usize> {
        None
    }
}
/// The connection's `processStdin` bound; zero until a host advertises one.
static PROCESS_STDIN: AtomicUsize = AtomicUsize::new(0);
/// Record the host's process capabilities from `initialize` params.
pub fn initialize(params: &Value) {
    PROCESS_STDIN.store(
        te_plugin_runtime::process::stdin_bound(params).unwrap_or(0),
        Ordering::Release,
    );
}
pub struct NativeHost;
impl Host for NativeHost {
    fn process_stdin_bound(&self) -> Option<usize> {
        Some(PROCESS_STDIN.load(Ordering::Acquire)).filter(|bytes| *bytes > 0)
    }
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
