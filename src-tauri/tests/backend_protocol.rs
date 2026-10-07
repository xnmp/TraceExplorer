//! Behavior tests against the actual headless executable and persisted store.
#[path = "../test_support/mod.rs"]
mod test_support;
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

fn prepare_trace_store(backend: &mut Backend) {
    let run = backend.call(
        "provenance.begin",
        json!({"start":{"operation":"image.fixture","parameters":{},"inputs":[]}}),
    )["result"]
        .clone();
    assert_eq!(
        backend.call("provenance.cancel", json!({"run":run}))["result"],
        Value::Null
    );
}

fn seed_unsaved_output(
    database: &std::path::Path,
    folder: &std::path::Path,
    output: &std::path::Path,
) {
    let connection = rusqlite::Connection::open(database).unwrap();
    let parameters = json!({"output_storage":"temporary","save_directory_hint":folder,"prompt":"Folder visibility fixture"});
    connection.execute("INSERT INTO runs(operation,parameters,status) VALUES('openai.image.generate',?1,'succeeded')", [parameters.to_string()]).unwrap();
    let run = connection.last_insert_rowid();
    connection
        .execute(
            "INSERT INTO artifacts(path,digest,generating_run) VALUES(?1,?2,?3)",
            rusqlite::params![
                output.to_string_lossy(),
                hex::encode(Sha256::digest(std::fs::read(output).unwrap())),
                run
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO image_folder_contexts(folder,run_id) VALUES(?1,?2)",
            rusqlite::params![folder.to_string_lossy(), run],
        )
        .unwrap();
}

#[test]
fn folder_visibility_rechecks_removed_and_restored_unsaved_outputs() {
    let data = test_support::tempdir().unwrap();
    let folder = data.path().join("Pictures");
    let generated = data.path().join("generated");
    std::fs::create_dir(&folder).unwrap();
    std::fs::create_dir(&generated).unwrap();
    let output = generated.join("candidate.png");
    let png = include_bytes!("../test_support/fixtures/source32.png");
    std::fs::write(&output, png).unwrap();
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    prepare_trace_store(&mut backend);
    drop(backend);
    seed_unsaved_output(&data.path().join("trace.sqlite"), &folder, &output);
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    let query = json!({"directory":folder});
    assert_eq!(
        backend.call("folder_has_trace", query.clone())["result"],
        true
    );
    let modified = std::fs::metadata(&folder).unwrap().modified().unwrap();
    std::fs::remove_file(&output).unwrap();
    assert_eq!(
        std::fs::metadata(&folder).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        backend.call("folder_has_trace", query.clone())["result"],
        false
    );
    std::fs::write(&output, png).unwrap();
    assert_eq!(
        std::fs::metadata(&folder).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(backend.call("folder_has_trace", query)["result"], true);
}

#[test]
fn schema_upgrade_keeps_unsaved_folder_context_when_its_volume_is_unavailable() {
    let data = test_support::tempdir().unwrap();
    let folder = data.path().join("Pictures");
    let generated = data.path().join("generated");
    std::fs::create_dir(&folder).unwrap();
    std::fs::create_dir(&generated).unwrap();
    let output = generated.join("candidate.png");
    std::fs::write(
        &output,
        include_bytes!("../test_support/fixtures/source32.png"),
    )
    .unwrap();
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    prepare_trace_store(&mut backend);
    drop(backend);
    let database = data.path().join("trace.sqlite");
    seed_unsaved_output(&database, &folder, &output);
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("DROP TABLE image_folder_contexts; DROP TABLE image_batch_members; DROP TABLE image_prompt_titles; DROP TABLE image_discards; PRAGMA user_version=7;").unwrap();
    drop(connection);
    let offline = data.path().join("Pictures-offline");
    std::fs::rename(&folder, &offline).unwrap();
    let mut upgraded = Backend::start(data.path());
    upgraded.ready(vec![]);
    drop(upgraded);
    std::fs::rename(&offline, &folder).unwrap();
    let mut restarted = Backend::start(data.path());
    restarted.ready(vec![]);
    assert_eq!(
        restarted.call("folder_has_trace", json!({"directory":folder}))["result"],
        true
    );
    assert!(output.is_file());
}

#[cfg(unix)]
#[test]
fn schema_upgrade_resolves_an_offline_folder_alias_when_its_volume_returns() {
    use std::os::unix::fs::symlink;
    let data = test_support::tempdir().unwrap();
    let volume = data.path().join("volume");
    let folder = volume.join("Pictures");
    std::fs::create_dir_all(&folder).unwrap();
    let alias = data.path().join("PicturesAlias");
    symlink(&folder, &alias).unwrap();
    let generated = data.path().join("generated");
    std::fs::create_dir(&generated).unwrap();
    let output = generated.join("candidate.png");
    std::fs::write(
        &output,
        include_bytes!("../test_support/fixtures/source32.png"),
    )
    .unwrap();
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    prepare_trace_store(&mut backend);
    drop(backend);
    let database = data.path().join("trace.sqlite");
    seed_unsaved_output(&database, &alias, &output);
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.execute_batch("DROP TABLE image_folder_contexts; DROP TABLE image_batch_members; DROP TABLE image_prompt_titles; DROP TABLE image_discards; PRAGMA user_version=7;").unwrap();
    drop(connection);
    let offline = data.path().join("volume-offline");
    std::fs::rename(&volume, &offline).unwrap();
    let mut upgraded = Backend::start(data.path());
    upgraded.ready(vec![]);
    drop(upgraded);
    std::fs::rename(&offline, &volume).unwrap();
    let mut restarted = Backend::start(data.path());
    restarted.ready(vec![]);
    for directory in [&alias, &folder] {
        assert_eq!(
            restarted.call("folder_has_trace", json!({"directory":directory}))["result"],
            true
        );
    }
    assert!(output.is_file());
}

#[cfg(unix)]
#[test]
fn title_admission_rejects_busy_work_and_reuses_the_completed_prompt_cache() {
    use std::os::unix::fs::PermissionsExt;
    struct ReleaseOnDrop(std::path::PathBuf);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::write(&self.0, b"release");
        }
    }
    let data = test_support::tempdir().unwrap();
    let provider = test_support::tempdir().unwrap();
    let executable = provider.path().join("title-codex");
    let started = provider.path().join("started");
    let release = provider.path().join("release");
    let thread =
        json!({"type":"thread.started","thread_id":"01234567-89ab-7cde-8f01-23456789abcd"});
    let title = json!({"type":"item.completed","item":{"type":"agent_message","text":json!({"title":"Short title"}).to_string()}});
    std::fs::write(&executable,format!("#!/bin/sh\nprintf x >> \"$TRACE_TITLE_TEST_STARTED\"\nwhile [ ! -f \"$TRACE_TITLE_TEST_RELEASE\" ]; do sleep .01; done\nprintf '%s\\n' '{thread}' '{title}' '{{\"type\":\"turn.completed\"}}'\n")).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut backend = Backend::start_with_env(
        data.path(),
        &[
            ("TRACE_TITLE_TEST_STARTED", &started),
            ("TRACE_TITLE_TEST_RELEASE", &release),
        ],
    );
    let _release_on_drop = ReleaseOnDrop(release.clone());
    backend.ready(vec![]);
    let begin = json!({"start":{"operation":"openai.image.generate","parameters":{"prompt":"Same cached prompt"},"inputs":[]}});
    let first = backend.call("provenance.begin", begin.clone())["result"]["id"].clone();
    let second = backend.call("provenance.begin", begin)["result"]["id"].clone();
    backend.sequence += 1;
    let first_request = backend.sequence;
    writeln!(backend.child.stdin.as_mut().unwrap(), "{}", json!({"jsonrpc":"2.0","id":first_request,"method":"trace_prompt_title","params":{"runId":first,"codexPath":executable}})).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !started.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(started.exists(), "Title fixture did not start");
    let busy = backend.call(
        "trace_prompt_title",
        json!({"runId":second,"codexPath":executable}),
    );
    assert!(
        busy["error"]["message"].as_str().unwrap().contains("busy"),
        "{busy}"
    );
    let independent = backend.call("recent_openai_image_runs", json!({}));
    assert!(independent.get("result").is_some(), "{independent}");
    std::fs::write(&release, b"release").unwrap();
    loop {
        let reply = backend
            .replies
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        if reply["id"] == first_request {
            assert_eq!(reply["result"], "Short title", "{reply}");
            break;
        }
    }
    let cached = backend.call(
        "trace_prompt_title",
        json!({"runId":second,"codexPath":executable}),
    );
    assert_eq!(cached["result"], "Short title", "{cached}");
    assert_eq!(
        std::fs::read(started).unwrap(),
        b"x",
        "Cache retry contacted the title provider again"
    );
}

#[cfg(unix)]
#[test]
fn generation_uses_managed_temporary_storage_and_survives_restart() {
    use std::os::unix::fs::PermissionsExt;
    let data = test_support::tempdir().unwrap();
    let provider = test_support::tempdir().unwrap();
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
    let directory = test_support::tempdir().unwrap();
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
    let directory = test_support::tempdir().unwrap();
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
        let directory = test_support::tempdir().unwrap();
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
