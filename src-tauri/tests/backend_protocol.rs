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
    connection.execute_batch("DROP TABLE image_service_operations; DROP TABLE image_service_cancellations; DROP TABLE image_service_schema; PRAGMA application_id=0; DROP TABLE image_folder_contexts; DROP TABLE image_batch_members; DROP TABLE image_prompt_titles; DROP TABLE image_discards; PRAGMA user_version=7;").unwrap();
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
    connection.execute_batch("DROP TABLE image_service_operations; DROP TABLE image_service_cancellations; DROP TABLE image_service_schema; PRAGMA application_id=0; DROP TABLE image_folder_contexts; DROP TABLE image_batch_members; DROP TABLE image_prompt_titles; DROP TABLE image_discards; PRAGMA user_version=7;").unwrap();
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

#[test]
fn title_admission_rejects_busy_work_and_reuses_the_completed_prompt_cache() {
    let data = test_support::tempdir().unwrap();
    let mut backend = Backend::start(data.path());
    let initialized = backend.call(
        "initialize",
        json!({"protocolVersion":1,"activeRunIds":[],"textService":{"version":1}}),
    );
    assert!(initialized.get("error").is_none(), "{initialized}");
    let begin = json!({"start":{"operation":"openai.image.generate","parameters":{"prompt":"Same cached prompt"},"inputs":[]}});
    let first = backend.call("provenance.begin", begin.clone())["result"]["id"].clone();
    let second = backend.call("provenance.begin", begin)["result"]["id"].clone();
    let context = json!({"profileId":"fixture","configurationRevision":1,"fingerprint":"f".repeat(64),"transport":"openai-chat-completions","requestedModel":"fixture-model"});
    let description = json!({"version":1,"enabled":true,"available":true,"configurationRevision":1,"context":context});
    let respond = |backend: &mut Backend, request: &Value, result: Value| {
        writeln!(
            backend.child.stdin.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        )
        .unwrap();
    };
    backend.sequence += 1;
    let first_request = backend.sequence;
    writeln!(backend.child.stdin.as_mut().unwrap(), "{}", json!({"jsonrpc":"2.0","id":first_request,"method":"trace_prompt_title","params":{"runId":first,"requestId":"title-first","expectedConfigurationRevision":1}})).unwrap();
    let generation = loop {
        let request = backend
            .replies
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        match request["method"].as_str() {
            Some("host.text.describe") => respond(&mut backend, &request, description.clone()),
            Some("host.text.generate") => break request,
            _ => panic!("Unexpected frame before host generation: {request}"),
        }
    };
    assert_eq!(generation["params"]["input"], "Same cached prompt");
    assert_eq!(generation["params"]["requestId"], "title-first");
    assert!(generation["params"].get("codexPath").is_none());
    let busy = backend.call(
        "trace_prompt_title",
        json!({"runId":second,"requestId":"title-second","expectedConfigurationRevision":1}),
    );
    assert!(
        busy["error"]["message"].as_str().unwrap().contains("busy"),
        "{busy}"
    );
    assert!(backend
        .call("recent_openai_image_runs", json!({}))
        .get("result")
        .is_some());
    respond(
        &mut backend,
        &generation,
        json!({"text":"Short title","context":context}),
    );
    let result = backend
        .replies
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(result["id"], first_request);
    assert_eq!(result["result"]["title"], "Short title", "{result}");
    backend.sequence += 1;
    let cached_id = backend.sequence;
    writeln!(backend.child.stdin.as_mut().unwrap(), "{}", json!({"jsonrpc":"2.0","id":cached_id,"method":"trace_prompt_title","params":{"runId":second,"requestId":"title-cache","expectedConfigurationRevision":1}})).unwrap();
    loop {
        let request = backend
            .replies
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        if request["method"] == "host.text.describe" {
            respond(&mut backend, &request, description.clone());
        } else {
            assert_eq!(
                request["id"], cached_id,
                "Cache retry must not generate again: {request}"
            );
            assert_eq!(request["result"]["title"], "Short title", "{request}");
            break;
        }
    }
}

