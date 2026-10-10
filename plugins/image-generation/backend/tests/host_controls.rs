//! Actual stdio authentication/lifecycle checks for private native host controls.
use image_generation_backend::{domain, journal::Journal};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use te_image_generation_contract::*;
struct Provider {
    child: std::process::Child,
    input: std::process::ChildStdin,
    frames: mpsc::Receiver<Value>,
    sequence: u64,
    events: Vec<Value>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Provider {
    fn new(path: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_image-generation-backend"))
            .args(["--data-dir", path.to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            frames,
            sequence: 0,
            events: vec![],
        }
    }
    fn response(&mut self, method: &str, params: Value) -> Value {
        self.sequence += 1;
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","id":self.sequence,"method":method,"params":params})
        )
        .unwrap();
        self.input.flush().unwrap();
        loop {
            let frame = self
                .frames
                .recv_timeout(Duration::from_secs(3))
                .expect("Native control reply timed out");
            if frame["method"] == "event" {
                self.events.push(frame);
                continue;
            }
            assert!(
                frame.get("method").is_none(),
                "Control attempted reverse IO: {frame}"
            );
            assert_eq!(frame["id"], self.sequence);
            return frame;
        }
    }
    fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.response(method, params);
        assert!(response.get("error").is_none(), "{response}");
        response["result"].clone()
    }
    fn initialize(&mut self, readonly: bool) -> Value {
        self.response("initialize",json!({"protocolVersion":1,"validationOnly":readonly,"deferRecovery":true,"processService":true,"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1},"hostControl":{"token":"a".repeat(64)}}))
    }
}
fn control() -> Value {
    json!({"controlToken":"a".repeat(64),"consumerPackage":"test.consumer","operationId":"receipt"})
}
#[test]
fn native_control_requires_immutable_handshake_token_active_lifecycle_and_bounded_shape() {
    let dir = tempfile::tempdir().unwrap();
    let mut provider = Provider::new(dir.path());
    assert!(provider
        .response("control.operationIdle", control())
        .get("error")
        .is_some());
    assert!(provider.initialize(false).get("error").is_none());
    assert!(provider
        .response("control.operationIdle", control())
        .get("error")
        .is_some());
    provider.ok("lifecycle.activate", json!({}));
    for method in ["control.operationIdle", "control.discardOperation"] {
        for params in [
            json!({"consumerPackage":"test.consumer","operationId":"receipt"}),
            json!({"controlToken":"b".repeat(64),"consumerPackage":"test.consumer","operationId":"receipt"}),
            json!({"controlToken":"a".repeat(64),"consumerPackage":"test.consumer","operationId":"receipt","extra":true}),
            json!({"controlToken":"a".repeat(64),"consumerPackage":"test.consumer","operationId":"x".repeat(129)}),
        ] {
            assert!(provider.response(method, params).get("error").is_some());
        }
    }
    assert_eq!(
        provider.ok("control.operationIdle", control()),
        json!({"idle":true})
    );
    assert_eq!(
        provider.response("control.discardOperation", control())["error"]["data"]["code"],
        "not_found"
    );
    assert!(provider.initialize(true).get("error").is_some());
    provider.ok("lifecycle.quiesce", json!({}));
    assert!(provider
        .response("control.operationIdle", control())
        .get("error")
        .is_some());
    provider.ok("lifecycle.activate", json!({}));
    assert_eq!(
        provider.ok("control.operationIdle", control())["idle"],
        true
    );
    assert!(provider.events.is_empty());
}
#[test]
fn read_only_preflight_cannot_activate_or_mutate_native_controls_and_never_creates_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("absent");
    let mut provider = Provider::new(&path);
    assert!(provider.initialize(true).get("error").is_none());
    assert_eq!(
        provider.response("lifecycle.activate", json!({}))["error"]["data"]["code"],
        "permission_denied"
    );
    assert!(provider
        .response("control.operationIdle", control())
        .get("error")
        .is_some());
    assert!(provider
        .response("control.discardOperation", control())
        .get("error")
        .is_some());
    assert!(provider.initialize(false).get("error").is_some());
    assert!(!path.exists());
    assert!(provider.events.is_empty());
}
#[test]
fn native_unavailable_output_discard_returns_canonical_durable_receipt_without_reverse_io() {
    let dir = tempfile::tempdir().unwrap();
    let profile = domain::Profile::Http {
        id: "http".into(),
        name: "Fixture".into(),
        recipe_revision: "revision".into(),
        base_url: "https://unused.test/images".into(),
        default_model: "fixture".into(),
        allow_insecure_http: false,
        credential: domain::Credential::None,
    };
    let recipe = domain::recipe(
        &profile,
        &PrepareRequest {
            operation_id: "receipt".into(),
            connection_id: "http".into(),
            expected_connection_revision: "revision".into(),
            model: Some("fixture".into()),
            prompt: "Fixture".into(),
            inputs: vec![],
            options: ImageOptions {
                size: "auto".into(),
                resolution: None,
                aspect_ratio: None,
                quality: "auto".into(),
                background: "auto".into(),
            },
        },
    )
    .unwrap();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    let caller = Caller {
        package_id: "test.consumer".into(),
        package_digest: "b".repeat(64),
        incarnation: 1,
    };
    journal
        .accept(&caller, "receipt", &"c".repeat(64), &recipe, false)
        .unwrap();
    journal.claim(&caller.package_id, "receipt").unwrap();
    let metadata = ImageMetadata {
        adapter: recipe.adapter.clone(),
        endpoint_identity: recipe.endpoint_identity.clone(),
        requested_model: recipe.model.clone(),
        actual_model: None,
        external_request_id: None,
        thread_id: None,
        options: recipe.options.clone(),
        remote_charge_uncertain: false,
    };
    journal
        .finish(
            &caller.package_id,
            "receipt",
            Execution::Succeeded { metadata },
            Delivery::Unavailable {
                reason: "storage_unavailable".into(),
            },
            Some(&"d".repeat(64)),
        )
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    let mut provider = Provider::new(dir.path());
    assert!(provider.initialize(false).get("error").is_none());
    provider.ok("lifecycle.activate", json!({}));
    let discarded = provider.ok("control.discardOperation", control());
    assert_eq!(discarded["execution"]["state"], "succeeded");
    assert_eq!(discarded["delivery"]["state"], "discarded");
    assert_eq!(
        provider.ok("control.discardOperation", control()),
        discarded
    );
    assert_eq!(
        provider.events.last().unwrap()["params"]["payload"]["status"],
        discarded
    );
    let db = rusqlite::Connection::open(dir.path().join("operations.sqlite")).unwrap();
    let stored: String = db
        .query_row("SELECT status FROM operations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), discarded);
}
