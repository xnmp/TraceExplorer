//! Behavior tests against the actual headless executable and persisted store.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Backend {
    child: Child,
    replies: mpsc::Receiver<Value>,
    sequence: u64,
    events: Vec<Value>,
}

impl Backend {
    fn start(data: &std::path::Path) -> Self {
        Self::start_with_env(data, &[])
    }
    fn start_with_env(data: &std::path::Path, environment: &[(&str, &std::path::Path)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_trace-explorer-backend"))
            .args(["--data-dir", data.to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .envs(environment.iter().map(|(key, value)| (key, value)))
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(value) = serde_json::from_str(&line) {
                    if sender.send(value).is_err() {
                        break;
                    }
                }
            }
        });
        Self {
            child,
            replies,
            sequence: 0,
            events: Vec::new(),
        }
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.sequence += 1;
        let frame = json!({"jsonrpc":"2.0", "id":self.sequence, "method":method, "params":params});
        writeln!(self.child.stdin.as_mut().unwrap(), "{frame}").unwrap();
        loop {
            let reply = self
                .replies
                .recv_timeout(Duration::from_secs(5))
                .expect("Backend did not reply");
            if reply.get("id") == Some(&json!(self.sequence)) {
                return reply;
            }
            self.events.push(reply);
        }
    }
    fn event(&mut self, name: &str) -> Value {
        loop {
            if let Some(index) = self
                .events
                .iter()
                .position(|event| event["params"]["name"] == name)
            {
                return self.events.remove(index)["params"]["payload"].clone();
            }
            self.events.push(
                self.replies
                    .recv_timeout(Duration::from_secs(5))
                    .expect("Backend did not emit outcome"),
            );
        }
    }
    fn ready(&mut self, active: Vec<i64>) {
        let response = self.call(
            "initialize",
            json!({"protocolVersion":1,"activeRunIds":active}),
        );
        assert_eq!(response["result"]["protocolVersion"], 1, "{response}");
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(unix)]
#[test]
fn generation_uses_managed_temporary_storage_and_survives_restart() {
    use std::os::unix::fs::PermissionsExt;
    let data = tempfile::tempdir().unwrap();
    let provider = tempfile::tempdir().unwrap();
    let source = data.path().join("portrait.png");
    let png = include_bytes!("../test_support/fixtures/source32.png");
    std::fs::write(&source, png).unwrap();
    let thread = "01234567-89ab-7cde-8f01-23456789abcd";
    let output = provider.path().join("generated_images").join(thread);
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("result.png"), png).unwrap();
    let executable = provider.path().join("codex");
    std::fs::write(&executable, format!("#!/bin/sh\nif [ \"$1\" = login ]; then printf 'Logged in using ChatGPT\\n'; exit 0; fi\nprintf x >> \"$CODEX_HOME/provider-calls\"\nprintf '%s\\n' '{{\"type\":\"thread.started\",\"thread_id\":\"{thread}\"}}' '{{\"type\":\"turn.completed\"}}'\n")).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let missing_directory = data.path().join("not-created-by-generation");
    let mut backend = Backend::start_with_env(data.path(), &[("CODEX_HOME", provider.path())]);
    backend.ready(vec![]);
    let operation_id = "0123456789abcdef0123456789abcdef";
    let start = json!({"kind":"openai-image","operationId":operation_id,"jobId":777,"request":{
        "backend":"codex", "codexPath":executable, "sourcePath":source, "referencePaths":[],
        "prompt":"Make the background blue", "outputDir":missing_directory, "outputFilename":"ignored.png",
        "model":"gpt-image-2", "size":"auto", "quality":"auto", "background":"auto"
    }, "apiKey":""});
    let mut unowned = start.clone();
    unowned.as_object_mut().unwrap().remove("operationId");
    assert!(backend.call("jobs.start", unowned).get("error").is_some());
    let mut unowned = start.clone();
    unowned.as_object_mut().unwrap().remove("jobId");
    assert!(backend.call("jobs.start", unowned).get("error").is_some());
    assert!(backend
        .call("start_openai_image_job", start.clone())
        .get("error")
        .is_some());
    let reply = backend.call("jobs.start", start.clone());
    assert_eq!(reply["result"], 777, "{reply}");
    let mut retry = start.clone();
    retry["jobId"] = json!(888);
    assert_eq!(backend.call("jobs.start", retry.clone())["result"], 777);
    let complete = backend.event("openai-image-complete");
    assert_eq!(complete["jobId"], 777);
    assert_eq!(
        std::fs::read(provider.path().join("provider-calls")).unwrap(),
        b"x"
    );
    let saved = std::path::PathBuf::from(complete["outputPath"].as_str().unwrap());
    assert!(saved.starts_with(data.path().join("generated")));
    assert_eq!(saved.file_name().unwrap(), "portrait_edit.png");
    assert_eq!(std::fs::read(&saved).unwrap(), png);
    assert!(!missing_directory.exists());
    let graph = backend.call("trace_for_image", json!({"path":saved}))["result"].clone();
    assert!(graph["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|artifact| artifact["temporary"] == true));
    drop(backend);
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    let status = backend.call("jobs.status", json!({"operationId":operation_id}))["result"].clone();
    assert_eq!(status["jobId"], 777);
    assert_eq!(status["status"], "succeeded");
    assert_eq!(status["outputPath"], saved.to_str().unwrap());
    assert_eq!(backend.call("jobs.start", retry.clone())["result"], 777);
    assert_eq!(
        std::fs::read(provider.path().join("provider-calls")).unwrap(),
        b"x"
    );
    retry["request"]["prompt"] = json!("A different edit");
    assert!(backend.call("jobs.start", retry).get("error").is_some());
    assert_eq!(
        std::fs::read(provider.path().join("provider-calls")).unwrap(),
        b"x"
    );
    assert_eq!(std::fs::read(&saved).unwrap(), png);
    assert_eq!(
        backend.call("trace_for_image", json!({"path":saved}))["result"],
        graph
    );
    let id = graph["currentArtifactId"].clone();
    let permanent = data.path().join("portrait_edit.png");
    let result = backend.call(
        "save_generated_image",
        json!({"artifactId":id,"target":permanent}),
    );
    assert_eq!(
        result["result"]["path"],
        permanent.to_str().unwrap(),
        "{result}"
    );
    assert_eq!(std::fs::read(&permanent).unwrap(), png);
    let final_graph = backend.call("trace_for_image", json!({"path":permanent}))["result"].clone();
    assert_eq!(final_graph["currentArtifactId"], id);
    assert_eq!(
        final_graph["artifacts"].as_array().unwrap().len(),
        graph["artifacts"].as_array().unwrap().len()
    );
    assert!(!final_graph["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|artifact| artifact["temporary"] == true));
    drop(backend);
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    assert_eq!(
        backend.call("trace_for_image", json!({"path":permanent}))["result"],
        final_graph
    );
}

#[test]
fn native_plugin_persists_published_lineage_across_restart_without_host_code() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.png");
    let target = directory.path().join("result.png");
    let payload = directory.path().join(".tauri-explorer-stage-rpc/payload");
    let anchor = payload.with_file_name("trace-anchor");
    let png = include_bytes!("../test_support/fixtures/source32.png");
    std::fs::write(&source, png).unwrap();
    let digest = hex::encode(Sha256::digest(png));
    let mut backend = Backend::start(directory.path());
    assert!(backend
        .call("trace_for_image", json!({"path":source}))
        .get("error")
        .is_some());
    backend.ready(vec![]);
    let reply = backend.call("provenance.begin", json!({"start":{
        "operation":"image.crop", "parameters":{"rect":{"left":0,"top":0,"right":32,"bottom":32}},
        "inputs":[{"path":source,"digest":digest}]
    }}));
    let run = reply["result"].clone();
    assert_eq!(
        run.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
        vec!["id"]
    );
    std::fs::create_dir(payload.parent().unwrap()).unwrap();
    std::fs::write(&payload, png).unwrap();
    std::fs::hard_link(&payload, &anchor).unwrap();
    assert_eq!(
        backend.call(
            "provenance.prepare",
            json!({"run":run,"target":target,"digest":digest,"staged":anchor})
        )["result"],
        Value::Null
    );
    std::fs::hard_link(&payload, &target).unwrap();
    assert_eq!(
        backend.call("provenance.complete", json!({"run":run,"path":target}))["result"],
        Value::Null
    );
    let graph = backend.call("trace_for_image", json!({"path":target}))["result"].clone();
    assert_eq!(graph["artifacts"].as_array().unwrap().len(), 2);
    assert_eq!(graph["runs"][0]["status"], "succeeded");
    drop(backend);
    let mut backend = Backend::start(directory.path());
    backend.ready(vec![]);
    assert_eq!(
        backend.call("trace_for_image", json!({"path":target}))["result"],
        graph
    );
    let forbidden = directory.path().join("other.sqlite");
    assert!(backend
        .call(
            "provenance.fail",
            json!({"run":{"id":run["id"],"database":forbidden},"reason":"bad"})
        )
        .get("error")
        .is_some());
    assert!(!forbidden.exists());
    assert!(backend
        .call("provenance.cancel", json!({"run":{"id":-1}}))
        .get("error")
        .is_some());
}

#[test]
fn restarting_backend_preserves_a_live_host_publisher_lease() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.png");
    std::fs::write(&source, b"source").unwrap();
    let mut backend = Backend::start(directory.path());
    backend.ready(vec![]);
    let start = json!({"start":{"operation":"image.crop","parameters":{},"inputs":[{"path":source,"digest":hex::encode(Sha256::digest(b"source"))}]}});
    let live = backend.call("provenance.begin", start.clone())["result"].clone();
    let abandoned = backend.call("provenance.begin", start)["result"].clone();
    drop(backend);
    let mut backend = Backend::start(directory.path());
    backend.ready(vec![live["id"].as_i64().unwrap()]);
    let graph = backend.call("trace_for_image", json!({"path":source}))["result"].clone();
    let runs = graph["runs"].as_array().unwrap();
    assert_eq!(
        runs.iter().find(|run| run["id"] == live["id"]).unwrap()["status"],
        "running"
    );
    assert_eq!(
        runs.iter()
            .find(|run| run["id"] == abandoned["id"])
            .unwrap()["status"],
        "interrupted"
    );
    assert_eq!(
        backend.call("provenance.cancel", json!({"run":live}))["result"],
        Value::Null
    );
}

#[test]
fn upgrade_preflight_retains_publication_proof_until_commit_or_rollback() {
    for rollback in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.png");
        let target = directory.path().join("result.png");
        let payload = directory
            .path()
            .join(".tauri-explorer-stage-upgrade/payload");
        let anchor = payload.with_file_name("trace-anchor");
        let png = include_bytes!("../test_support/fixtures/source32.png");
        std::fs::write(&source, png).unwrap();
        let digest = hex::encode(Sha256::digest(png));
        let mut backend = Backend::start(directory.path());
        backend.ready(vec![]);
        let run=backend.call("provenance.begin",json!({"start":{"operation":"image.crop","parameters":{},"inputs":[{"path":source,"digest":digest}]}}))["result"].clone();
        std::fs::create_dir(payload.parent().unwrap()).unwrap();
        std::fs::write(&payload, png).unwrap();
        std::fs::hard_link(&payload, &anchor).unwrap();
        assert_eq!(
            backend.call(
                "provenance.prepare",
                json!({"run":run,"target":target,"digest":digest,"staged":anchor})
            )["result"],
            Value::Null
        );
        std::fs::hard_link(&payload, &target).unwrap();
        drop(backend);
        let database = directory.path().join("trace.sqlite");
        let snapshot = std::fs::read(&database).unwrap();
        let mut candidate = Backend::start(directory.path());
        let reply = candidate.call(
            "initialize",
            json!({"protocolVersion":1,"activeRunIds":[],"deferRecovery":true}),
        );
        assert_eq!(reply["result"]["ready"], false, "{reply}");
        assert!(anchor.exists());
        assert!(candidate
            .call("trace_for_image", json!({"path":target}))
            .get("error")
            .is_some());
        if rollback {
            drop(candidate);
            std::fs::write(&database, snapshot).unwrap();
            candidate = Backend::start(directory.path());
            candidate.ready(vec![]);
        } else {
            assert_eq!(
                candidate.call("lifecycle.activate", json!({}))["result"],
                Value::Null
            );
            assert_eq!(
                candidate.call("lifecycle.activate", json!({}))["result"],
                Value::Null
            );
        }
        let graph = candidate.call("trace_for_image", json!({"path":target}))["result"].clone();
        assert_eq!(graph["artifacts"].as_array().unwrap().len(), 2, "{graph}");
        assert_eq!(graph["runs"][0]["status"], "succeeded");
        assert!(!anchor.exists());
        assert_eq!(std::fs::read(target).unwrap(), png);
    }
}