#[test]
fn image_generation_requires_shared_services_and_rejects_legacy_credentials() {
    let data = test_support::tempdir().unwrap();
    let mut backend = Backend::start(data.path());
    backend.ready(vec![]);
    let op = "0123456789abcdef0123456789abcdef";
    let legacy = json!({"kind":"openai-image","operationId":op,"jobId":777,"request":{
        "backend":"codex","codexPath":"/not/invoked/codex","sourcePath":null,"prompt":"Fixture",
        "outputDir":"","outputFilename":"image.png","model":"gpt-image-2","size":"auto","quality":"auto","background":"auto"
    },"apiKey":"private-value-must-never-be-a-consumer-parameter"});
    assert!(backend.call("jobs.start", legacy).get("error").is_some());
    let request = json!({"kind":"openai-image","operationId":op,"jobId":777,"request":{
        "connectionId":"fixture","expectedConnectionRevision":"revision-1","model":null,"sourcePath":null,
        "prompt":"Fixture","outputDir":"","outputFilename":"image.png","size":"auto","quality":"auto","background":"auto"
    }});
    let reply = backend.call("jobs.start",request);
    assert!(reply["error"]["message"].as_str().unwrap().contains("Update Tauri Explorer"),"{reply}");
    assert!(backend.call("jobs.status",json!({"operationId":op}))["result"].is_null());
}

#[cfg(unix)]
#[test]
fn shared_service_images_adopt_exact_bytes_and_recover_without_repeating_start() {
    let output=Command::new("python3").arg(concat!(env!("CARGO_MANIFEST_DIR"),"/test_support/service_images_protocol.py"))
        .arg(env!("CARGO_BIN_EXE_trace-explorer-backend")).output().unwrap();
    assert!(output.status.success(),"{}\n{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("PASS actual-native-stdio restart-delivery-restoration"));
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
                json!({"ready":true})
            );
            assert_eq!(
                candidate.call("lifecycle.activate", json!({}))["result"],
                json!({"ready":true})
            );
        }
        let graph = candidate.call("trace_for_image", json!({"path":target}))["result"].clone();
        assert_eq!(graph["artifacts"].as_array().unwrap().len(), 2, "{graph}");
        assert_eq!(graph["runs"][0]["status"], "succeeded");
        assert!(!anchor.exists());
        assert_eq!(std::fs::read(target).unwrap(), png);
    }
}

#[test]
fn folder_graph_methods_page_a_folder_index_over_the_protocol() {
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

    let page =
        backend.call("trace_folder_components", json!({"directory":folder}))["result"].clone();
    assert_eq!(page["total"], 1, "{page}");
    assert_eq!(page["offset"], 0);
    let component = &page["components"][0];
    assert_eq!(component["unsaved"], true);
    assert_eq!(component["imageCount"], 1);
    let token = page["token"].as_str().unwrap().to_owned();
    let id = component["id"].as_str().unwrap().to_owned();

    let members = backend.call(
        "trace_folder_members",
        json!({"directory":folder,"token":token,"offset":null}),
    )["result"]
        .clone();
    assert_eq!(members["stale"], false, "{members}");
    assert_eq!(members["total"], 0, "unsaved outputs are not folder files");

    let nodes = backend.call(
        "trace_component_nodes",
        json!({"directory":folder,"token":token,"componentId":id,"offset":0}),
    )["result"]
        .clone();
    let node = &nodes["nodes"][0];
    assert_eq!(nodes["total"], 1, "{nodes}");
    assert_eq!(node["scope"], "current");
    assert_eq!(node["temporary"], true);
    assert_eq!(node["prompt"], "Folder visibility fixture");
    let run = node["runId"].as_i64().unwrap();

    let runs = backend.call("trace_run_details", json!({"runIds":[run]}))["result"].clone();
    assert_eq!(runs[0]["id"], run, "{runs}");
    assert_eq!(runs[0]["inputIds"], json!([]));
    let status = backend.call(
        "trace_revision_status",
        json!({"artifactId":node["artifactId"]}),
    );
    assert_eq!(status["result"], "matched", "{status}");

    let refused = backend.call("trace_run_details", json!({"runIds":vec![1; 65]}));
    assert!(refused["error"]["message"].is_string(), "{refused}");
    let refused = backend.call("trace_folder_components", json!({"directory":"relative"}));
    assert!(refused["error"]["message"].is_string(), "{refused}");
    let stale = backend.call(
        "trace_folder_members",
        json!({"directory":folder,"token":"expired"}),
    )["result"]
        .clone();
    assert_eq!(stale["stale"], true);
}
