//! Optional native image-service capability. All reverse calls share host_rpc.
use crate::{error::AppError, host_rpc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
pub(crate) const PACKAGE: &str = "xnmp.image-generation";
pub(crate) const SERVICE: &str = "image-generation";
static ENABLED: AtomicBool = AtomicBool::new(false);
pub(crate) fn enable(service: &Value, artifacts: &Value) {
    ENABLED.store(
        service["version"] == 1 && artifacts["version"] == 1,
        Ordering::Release,
    );
}
pub(crate) trait ImageHost: Send + Sync {
    fn call(
        &self,
        method: &str,
        params: Value,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, AppError>;
}
pub(crate) struct NativeHost;
impl ImageHost for NativeHost {
    fn call(
        &self,
        method: &str,
        params: Value,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Value, AppError> {
        if !ENABLED.load(Ordering::Acquire) {
            return Err(AppError::Service {
                code: "unsupported_host".into(),
                message: "Update Tauri Explorer to use shared Image Generation".into(),
            });
        }
        host_rpc::invoke(
            method,
            params,
            &|| cancelled(),
            Some(Instant::now() + Duration::from_secs(30)),
            None,
        )
    }
}
pub(crate) fn invoke(
    host: &dyn ImageHost,
    method: &str,
    params: Value,
    cancelled: &dyn Fn() -> bool,
) -> Result<Value, AppError> {
    if !matches!(
        method,
        "describe" | "prepare" | "start" | "status" | "cancel" | "acknowledge"
    ) {
        return Err(AppError::Other("Invalid image service method".into()));
    }
    host.call(
        "host.services.invoke",
        json!({"packageId":PACKAGE,"serviceId":SERVICE,"major":1,"method":method,"params":params}),
        cancelled,
    )
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Availability {
    pub version: u32,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Value>,
}
pub(crate) fn describe(host: &dyn ImageHost) -> Result<Availability, AppError> {
    let result = host.call(
        "host.services.describe",
        json!({"packageId":PACKAGE,"serviceId":SERVICE,"major":1}),
        &|| false,
    )?;
    let mut result: Availability = serde_json::from_value(result)
        .map_err(|_| AppError::Other("Invalid image service availability".into()))?;
    if result.version != 1 {
        return Err(AppError::Other("Incompatible image service".into()));
    }
    if result.available {
        let description = invoke(host, "describe", json!({}), &|| false)?;
        if description["version"] != 1 || !description["profiles"].is_array() {
            return Err(AppError::Other(
                "Invalid image connection configuration".into(),
            ));
        }
        result.description = Some(description);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::sync::Mutex<Vec<String>>, bool);
    impl ImageHost for Fixture {
        fn call(&self, method:&str, params:Value, _: &dyn Fn()->bool) -> Result<Value,AppError> {
            self.0.lock().unwrap().push(method.into());
            assert_eq!(params["packageId"],PACKAGE);
            assert_eq!(params["serviceId"],SERVICE);
            assert_eq!(params["major"],1);
            Ok(if method == "host.services.describe" {
                json!({"version":1,"available":self.1,"providerDigest":"a".repeat(64),"reason":{"code":"service_unavailable","message":"Install Image Generation"}})
            } else {
                assert_eq!(params["method"],"describe");
                json!({"version":1,"configurationRevision":1,"defaultConnectionId":null,"profiles":[]})
            })
        }
    }
    #[test]
    fn missing_provider_keeps_description_non_dispatching() {
        let fixture=Fixture(Default::default(),false);
        let availability=describe(&fixture).unwrap();
        assert!(!availability.available);assert!(availability.description.is_none());
        assert_eq!(*fixture.0.lock().unwrap(),["host.services.describe"]);
    }
    #[test]
    fn available_provider_can_be_unconfigured_without_dispatching() {
        let fixture=Fixture(Default::default(),true);
        let availability=describe(&fixture).unwrap();
        assert!(availability.available);
        assert_eq!(availability.description.unwrap()["profiles"],json!([]));
        assert_eq!(*fixture.0.lock().unwrap(),["host.services.describe","host.services.invoke"]);
    }
}
