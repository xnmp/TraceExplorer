//! All host calls use the shared connection allocator. Tests inject one host.
use crate::error::{error, Result};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};
pub trait Host: Send + Sync {
    fn receipt_billing_v1(&self) -> bool {
        false
    }
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value>;
    fn event(&self, name: &str, payload: Value) -> Result<()>;
    /// Bytes of stdin `host.process.run` accepts, or `None` when the host
    /// predates stdin. Learned from initialization, never from a version.
    fn process_stdin_bound(&self) -> Option<usize> {
        None
    }
    /// Whether `host.process.run` takes explicit operation custody
    /// (`processCustody`). Learned from initialization, never from a version.
    fn process_custody(&self) -> bool {
        false
    }
    /// Frees a finished `host.process.run` result's output files. The host
    /// never answers `host.process.release`, so it is a notification: a call
    /// would wait for its deadline. Hosts that run no processes need nothing.
    fn release_process(&self, _handle: &Value) {}
}
/// Optional receipt extension; false until the host explicitly advertises it.
static RECEIPT_BILLING: AtomicBool = AtomicBool::new(false);
/// The connection's `processStdin` bound; zero until a host advertises one.
static PROCESS_STDIN: AtomicUsize = AtomicUsize::new(0);
/// Whether the connection's host advertised `processCustody`.
static PROCESS_CUSTODY: AtomicBool = AtomicBool::new(false);
/// Record optional host capabilities from `initialize` params.
pub fn initialize(params: &Value) {
    RECEIPT_BILLING.store(
        params["serviceService"]["receiptBillingV1"] == true,
        Ordering::Release,
    );
    PROCESS_STDIN.store(
        te_plugin_runtime::process::stdin_bound(params).unwrap_or(0),
        Ordering::Release,
    );
    PROCESS_CUSTODY.store(
        te_plugin_runtime::process::custody_supported(params),
        Ordering::Release,
    );
}
pub struct NativeHost;
impl Host for NativeHost {
    fn receipt_billing_v1(&self) -> bool {
        RECEIPT_BILLING.load(Ordering::Acquire)
    }
    fn process_stdin_bound(&self) -> Option<usize> {
        Some(PROCESS_STDIN.load(Ordering::Acquire)).filter(|bytes| *bytes > 0)
    }
    fn process_custody(&self) -> bool {
        PROCESS_CUSTODY.load(Ordering::Acquire)
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
    fn release_process(&self, handle: &Value) {
        let _ =
            te_plugin_runtime::notify("host.process.release", serde_json::json!({"handle":handle}));
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        te_plugin_runtime::notify("event", serde_json::json!({"name":name,"payload":payload}))
            .map_err(|_| error("host_unavailable", "Could not publish image service event"))
    }
}

/// All provider wire receipts pass through this boundary, including settings,
/// recovered events, and host-owned tests. No capability means no billing key.
pub fn wire_value(mut value: Value, billing_v1: bool) -> Value {
    fn gate(value: &mut Value, enabled: bool) {
        match value {
            Value::Object(fields) => {
                if fields.get("version") == Some(&serde_json::json!(1))
                    && fields.contains_key("requestFingerprint")
                    && fields.contains_key("execution")
                {
                    let valid = fields.get("billing").is_none_or(|b| {
                        serde_json::from_value::<te_image_generation_contract::Billing>(b.clone())
                            .is_ok()
                    });
                    if !enabled || !valid {
                        fields.remove("billing");
                    }
                }
                for value in fields.values_mut() {
                    gate(value, enabled);
                }
            }
            Value::Array(values) => {
                for value in values {
                    gate(value, enabled);
                }
            }
            _ => {}
        }
    }
    gate(&mut value, billing_v1);
    value
}

#[cfg(test)]
mod billing_capability_tests {
    use super::*;
    #[test]
    fn receipt_billing_requires_an_explicit_boolean_host_capability() {
        for (params, enabled) in [
            (serde_json::json!({"serviceService":{"version":1}}), false),
            (
                serde_json::json!({"serviceService":{"version":1,"receiptBillingV1":true}}),
                true,
            ),
            (
                serde_json::json!({"serviceService":{"version":99,"receiptBillingV1":"true"}}),
                false,
            ),
            (
                serde_json::json!({"serviceService":{"version":99,"receiptBillingV1":true}}),
                true,
            ),
            (serde_json::json!({}), false),
        ] {
            initialize(&params);
            assert_eq!(NativeHost.receipt_billing_v1(), enabled);
        }
    }
}
