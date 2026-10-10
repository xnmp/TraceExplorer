//! Actual subprocess contract: reverse replies/control stay live under saturation.
use image_generation_backend::{
    domain::{Configuration, Credential, Profile},
    error::{error, Result},
    host::Host,
    service::Service,
};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
struct NoHost;
impl Host for NoHost {
    fn call(&self, _: &str, _: Value, _: &AtomicBool) -> Result<Value> {
        Err(error("unexpected", "Preflight attempted reverse IO"))
    }
    fn event(&self, _: &str, _: Value) -> Result<()> {
        Ok(())
    }
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[tokio::test]
async fn real_stdio_keeps_cancellation_and_reverse_replies_live_with_full_ordinary_pool() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), Arc::new(NoHost)).unwrap();
    service.activate().unwrap();
    service
        .profiles
        .save(
            Configuration {
                schema_version: 1,
                document_revision: 0,
                default_connection_id: Some("fixture".into()),
                profiles: vec![Profile::Http {
                    id: "fixture".into(),
                    name: "Fixture".into(),
                    recipe_revision: "".into(),
                    base_url: "https://unused.test/v1/images".into(),
                    default_model: "fixture-model".into(),
                    allow_insecure_http: false,
                    credential: Credential::Secret {
                        id: "fixture-secret-reference".into(),
                    },
                }],
            },
            0,
            Some(("fixture", "fixture-secret-reference")),
            None,
        )
        .unwrap();
    drop(service);
    let mut child = Child(
        Command::new(env!("CARGO_BIN_EXE_image-generation-backend"))
            .args(["--data-dir", directory.path().to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if let Ok(line) = line {
                let frame: Value = serde_json::from_str(&line).unwrap();
                if tx.send(frame).is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });
    let write = |stdin: &mut std::process::ChildStdin, value: Value| {
        writeln!(stdin, "{value}").unwrap();
        stdin.flush().unwrap();
    };
    let receive = || {
        rx.recv_timeout(Duration::from_secs(5))
            .expect("Backend frame timed out")
    };
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"deferRecovery":true,"hostControl":{"token":"b".repeat(64)},"processService":true,"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1}}}),
    );
    let init = receive();
    assert_eq!(init["id"], 1);
    assert_eq!(init["result"]["ready"], false);
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"lifecycle.activate","params":{}}),
    );
    let ready = receive();
    assert_eq!(ready["id"], 2);
    assert_eq!(ready["result"]["ready"], true);
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"migration.status","params":{"sourceId":"trace-openai-image-v1"}}),
    );
    assert_eq!(receive()["error"]["data"]["code"], "permission_denied");
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":4,"method":"migration.status","params":{"sourceId":"trace-openai-image-v1","controlToken":"b".repeat(64)}}),
    );
    assert_eq!(receive()["result"]["state"], "absent");
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":5,"method":"initialize","params":{"protocolVersion":1,"processService":true,"hostControl":{"token":"c".repeat(64)},"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1}}}),
    );
    assert_eq!(receive()["error"]["data"]["code"], "permission_denied");
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":6,"method":"migration.status","params":{"sourceId":"trace-openai-image-v1","controlToken":"b".repeat(64)}}),
    );
    assert_eq!(receive()["result"]["state"], "absent");
    for id in 100..132 {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"settings.check","params":{"profileId":"fixture"}}),
        );
    }
    let mut reverse = vec![];
    let mut replies = vec![];
    while reverse.len() < 28 {
        let frame = receive();
        if frame["method"] == "host.credentials.get" {
            reverse.push(frame["id"].clone())
        } else {
            replies.push(frame)
        }
    }
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":999,"method":"settings.cancelTest","params":{"requestId":"12345678-1234-1234-1234-123456789abc"}}),
    );
    loop {
        let frame = receive();
        if frame["id"] == 999 {
            assert_eq!(frame["error"]["data"]["code"], "not_found");
            break;
        }
        replies.push(frame)
    }
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":998,"method":"lifecycle.quiesce","params":{}}),
    );
    loop {
        let frame = receive();
        if frame["id"] == 998 {
            assert_eq!(frame["error"]["data"]["code"], "busy");
            break;
        }
        replies.push(frame);
    }
    for id in reverse.into_iter().rev() {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"result":{"key":"fixture-key-kept-native"}}),
        );
    }
    while replies.len() < 32 {
        replies.push(receive())
    }
    assert_eq!(
        replies
            .iter()
            .filter(|r| r["result"]["available"] == true)
            .count(),
        28
    );
    assert!(replies
        .iter()
        .all(|r| !r.to_string().contains("fixture-key-kept-native")));
    let mut quiesced = false;
    for id in 2000..2100 {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"lifecycle.quiesce","params":{}}),
        );
        let response = receive();
        if response["result"] == json!({"ready":false,"idle":true,"checkpoint":true}) {
            quiesced = true;
            break;
        }
        assert_eq!(response["error"]["data"]["code"], "busy");
    }
    assert!(quiesced);
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2101,"method":"settings.read","params":{}}),
    );
    assert_eq!(receive()["error"]["data"]["code"], "unavailable");
    write(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2102,"method":"lifecycle.activate","params":{}}),
    );
    assert_eq!(receive()["result"]["ready"], true);
    drop(stdin);
    assert!(child.0.wait().unwrap().success());
    reader.join().unwrap();
}
