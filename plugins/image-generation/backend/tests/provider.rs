use base64::{engine::general_purpose::STANDARD, Engine};
use image_generation_backend::{
    adapters,
    domain::{Configuration, Credential, Profile},
    error::{error, Result},
    host::Host,
    service::Service,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use te_image_generation_contract::*;
struct FakeHost {
    directory: tempfile::TempDir,
    artifacts: Mutex<HashMap<String, (PathBuf, ArtifactDescriptor)>>,
    secrets: Mutex<HashMap<(String, String), String>>,
    events: Mutex<Vec<Value>>,
    processes: Mutex<Vec<Value>>,
}
impl FakeHost {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            directory: tempfile::tempdir().unwrap(),
            artifacts: Mutex::new(HashMap::new()),
            secrets: Mutex::new(HashMap::new()),
            events: Mutex::new(vec![]),
            processes: Mutex::new(vec![]),
        })
    }
    fn input(&self, color: u8) -> ArtifactDescriptor {
        let bytes = png(color);
        let handle = format!("input-{color}");
        let path = self.directory.path().join(&handle);
        std::fs::write(&path, &bytes).unwrap();
        let descriptor = ArtifactDescriptor {
            handle: handle.clone(),
            sha256: hex::encode(Sha256::digest(&bytes)),
            byte_length: bytes.len() as u64,
            media_type: "image/png".into(),
        };
        self.artifacts
            .lock()
            .unwrap()
            .insert(handle, (path, descriptor.clone()));
        descriptor
    }
}
impl Host for FakeHost {
    fn call(&self, method: &str, p: Value, _: &AtomicBool) -> Result<Value> {
        match method {
            "host.artifacts.read" => {
                let descriptor: ArtifactDescriptor =
                    serde_json::from_value(p["artifact"].clone()).unwrap();
                let entries = self.artifacts.lock().unwrap();
                let (path, stored) = entries
                    .get(&descriptor.handle)
                    .ok_or_else(|| error("not_found", "Missing artifact"))?;
                if stored != &descriptor {
                    return Err(error("corrupt", "Descriptor mismatch"));
                }
                adapters::read_input(path, &descriptor)
                    .map_err(|_| error("corrupt", "Corrupt sealed bytes"))?;
                Ok(json!({"path":path,"artifact":stored}))
            }
            "host.artifacts.stage" => {
                let handle = format!("stage-{}", p["operationId"].as_str().unwrap());
                let path = self.directory.path().join(&handle);
                std::fs::write(&path, []).unwrap();
                Ok(json!({"handle":handle,"path":path}))
            }
            "host.artifacts.seal" => {
                let handle = p["handle"].as_str().unwrap().to_owned();
                let path = self.directory.path().join(&handle);
                let bytes =
                    std::fs::read(&path).map_err(|_| error("not_found", "Missing output stage"))?;
                adapters::validate_image(&bytes, image::ImageFormat::Png)?;
                let descriptor = ArtifactDescriptor {
                    handle: handle.clone(),
                    sha256: hex::encode(Sha256::digest(&bytes)),
                    byte_length: bytes.len() as u64,
                    media_type: "image/png".into(),
                };
                self.artifacts
                    .lock()
                    .unwrap()
                    .insert(handle, (path, descriptor.clone()));
                Ok(json!(descriptor))
            }
            "host.credentials.put" => {
                let id = image_generation_backend::profiles::nonce()?;
                self.secrets.lock().unwrap().insert(
                    (p["profileId"].as_str().unwrap().into(), id.clone()),
                    p["key"].as_str().unwrap().into(),
                );
                Ok(json!({"id":id}))
            }
            "host.credentials.get" => {
                let key = self
                    .secrets
                    .lock()
                    .unwrap()
                    .get(&(
                        p["profileId"].as_str().unwrap().into(),
                        p["id"].as_str().unwrap().into(),
                    ))
                    .cloned()
                    .ok_or_else(|| error("not_found", "Secret unavailable"))?;
                Ok(json!({"key":key}))
            }
            "host.credentials.remove" => {
                self.secrets.lock().unwrap().remove(&(
                    p["profileId"].as_str().unwrap().into(),
                    p["id"].as_str().unwrap().into(),
                ));
                Ok(json!({"removed":true}))
            }
            "host.services.test.context" => Ok(
                json!({"caller":{"packageId":"xnmp.image-generation","packageDigest":"a".repeat(64),"incarnation":1}}),
            ),
            "host.services.test.begin" | "host.services.test.update" => {
                self.events
                    .lock()
                    .unwrap()
                    .push(json!({"method":method,"params":p}));
                Ok(json!({"accepted":true}))
            }
            "host.process.run" => {
                self.processes.lock().unwrap().push(p.clone());
                let mut command = std::process::Command::new(p["program"].as_str().unwrap());
                command
                    .args(
                        p["args"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|v| v.as_str().unwrap()),
                    )
                    .current_dir(p["cwd"].as_str().unwrap());
                for env in p["env"].as_array().unwrap() {
                    let key = env[0].as_str().unwrap();
                    if let Some(value) = env[1].as_str() {
                        command.env(key, value);
                    } else {
                        command.env_remove(key);
                    }
                }
                let output = command.output().unwrap();
                let index = self.processes.lock().unwrap().len();
                let stdout = self.directory.path().join(format!("stdout-{index}"));
                let stderr = self.directory.path().join(format!("stderr-{index}"));
                std::fs::write(&stdout, &output.stdout).unwrap();
                std::fs::write(&stderr, &output.stderr).unwrap();
                Ok(
                    json!({"handle":format!("process-{index}"),"status":if output.status.success(){0}else{1},"stdout":stdout,"stderr":stderr}),
                )
            }
            "host.process.release" => Ok(Value::Null),
            _ => Err(error("method_not_found", "Fake host method unavailable")),
        }
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.events
            .lock()
            .unwrap()
            .push(json!({"name":name,"payload":payload}));
        Ok(())
    }
}
fn png(color: u8) -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        16,
        16,
        image::Rgba([color, 0, 0, 255]),
    ));
    let mut bytes = std::io::Cursor::new(vec![]);
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
fn configuration(root: &str) -> Configuration {
    Configuration {
        schema_version: 1,
        document_revision: 0,
        default_connection_id: Some("http".into()),
        profiles: vec![Profile::Http {
            id: "http".into(),
            name: "Custom".into(),
            recipe_revision: "".into(),
            base_url: root.into(),
            default_model: "custom-image-model".into(),
            allow_insecure_http: false,
            credential: Credential::None,
        }],
    }
}
fn caller() -> Caller {
    Caller {
        package_id: "test.consumer".into(),
        package_digest: "a".repeat(64),
        incarnation: 1,
    }
}
fn request(profile: &Profile, inputs: Vec<ArtifactDescriptor>) -> PrepareRequest {
    PrepareRequest {
        operation_id: image_generation_backend::profiles::nonce().unwrap(),
        connection_id: profile.id().into(),
        expected_connection_revision: profile.revision().into(),
        model: Some("custom-image-model".into()),
        prompt: "Keep both hats".into(),
        inputs,
        options: ImageOptions {
            size: "1024x1024".into(),
            resolution: None,
            aspect_ratio: None,
            quality: "low".into(),
            background: "opaque".into(),
        },
    }
}
fn start(request: PrepareRequest, preparation: Preparation) -> StartRequest {
    StartRequest {
        operation_id: request.operation_id,
        connection_id: request.connection_id,
        expected_connection_revision: request.expected_connection_revision,
        model: request.model,
        prompt: request.prompt,
        inputs: request.inputs,
        options: request.options,
        preparation_token: preparation.preparation_token,
        effective_recipe_digest: preparation.effective_recipe_digest,
    }
}
async fn terminal(service: &Service, operation: &str) -> OperationStatus {
    for _ in 0..300 {
        let status = service.status("test.consumer", operation).unwrap();
        if !matches!(
            status.execution,
            Execution::Accepted {} | Execution::Running {}
        ) {
            service.wait_idle().await;
            return service.status("test.consumer", operation).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(10)).await
    }
    panic!("Image did not settle")
}
fn server(
    delay: Duration,
) -> (
    String,
    Arc<AtomicUsize>,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!(
        "http://{}/vendor/v1/images/",
        listener.local_addr().unwrap()
    );
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = vec![];
        let header_end = loop {
            let mut buffer = [0; 8192];
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
            if let Some(index) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length: ")
                    .and_then(|s| s.trim().parse::<usize>().ok())
            })
            .unwrap();
        while bytes.len() - header_end < length {
            let mut buffer = [0; 8192];
            let n = stream.read(&mut buffer).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buffer[..n]);
        }
        observed.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(String::from_utf8_lossy(&bytes).to_string());
        std::thread::sleep(delay);
        let body =
            json!({"data":[{"b64_json":STANDARD.encode(png(42))}],"model":"actual-image-model"})
                .to_string();
        let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nx-request-id: fixture-request\r\n\r\n{}",body.len(),body);
    });
    (root, count, rx, worker)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn custom_http_duplicates_and_ordered_inputs_produce_one_durable_result() {
    let (root, count, wire, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let input1 = host.input(1);
    let input2 = host.input(2);
    let prepared = request(&config.profiles[0], vec![input1, input2]);
    let recipe = service.prepare(caller(), prepared.clone()).unwrap();
    assert!(recipe
        .effective_recipe
        .submitted_prompt
        .contains("equal inputs; none is the main image"));
    let request = start(prepared, recipe);
    let first = service.start(caller(), request.clone(), false).unwrap();
    let duplicate = service.start(caller(), request.clone(), false).unwrap();
    assert_eq!(first.operation_id, duplicate.operation_id);
    let status = terminal(&service, &request.operation_id).await;
    assert!(matches!(status.execution, Execution::Succeeded { .. }));
    let body = wire.recv().unwrap();
    assert!(body.starts_with("POST /vendor/v1/images/edits HTTP/1.1"));
    assert!(body.contains("custom-image-model"));
    assert!(body.find("source-1.png").unwrap() < body.find("source-2.png").unwrap());
    assert!(body.contains("Image 1 to Image 2"));
    assert!(!body.contains(directory.path().to_str().unwrap()));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.join().unwrap();
    let mut forged = request.clone();
    forged.prompt = "Another paid request".into();
    assert_eq!(
        service.start(caller(), forged, false).unwrap_err().code,
        "operation_conflict"
    );
    let mut configuration = service.profiles.read().unwrap();
    configuration.profiles.clear();
    configuration.default_connection_id = None;
    service.profiles.save(configuration, 1, None, None).unwrap();
    let mut retry = request.clone();
    retry.preparation_token = "expired".into();
    retry.inputs[0].handle = "new-transient-handle".into();
    assert!(matches!(
        service.start(caller(), retry, false).unwrap().execution,
        Execution::Succeeded { .. }
    ));
    let output = match status.delivery {
        Delivery::Available { output } => output,
        _ => panic!("Missing delivery"),
    };
    let acquired = service
        .journal
        .acknowledge(
            "test.consumer",
            &request.operation_id,
            &output.sha256,
            "acquired",
            Some("fixture-transfer"),
        )
        .unwrap();
    assert_eq!(
        service
            .discard_operation("test.consumer", &request.operation_id)
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    assert_eq!(
        service
            .journal
            .acknowledge(
                "test.consumer",
                &request.operation_id,
                &output.sha256,
                "acquired",
                Some("fixture-transfer")
            )
            .unwrap(),
        acquired
    );
    std::fs::remove_file(host.artifacts.lock().unwrap()[&output.handle].0.clone()).unwrap();
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap()
            .delivery,
        Delivery::Acquired {
            transfer_receipt: "fixture-transfer".into()
        }
    );
    assert!(service
        .journal
        .acknowledge(
            "test.consumer",
            &request.operation_id,
            &output.sha256,
            "discarded",
            None
        )
        .is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_dispatched_http_reports_unknown_without_retry() {
    let (root, count, wire, server) = server(Duration::from_millis(100));
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let request = request(&config.profiles[0], vec![]);
    let request = start(request.clone(), service.prepare(caller(), request).unwrap());
    service.start(caller(), request.clone(), false).unwrap();
    tokio::task::spawn_blocking(move || wire.recv().unwrap())
        .await
        .unwrap();
    service
        .cancel("test.consumer", &request.operation_id)
        .unwrap();
    let status = terminal(&service, &request.operation_id).await;
    assert!(matches!(status.execution, Execution::Unknown { .. }));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(matches!(
        service.start(caller(), request, false).unwrap().execution,
        Execution::Unknown { .. }
    ));
    server.join().unwrap();
}
#[tokio::test]
async fn cancellation_before_admission_prevents_all_provider_io() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/v1/images"), 0, None, None)
        .unwrap();
    let request = request(&config.profiles[0], vec![]);
    let request = start(request.clone(), service.prepare(caller(), request).unwrap());
    assert!(service
        .cancel("test.consumer", &request.operation_id)
        .is_err());
    let status = service.start(caller(), request.clone(), false).unwrap();
    assert_eq!(status.execution, Execution::Cancelled {});
    assert_eq!(
        service.start(caller(), request, false).unwrap().execution,
        Execution::Cancelled {}
    );
    assert!(host.processes.lock().unwrap().is_empty());
}
#[tokio::test]
async fn recovery_never_dispatches_accepted_or_running_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.journal.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/v1/images"), 0, None, None)
        .unwrap();
    let accepted = request(&config.profiles[0], vec![]);
    let running = request(&config.profiles[0], vec![]);
    for request in [&accepted, &running] {
        let recipe =
            image_generation_backend::domain::recipe(&config.profiles[0], request).unwrap();
        service
            .journal
            .accept(
                &caller(),
                &request.operation_id,
                &"a".repeat(64),
                &recipe,
                false,
            )
            .unwrap();
    }
    assert!(service
        .journal
        .claim("test.consumer", &running.operation_id)
        .unwrap());
    assert!(!service
        .journal
        .claim("test.consumer", &running.operation_id)
        .unwrap());
    service.activate().unwrap();
    assert_eq!(
        service
            .status("test.consumer", &accepted.operation_id)
            .unwrap()
            .execution,
        Execution::Cancelled {}
    );
    assert!(matches!(
        service
            .status("test.consumer", &running.operation_id)
            .unwrap()
            .execution,
        Execution::Unknown { .. }
    ));
    assert!(host.processes.lock().unwrap().is_empty());
}
#[tokio::test]
async fn profile_cas_credentials_and_recipe_rotation_are_independent() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let first = service
        .profiles
        .save(
            configuration("https://custom.test/prefix/images"),
            0,
            None,
            None,
        )
        .unwrap();
    let initial = first.profiles[0].revision().to_owned();
    let mut renamed = first.clone();
    if let Profile::Http { name, .. } = &mut renamed.profiles[0] {
        *name = "Renamed".into()
    }
    let renamed = service.profiles.save(renamed, 1, None, None).unwrap();
    assert_eq!(renamed.profiles[0].revision(), initial);
    assert!(service.profiles.save(first, 1, None, None).is_err());
    let saved = service
        .settings(
            "credential.set",
            json!({"profileId":"http","key":"fixture-secret-never-read-back","expectedRevision":2}),
        )
        .unwrap();
    assert_eq!(saved["profiles"][0]["hasCredential"], true);
    assert!(!saved.to_string().contains("fixture-secret-never-read-back"));
    assert_ne!(saved["profiles"][0]["recipeRevision"], initial);
    let key_records = host.secrets.lock().unwrap().clone();
    assert_eq!(
        service
            .settings(
                "credential.set",
                json!({"profileId":"http","key":"stale-attempt","expectedRevision":2})
            )
            .unwrap_err()
            .code,
        "configuration_changed"
    );
    assert_eq!(*host.secrets.lock().unwrap(), key_records);
    let cleared = service
        .settings(
            "credential.clear",
            json!({"profileId":"http","expectedRevision":3}),
        )
        .unwrap();
    assert_eq!(cleared["profiles"][0]["credential"]["kind"], "none");
    assert_ne!(
        cleared["profiles"][0]["recipeRevision"],
        saved["profiles"][0]["recipeRevision"]
    );
    assert!(host.secrets.lock().unwrap().is_empty());
}
#[test]
fn malformed_config_and_recipe_boundaries_fail_closed() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("profiles.json"), b"broken").unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    assert!(service.validate_preflight().is_err());
    assert!(service.profiles.read().is_err());
    assert!(!image_generation_backend::domain::valid_size(
        "18446744073709551615x999"
    ));
    for root in [
        "https://u:p@test/images",
        "https://test/images?key=secret",
        "https://test/images#fragment",
        "https://test/images/generations",
        "https://test/images/edits",
    ] {
        assert!(image_generation_backend::domain::root(root, false).is_err());
    }
}
/// Plan §14.1 "Profile validation": the provider's own store rejects an unknown
/// transport, null/wrong-typed fields and duplicate profile IDs, whether they
/// arrive from Settings, a migration import or a hand-edited document, and a
/// rejection never writes, bumps the revision or resets to defaults.
#[tokio::test]
async fn unknown_transport_wrong_types_and_duplicate_ids_are_rejected_without_any_write() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let valid = || json!({"transport":"openai-images","id":"http","name":"Custom","recipeRevision":"","baseUrl":"https://custom.test/v1/images","defaultModel":"custom-image-model","allowInsecureHttp":false,"credential":{"kind":"none"}});
    let with = |field: &str, value: Value| {
        let mut profile = valid();
        if let Some(removed) = field.strip_prefix('-') {
            profile.as_object_mut().unwrap().remove(removed);
        } else {
            profile[field] = value;
        }
        profile
    };
    let document = |profiles: Vec<Value>| json!({"schemaVersion":1,"documentRevision":0,"defaultConnectionId":null,"profiles":profiles});
    let codex = json!({"transport":"codex-cli","id":"http","name":"Codex","recipeRevision":"","executablePath":"","modelSelection":false,"credential":{"kind":"cli_saved_login"}});
    let mut rejected = vec![
        (
            "unknown transport",
            document(vec![with("transport", json!("gemini-images"))]),
        ),
        (
            "missing transport",
            document(vec![with("-transport", Value::Null)]),
        ),
        (
            "numeric transport",
            document(vec![with("transport", json!(1))]),
        ),
        (
            "boolean as string",
            document(vec![with("allowInsecureHttp", json!("false"))]),
        ),
        (
            "numeric model",
            document(vec![with("defaultModel", json!(42))]),
        ),
        ("null name", document(vec![with("name", Value::Null)])),
        (
            "missing base URL",
            document(vec![with("-baseUrl", Value::Null)]),
        ),
        (
            "null credential",
            document(vec![with("credential", Value::Null)]),
        ),
        (
            "unknown credential kind",
            document(vec![with("credential", json!({"kind":"keychain"}))]),
        ),
        (
            "numeric secret reference",
            document(vec![with("credential", json!({"kind":"secret","id":7}))]),
        ),
        (
            "inline key field",
            document(vec![with("apiKey", json!("sk-inline-secret"))]),
        ),
        ("profile is a string", document(vec![json!("http")])),
        (
            "duplicate HTTP IDs",
            document(vec![valid(), with("name", json!("Second"))]),
        ),
        (
            "duplicate across transports",
            document(vec![valid(), codex]),
        ),
    ];
    for (field, value) in [
        ("profiles", Value::Null),
        ("profiles", json!({"http":valid()})),
        ("schemaVersion", json!("1")),
        ("documentRevision", json!(-1)),
        ("defaultConnectionId", json!(5)),
    ] {
        let mut config = document(vec![valid()]);
        config[field] = value;
        rejected.push(("wrong document field", config));
    }
    for (case, configuration) in &rejected {
        let failure = service
            .settings(
                "save",
                json!({"expectedRevision":0,"configuration":configuration}),
            )
            .expect_err(case);
        assert_eq!(failure.code, "invalid_request", "{case}");
        assert!(!failure.message.contains("sk-inline-secret"), "{case}");
        assert!(
            !directory.path().join("profiles.json").exists(),
            "{case} wrote profiles"
        );
    }
    // Migration imports are validated by the same provider-native rules.
    for profiles in [
        json!([with("transport", json!("gemini-images"))]),
        json!([with("allowInsecureHttp", json!(1))]),
        json!([valid(), with("name", json!("Second"))]),
    ] {
        let failure = service
            .migration(
                "import",
                json!({"sourceId":"trace-openai-image-v1","sourceDigest":"a".repeat(64),"expectedRevision":0,"defaultConnectionId":"http","profiles":profiles}),
            )
            .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert!(!directory.path().join("profiles.json").exists());
    }
    assert!(host.events.lock().unwrap().is_empty());
    // Nothing was consumed: the first valid save is still revision 0 -> 1.
    let saved = service
        .settings(
            "save",
            json!({"expectedRevision":0,"configuration":document(vec![valid()])}),
        )
        .unwrap();
    assert_eq!(saved["documentRevision"], 1);
    // A hand-edited document with the same defects fails closed on read and is
    // left byte-for-byte for repair rather than reset to an empty default.
    let path = directory.path().join("profiles.json");
    let good: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (case, configuration) in rejected {
        let mut corrupt = good.clone();
        corrupt["configuration"] = configuration;
        let bytes = serde_json::to_vec(&corrupt).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            service.settings("read", json!({})).unwrap_err().code,
            "unavailable",
            "{case}"
        );
        assert!(service.validate_preflight().is_err(), "{case}");
        assert!(service
            .settings(
                "save",
                json!({"expectedRevision":1,"configuration":document(vec![])})
            )
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{case}");
    }
}

#[tokio::test]
async fn preflight_is_read_only_and_activation_has_one_process_owner() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let absent = directory.path().join("not-created-by-preflight");
    let preview = Service::new(&absent, host.clone()).unwrap();
    preview.validate_preflight().unwrap();
    assert!(!absent.exists());
    drop(preview);
    let before = std::fs::read_dir(directory.path()).unwrap().count();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), before);
    assert!(!service.ready());
    assert!(host.events.lock().unwrap().is_empty());
    service.activate().unwrap();
    let second = Service::new(directory.path(), host).unwrap();
    assert_eq!(second.activate().unwrap_err().code, "busy");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_and_restored_delivery_does_not_change_proven_execution() {
    let (root, _, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    let succeeded = terminal(&service, &request.operation_id).await;
    server.join().unwrap();
    let descriptor = match &succeeded.delivery {
        Delivery::Available { output } => output.clone(),
        _ => panic!("No image"),
    };
    let record = host
        .artifacts
        .lock()
        .unwrap()
        .remove(&descriptor.handle)
        .unwrap();
    let bytes = std::fs::read(&record.0).unwrap();
    std::fs::remove_file(&record.0).unwrap();
    let missing = service
        .status("test.consumer", &request.operation_id)
        .unwrap();
    assert_eq!(missing.execution, succeeded.execution);
    assert_eq!(
        missing.delivery,
        Delivery::Unavailable {
            reason: "missing".into()
        }
    );
    std::fs::write(&record.0, bytes).unwrap();
    host.artifacts
        .lock()
        .unwrap()
        .insert(descriptor.handle.clone(), record);
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap()
            .delivery,
        Delivery::Available { output: descriptor }
    );
    assert_eq!(
        service
            .cancel("test.consumer", &request.operation_id)
            .unwrap()
            .execution,
        succeeded.execution
    );
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fake_cli_preserves_launcher_runtime_order_saved_login_and_managed_image_model() {
    use std::os::unix::fs::PermissionsExt;
    let installation = tempfile::tempdir().unwrap();
    let bin = installation.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let home = installation.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let previous = std::env::var_os("CODEX_HOME");
    std::env::set_var("CODEX_HOME", &home);
    struct Restore(Option<std::ffi::OsString>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(value) = &self.0 {
                std::env::set_var("CODEX_HOME", value)
            } else {
                std::env::remove_var("CODEX_HOME")
            }
        }
    }
    let _restore = Restore(previous);
    let launcher = bin.join("codex");
    std::fs::write(&launcher, b"#!/usr/bin/env fake-node\n").unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = bin.join("fake-node");
    let script=format!("#!/usr/bin/env python3\nimport os,sys,json,base64\nargs=sys.argv[2:]\nassert not any(os.environ.get(k) for k in ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN'])\nif args==['login','status']:\n print('Logged in using ChatGPT',file=sys.stderr)\nelse:\n assert '--ignore-user-config' in args and '--ephemeral' in args\n assert '--model' not in args and '-m' not in args\n assert args[-2]=='--'\n paths=[args[i+1] for i,a in enumerate(args) if a=='--image']\n assert len(paths)==2 and paths[0].endswith('source-1.png') and paths[1].endswith('source-2.png')\n assert 'equal inputs; none is the main image' in args[-1]\n thread='12345678-1234-1234-1234-123456789abc'\n target=os.path.join(os.environ['CODEX_HOME'],'generated_images',thread)\n os.makedirs(target)\n open(os.path.join(target,'output.png'),'wb').write(base64.b64decode('{}'))\n print(json.dumps({{'type':'thread.started','thread_id':thread}}))\n print(json.dumps({{'type':'item.completed','item':{{'type':'agent_message','text':'Successful transcript must never be persisted'}}}}))\n print(json.dumps({{'type':'turn.completed','usage':{{}}}}))\n",STANDARD.encode(png(99)));
    std::fs::write(&runtime, script).unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let mut config = configuration("https://unused.test/images");
    config.profiles = vec![Profile::Codex {
        id: "http".into(),
        name: "Codex".into(),
        recipe_revision: "".into(),
        executable_path: launcher.to_string_lossy().into_owned(),
        model_selection: false,
        credential: Credential::CliSavedLogin,
    }];
    let saved = service.profiles.save(config, 0, None, None).unwrap();
    let mut prepared = request(&saved.profiles[0], vec![host.input(1), host.input(2)]);
    prepared.model = None;
    prepared.options.quality = "auto".into();
    prepared.options.background = "auto".into();
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    let result = terminal(&service, &request.operation_id).await;
    match &result.execution {
        Execution::Succeeded { metadata } => {
            assert_eq!(metadata.requested_model, None);
            assert_eq!(metadata.actual_model, None);
            assert_eq!(
                metadata.thread_id,
                Some("12345678-1234-1234-1234-123456789abc".into())
            );
        }
        state => panic!("Unexpected CLI execution: {state:?}"),
    }
    let persisted = serde_json::to_string(&result).unwrap();
    assert!(!persisted.contains("Successful transcript must never be persisted"));
    assert!(result.diagnostics.as_ref().unwrap().valid(true));
    let processes = host.processes.lock().unwrap();
    assert_eq!(processes.len(), 2);
    assert_eq!(processes[0]["args"], json!(["login", "status"]));
    assert_eq!(processes[1]["program"], launcher.to_str().unwrap());
    assert!(processes[1]["env"][0][1]
        .as_str()
        .unwrap()
        .starts_with(bin.to_str().unwrap()));
    assert_eq!(
        processes[1]["args"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .as_str()
            .unwrap(),
        service
            .prepare(caller(), request.prepared())
            .unwrap()
            .effective_recipe
            .agent_task
            .unwrap()
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_settings_test_uses_owned_host_admission_and_remains_idempotent() {
    let (root, count, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let operation = image_generation_backend::profiles::nonce().unwrap();
    let params =
        json!({"profileId":"http","requestId":operation,"expectedConfigurationRevision":1});
    service.settings("test", params.clone()).unwrap();
    let status = loop {
        let value = service
            .settings("test.status", json!({"requestId":operation}))
            .unwrap();
        let status: OperationStatus = serde_json::from_value(value).unwrap();
        if !matches!(
            status.execution,
            Execution::Accepted {} | Execution::Running {}
        ) {
            break status;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert!(matches!(status.execution, Execution::Succeeded { .. }));
    service.settings("test", params).unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.join().unwrap();
    assert!(host
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event["method"] == "host.services.test.begin"));
    let discarded = service
        .settings("test.discard", json!({"requestId":operation}))
        .unwrap();
    assert_eq!(discarded["delivery"]["state"], "discarded");
    assert_eq!(
        service
            .settings("test.discard", json!({"requestId":operation}))
            .unwrap(),
        discarded
    );
}
struct LostBegin {
    inner: Arc<FakeHost>,
    service: Mutex<Option<std::sync::Weak<Service>>>,
    begins: AtomicUsize,
}
impl Host for LostBegin {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        if method == "host.services.test.begin" {
            self.begins.fetch_add(1, Ordering::SeqCst);
            let service = self
                .service
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .unwrap();
            let status = service
                .journal
                .get(
                    "xnmp.image-generation",
                    params["operationId"].as_str().unwrap(),
                    None,
                )?
                .unwrap();
            assert_eq!(status.execution, Execution::Accepted {});
            return Err(error("host_unavailable", "Lost native admission reply"));
        }
        self.inner.call(method, params, cancel)
    }
    fn event(&self, name: &str, params: Value) -> Result<()> {
        self.inner.event(name, params)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lost_test_begin_reply_never_enqueues_paid_work_and_repeat_returns_receipt() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let root = format!("http://{}/images", listener.local_addr().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(LostBegin {
        inner: FakeHost::new(),
        service: Mutex::new(None),
        begins: AtomicUsize::new(0),
    });
    let service = Service::new(directory.path(), host.clone()).unwrap();
    *host.service.lock().unwrap() = Some(Arc::downgrade(&service));
    service.activate().unwrap();
    service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let operation = image_generation_backend::profiles::nonce().unwrap();
    let params =
        json!({"profileId":"http","requestId":operation,"expectedConfigurationRevision":1});
    let first = service.settings("test", params.clone()).unwrap();
    assert_eq!(first["execution"]["state"], "failed");
    assert_eq!(service.settings("test",json!({"profileId":"deleted","requestId":operation,"expectedConfigurationRevision":999})).unwrap(),first);
    assert_eq!(host.begins.load(Ordering::SeqCst), 1);
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_between_local_test_acceptance_and_host_begin_cancels_without_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/images"), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let recipe = image_generation_backend::domain::recipe(&config.profiles[0], &prepared).unwrap();
    let caller = Caller {
        package_id: "xnmp.image-generation".into(),
        package_digest: "a".repeat(64),
        incarnation: 1,
    };
    service
        .journal
        .accept(
            &caller,
            &prepared.operation_id,
            &"a".repeat(64),
            &recipe,
            true,
        )
        .unwrap();
    drop(service);
    let recovered = Service::new(directory.path(), host.clone()).unwrap();
    recovered.activate().unwrap();
    let receipt=recovered.settings("test",json!({"profileId":"removed","requestId":prepared.operation_id,"expectedConfigurationRevision":999})).unwrap();
    assert_eq!(receipt["execution"]["state"], "cancelled");
    assert!(host
        .events
        .lock()
        .unwrap()
        .iter()
        .all(|event| event["method"] != "host.services.test.begin"));
    assert!(host.processes.lock().unwrap().is_empty());
}
struct HeldCredential {
    inner: Arc<FakeHost>,
    entered: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Host for HeldCredential {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        let value = self.inner.call(method, params, cancel)?;
        if method == "host.credentials.get" {
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
        }
        Ok(value)
    }
    fn event(&self, name: &str, params: Value) -> Result<()> {
        self.inner.event(name, params)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_rotation_during_capture_rejects_stale_admission_without_dispatch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let root = format!("http://{}/images", listener.local_addr().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let host = Arc::new(HeldCredential {
        inner: FakeHost::new(),
        entered: Mutex::new(Some(entered_tx)),
        release: Mutex::new(release_rx),
    });
    let service = Service::new(directory.path(), host).unwrap();
    service.activate().unwrap();
    service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    service
        .settings(
            "credential.set",
            json!({"profileId":"http","key":"old-fixture-key","expectedRevision":1}),
        )
        .unwrap();
    let configuration = service.profiles.read().unwrap();
    let prepared = request(&configuration.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    let operation = request.operation_id.clone();
    let admission = tokio::task::spawn_blocking({
        let service = service.clone();
        move || service.start(caller(), request, false)
    });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    assert!(!service.operation_idle("test.consumer", &operation).unwrap());
    service
        .settings(
            "credential.set",
            json!({"profileId":"http","key":"new-fixture-key","expectedRevision":2}),
        )
        .unwrap();
    release_tx.send(()).unwrap();
    let rejected = admission.await.unwrap().unwrap();
    assert!(service.operation_idle("test.consumer", &operation).unwrap());
    assert!(
        matches!(&rejected.execution, Execution::Failed { error } if error.code == "configuration_changed")
    );
    assert_eq!(
        service
            .journal
            .get("test.consumer", &operation, None)
            .unwrap()
            .unwrap(),
        rejected
    );
    assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
}
#[tokio::test]
async fn rename_and_unrelated_profile_edits_do_not_invalidate_admission_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    let mut initial = configuration("https://custom.test/images");
    let mut other = initial.profiles[0].clone();
    if let Profile::Http { id, .. } = &mut other {
        *id = "other".into();
    }
    initial.profiles.push(other);
    let mut saved = service.profiles.save(initial, 0, None, None).unwrap();
    let snapshot = saved.profiles[0].clone();
    if let Profile::Http { name, .. } = &mut saved.profiles[0] {
        *name = "Renamed only".into();
    }
    if let Profile::Http { base_url, .. } = &mut saved.profiles[1] {
        *base_url = "https://other.test/new/images".into();
    }
    service.profiles.save(saved, 1, None, None).unwrap();
    assert_eq!(
        service
            .profiles
            .admit(&snapshot, || Ok("accepted original execution snapshot"))
            .unwrap(),
        "accepted original execution snapshot"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_profiles_after_restart_preserve_paid_receipt_recovery_but_fail_preflight() {
    let (root, _, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    let succeeded = terminal(&service, &request.operation_id).await;
    server.join().unwrap();
    service.wait_idle().await;
    drop(service);
    std::fs::write(directory.path().join("profiles.json"), b"broken").unwrap();
    let recovered = Service::new(directory.path(), host).unwrap();
    assert!(recovered.validate_preflight().is_err());
    recovered.activate().unwrap();
    assert_eq!(
        recovered
            .status("test.consumer", &request.operation_id)
            .unwrap()
            .execution,
        succeeded.execution
    );
    assert_eq!(
        recovered.start(caller(), request, false).unwrap().execution,
        succeeded.execution
    );
    assert!(recovered.describe().is_err());
}
struct InvalidSealingHost {
    inner: Arc<FakeHost>,
    field: &'static str,
}
impl Host for InvalidSealingHost {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        let mut value = self.inner.call(method, params, cancelled)?;
        if method == "host.artifacts.seal" {
            if self.field == "panic" {
                panic!("Injected host sealing worker failure");
            }
            value[self.field] = match self.field {
                "byteLength" => json!(1),
                "mediaType" => json!("image/jpeg"),
                "sha256" => json!("0".repeat(64)),
                _ => json!("different-stage"),
            };
        }
        Ok(value)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_output_seal_reply_preserves_proof_and_recovers_exact_owned_bytes() {
    for field in ["byteLength", "mediaType", "sha256", "handle", "panic"] {
        let (root, count, _, server) = server(Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(InvalidSealingHost {
            inner: FakeHost::new(),
            field,
        });
        let service = Service::new(directory.path(), host).unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration(&root), 0, None, None)
            .unwrap();
        let prepared = request(&config.profiles[0], vec![]);
        let recipe = service.prepare(caller(), prepared.clone()).unwrap();
        let request = start(prepared, recipe);
        service.start(caller(), request.clone(), false).unwrap();
        service.wait_idle().await;
        let unsettled = service
            .journal
            .get("test.consumer", &request.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(
            matches!(unsettled.delivery, Delivery::Unavailable { .. }),
            "{field}"
        );
        let status = service
            .status("test.consumer", &request.operation_id)
            .unwrap();
        assert!(
            matches!(status.execution, Execution::Succeeded { .. }),
            "{field}"
        );
        assert!(
            matches!(status.delivery, Delivery::Available { .. }),
            "{field}"
        );
        assert!(matches!(
            service.start(caller(), request, false).unwrap().execution,
            Execution::Succeeded { .. }
        ));
        assert_eq!(count.load(Ordering::Acquire), 1);
        service.wait_idle().await;
        server.join().unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn valid_admission_rejections_are_durable_and_never_dispatch() {
    for cause in [
        "preparation_expired",
        "configuration_changed",
        "credential_missing",
        "input_missing",
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let root = format!("http://{}/images", listener.local_addr().unwrap());
        let directory = tempfile::tempdir().unwrap();
        let host = FakeHost::new();
        let service = Service::new(directory.path(), host.clone()).unwrap();
        service.activate().unwrap();
        let mut config = configuration(&root);
        if cause == "credential_missing" {
            *config.profiles[0].credential_mut() = Credential::Environment {
                name: format!(
                    "TE_TEST_ABSENT_{}",
                    image_generation_backend::profiles::nonce().unwrap()
                ),
            };
        }
        let config = service.profiles.save(config, 0, None, None).unwrap();
        let inputs = if cause == "input_missing" {
            vec![host.input(8)]
        } else {
            vec![]
        };
        let prepared = request(&config.profiles[0], inputs);
        let recipe = service.prepare(caller(), prepared.clone()).unwrap();
        let mut request = start(prepared, recipe);
        if cause == "preparation_expired" {
            request.preparation_token = "lost-or-expired-token".into();
        }
        if cause == "configuration_changed" {
            let mut edited = config.clone();
            if let Profile::Http { default_model, .. } = &mut edited.profiles[0] {
                *default_model = "new-model".into();
            }
            service.profiles.save(edited, 1, None, None).unwrap();
        }
        if cause == "input_missing" {
            host.artifacts.lock().unwrap().clear();
        }
        let rejected = service.start(caller(), request.clone(), false).unwrap();
        assert!(
            matches!(rejected.execution, Execution::Failed { .. }),
            "{cause}"
        );
        assert_eq!(rejected.revision, 1);
        assert_eq!(rejected.delivery, Delivery::None {});
        assert_eq!(
            rejected.request_fingerprint,
            request.effective_recipe_digest
        );
        let mut deleted = service.profiles.read().unwrap();
        let revision = deleted.document_revision;
        deleted.profiles.clear();
        deleted.default_connection_id = None;
        service
            .profiles
            .save(deleted, revision, None, None)
            .unwrap();
        request.preparation_token = "another-handle".into();
        assert_eq!(
            service.start(caller(), request.clone(), false).unwrap(),
            rejected
        );
        assert_eq!(
            service
                .status("test.consumer", &request.operation_id)
                .unwrap(),
            rejected
        );
        let mut conflicting = request;
        conflicting.prompt.push_str(" different logical intent");
        assert_eq!(
            service
                .start(caller(), conflicting, false)
                .unwrap_err()
                .code,
            "operation_conflict"
        );
        assert!(matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
        let operation = rejected.operation_id.clone();
        drop(service);
        let recovered = Service::new(directory.path(), host).unwrap();
        recovered.activate().unwrap();
        assert_eq!(
            recovered.status("test.consumer", &operation).unwrap(),
            rejected
        );
    }
}
struct HeldInputGrants {
    inner: Arc<FakeHost>,
    entered: std::sync::mpsc::Sender<()>,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
impl Host for HeldInputGrants {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.read" {
            self.entered.send(()).unwrap();
            let mut released = self.released.lock().unwrap();
            while !*released {
                released = self.wake.wait(released).unwrap();
            }
            return Err(error("input_changed", "Fixture input grant changed"));
        }
        self.inner.call(method, params, cancel)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_admission_capacity_returns_a_durable_rejection_without_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let host = Arc::new(HeldInputGrants {
        inner: FakeHost::new(),
        entered: tx,
        released: Mutex::new(false),
        wake: std::sync::Condvar::new(),
    });
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/images"), 0, None, None)
        .unwrap();
    let input = host.inner.input(4);
    let mut tasks = vec![];
    for _ in 0..36 {
        let prepared = request(&config.profiles[0], vec![input.clone()]);
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        tasks.push(tokio::task::spawn_blocking({
            let service = service.clone();
            move || service.start(caller(), request, false)
        }));
    }
    tokio::task::spawn_blocking(move || {
        for _ in 0..36 {
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }
    })
    .await
    .unwrap();
    let prepared = request(&config.profiles[0], vec![input]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    let rejected = service.start(caller(), request.clone(), false).unwrap();
    assert!(matches!(&rejected.execution, Execution::Failed { error } if error.code == "busy"));
    *host.released.lock().unwrap() = true;
    host.wake.notify_all();
    for task in tasks {
        assert!(matches!(
            task.await.unwrap().unwrap().execution,
            Execution::Failed { .. }
        ));
    }
    assert_eq!(service.start(caller(), request, false).unwrap(), rejected);
    assert!(host.inner.processes.lock().unwrap().is_empty());
}
#[tokio::test]
async fn rejection_storage_failure_retains_uncertainty_without_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/images"), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let mut request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    request.preparation_token = "expired-token".into();
    let connection =
        rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    connection.execute_batch("CREATE TRIGGER injected_rejection_write_failure BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert_eq!(
        service
            .start(caller(), request.clone(), false)
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert!(service
        .journal
        .get("test.consumer", &request.operation_id, None)
        .unwrap()
        .is_none());
    assert!(host.processes.lock().unwrap().is_empty());
    connection
        .execute_batch("DROP TRIGGER injected_rejection_write_failure;")
        .unwrap();
    assert!(matches!(
        service.start(caller(), request, false).unwrap().execution,
        Execution::Failed { .. }
    ));
}
#[tokio::test]
async fn rejection_cannot_replace_an_existing_accepted_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/images"), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let recipe = service.prepare(caller(), prepared.clone()).unwrap();
    let recipe_value = recipe.effective_recipe.clone();
    let request = start(prepared, recipe);
    let semantic = image_generation_backend::domain::semantic(&request);
    let accepted = service
        .journal
        .accept(
            &caller(),
            &request.operation_id,
            &semantic,
            &recipe_value,
            false,
        )
        .unwrap()
        .0;
    assert_eq!(
        service
            .journal
            .reject(
                &caller(),
                &request.operation_id,
                &semantic,
                &request.effective_recipe_digest,
                error("busy", "No admission"),
                false
            )
            .unwrap(),
        accepted
    );
    assert_eq!(
        service
            .journal
            .reject(
                &caller(),
                &request.operation_id,
                "different-semantic",
                &request.effective_recipe_digest,
                error("busy", "No admission"),
                false
            )
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap(),
        accepted
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_rejects_redirects_and_invalid_results_without_followup_requests() {
    for (http_status, body, expected) in [
        ("302 Found", json!({}), "provider_rejected"),
        (
            "500 Internal Server Error",
            json!({"error":"fixture private diagnostic"}),
            "remote_outcome_unknown",
        ),
        (
            "200 OK",
            json!({"data":[{"url":"http://localhost:9/private.png"}]}),
            "invalid_response",
        ),
        (
            "200 OK",
            json!({"data":[{"b64_json":"bad"},{"b64_json":"bad"}]}),
            "invalid_response",
        ),
        (
            "200 OK",
            json!({"data":[{"b64_json":"not base64!"}]}),
            "invalid_response",
        ),
    ] {
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let retained = listener.try_clone().unwrap();
        let root = format!("http://{}/images", listener.local_addr().unwrap());
        let destination_url = format!(
            "http://{}/redirect-target",
            destination.local_addr().unwrap()
        );
        let response = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = vec![];
            let (end, length) = loop {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&bytes[..end])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap();
                    break (end + 4, length);
                }
            };
            while bytes.len() < end + length {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
            }
            let body = body.to_string();
            write!(stream,"HTTP/1.1 {http_status}\r\nContent-Type: application/json\r\nLocation: {destination_url}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let service = Service::new(directory.path(), FakeHost::new()).unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration(&root), 0, None, None)
            .unwrap();
        let prepared = request(&config.profiles[0], vec![]);
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), request.clone(), false).unwrap();
        let status = terminal(&service, &request.operation_id).await;
        let failure = match &status.execution {
            Execution::Failed { error } | Execution::Unknown { error } => error,
            _ => panic!("Invalid response was accepted"),
        };
        assert_eq!(failure.code, expected);
        assert!(!failure.message.contains("fixture private diagnostic"));
        assert!(matches!(destination.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
        retained.set_nonblocking(true).unwrap();
        assert!(matches!(retained.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock));
        assert_eq!(service.start(caller(), request, false).unwrap(), status);
        response.join().unwrap();
        service.wait_idle().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quiesce_refuses_held_workers_then_checkpoints_without_reverse_io_or_replay() {
    let (root, count, wire, server) = server(Duration::from_millis(120));
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    tokio::task::spawn_blocking(move || wire.recv_timeout(Duration::from_secs(3)).unwrap())
        .await
        .unwrap();
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    let result = terminal(&service, &request.operation_id).await;
    assert!(matches!(result.execution, Execution::Succeeded { .. }));
    service.wait_idle().await;
    let events = host.events.lock().unwrap().len();
    assert_eq!(
        service.quiesce().unwrap(),
        json!({"ready":false,"idle":true,"checkpoint":true})
    );
    assert!(!service.ready());
    assert_eq!(host.events.lock().unwrap().len(), events);
    assert_eq!(count.load(Ordering::Acquire), 1);
    assert!(
        std::fs::metadata(directory.path().join("operations.sqlite-wal"))
            .unwrap()
            .len()
            == 0
    );
    service.activate().unwrap();
    assert!(service.ready());
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap(),
        result
    );
    assert_eq!(count.load(Ordering::Acquire), 1);
    server.join().unwrap();
}
#[tokio::test]
async fn quiesce_reports_busy_checkpoint_and_restores_admissions_until_reader_drains() {
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration("http://localhost:9/images"), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let recipe = service.prepare(caller(), prepared.clone()).unwrap();
    let request = start(prepared, recipe);
    let reader = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    reader
        .execute_batch("BEGIN; SELECT count(*) FROM operations;")
        .unwrap();
    let receipt = service
        .journal
        .reject(
            &caller(),
            &request.operation_id,
            &image_generation_backend::domain::semantic(&request),
            &request.effective_recipe_digest,
            error("busy", "Fixture rejected"),
            false,
        )
        .unwrap();
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    reader.execute_batch("COMMIT;").unwrap();
    assert_eq!(
        service.quiesce().unwrap(),
        json!({"ready":false,"idle":true,"checkpoint":true})
    );
    assert!(!service.ready());
    let snapshot = tempfile::tempdir().unwrap();
    std::fs::copy(
        directory.path().join("operations.sqlite"),
        snapshot.path().join("operations.sqlite"),
    )
    .unwrap();
    let recovered = Service::new(snapshot.path(), FakeHost::new()).unwrap();
    assert_eq!(
        recovered
            .journal
            .get("test.consumer", &request.operation_id, None)
            .unwrap()
            .unwrap(),
        receipt
    );
}
#[tokio::test]
async fn committed_but_uncertain_profile_write_retains_its_new_secret() {
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let fail = Arc::new(AtomicBool::new(false));
    let policy = image_generation_backend::service::ServicePolicy {
        sync_profile_directory: {
            let fail = fail.clone();
            Arc::new(move |_| {
                if fail.load(Ordering::Acquire) {
                    Err(std::io::Error::other(
                        "Injected post-replace directory sync failure",
                    ))
                } else {
                    Ok(())
                }
            })
        },
        ..Default::default()
    };
    let service = Service::with_policy(directory.path(), host.clone(), policy).unwrap();
    service.activate().unwrap();
    service
        .profiles
        .save(configuration("https://custom.test/images"), 0, None, None)
        .unwrap();
    fail.store(true, Ordering::Release);
    let failure = service
        .settings(
            "credential.set",
            json!({"profileId":"http","expectedRevision":1,"key":"uncertain-fixture-secret"}),
        )
        .unwrap_err();
    assert_eq!(failure.code, "mutation_uncertain");
    assert!(!failure.message.contains("uncertain-fixture-secret"));
    let committed = service.profiles.read().unwrap();
    assert_eq!(committed.document_revision, 2);
    let id = match committed.profiles[0].credential() {
        Credential::Secret { id } => id.clone(),
        _ => panic!("Committed profile lost its credential"),
    };
    assert_eq!(
        host.secrets
            .lock()
            .unwrap()
            .get(&("http".into(), id))
            .map(String::as_str),
        Some("uncertain-fixture-secret")
    );
    assert_eq!(
        service
            .settings("check", json!({"profileId":"http"}))
            .unwrap()["available"],
        true
    );
    assert!(host.processes.lock().unwrap().is_empty());
}
#[tokio::test]
async fn missing_initialized_journal_or_required_schema_never_recreates_receipts() {
    for corruption in [
        "missing",
        "missing_without_marker",
        "cancellations",
        "operations",
        "marker",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let service = Service::new(directory.path(), FakeHost::new()).unwrap();
        service.activate().unwrap();
        service.quiesce().unwrap();
        drop(service);
        assert!(directory.path().join("operations.initialized").is_file());
        match corruption {
            "missing" | "missing_without_marker" => {
                for name in [
                    "operations.sqlite",
                    "operations.sqlite-wal",
                    "operations.sqlite-shm",
                ] {
                    let _ = std::fs::remove_file(directory.path().join(name));
                }
                if corruption == "missing_without_marker" {
                    std::fs::remove_file(directory.path().join("operations.initialized")).unwrap();
                }
            }
            "marker" => std::fs::write(
                directory.path().join("operations.initialized"),
                "newer-unsupported-schema\n",
            )
            .unwrap(),
            table => {
                let connection =
                    rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
                connection
                    .execute_batch(&format!("DROP TABLE {table};"))
                    .unwrap();
            }
        }
        assert!(
            Service::new(directory.path(), FakeHost::new()).is_err(),
            "{corruption}"
        );
        if corruption.starts_with("missing") {
            assert!(!directory.path().join("operations.sqlite").exists());
        }
    }
}
#[tokio::test]
async fn validated_schema_one_migrates_locally_without_replaying_or_extending_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let connection =
        rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    connection.execute_batch("CREATE TABLE cancellations(caller TEXT NOT NULL,operation TEXT NOT NULL,PRIMARY KEY(caller,operation)); CREATE TABLE operations(caller TEXT NOT NULL,operation TEXT NOT NULL,semantic TEXT NOT NULL,context TEXT NOT NULL,recipe TEXT NOT NULL,status TEXT NOT NULL,output_sha256 TEXT,output_descriptor TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,test INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(caller,operation)); PRAGMA user_version=1;").unwrap();
    let mut configuration = configuration("https://custom.test/images");
    configuration.profiles[0].set_revision("legacy-revision".into());
    let recipe = image_generation_backend::domain::recipe(
        &configuration.profiles[0],
        &request(&configuration.profiles[0], vec![]),
    )
    .unwrap();
    let receipt = OperationStatus {
        version: 1,
        operation_id: "legacy-accepted".into(),
        request_fingerprint: recipe.digest(),
        provider: ProviderIdentity {
            package_id: "xnmp.image-generation".into(),
            service_id: "image-generation".into(),
            major: 1,
        },
        revision: 1,
        execution: Execution::Accepted {},
        delivery: Delivery::None {},
        diagnostics: None,
    };
    connection.execute("INSERT INTO operations(caller,operation,semantic,context,recipe,status) VALUES(?,?,?,?,?,?)",rusqlite::params![caller().package_id,receipt.operation_id,"a".repeat(64),serde_json::to_string(&caller()).unwrap(),serde_json::to_string(&recipe).unwrap(),serde_json::to_string(&receipt).unwrap()]).unwrap();
    drop(connection);
    let host = FakeHost::new();
    let before = std::fs::read_dir(directory.path()).unwrap().count();
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.validate_preflight().unwrap();
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), before);
    service.activate().unwrap();
    assert_eq!(
        service
            .status("test.consumer", "legacy-accepted")
            .unwrap()
            .execution,
        Execution::Cancelled {}
    );
    assert_eq!(
        service
            .journal
            .deadline("test.consumer", "legacy-accepted")
            .unwrap(),
        0
    );
    assert!(directory.path().join("operations.initialized").is_file());
    assert!(host.processes.lock().unwrap().is_empty());
}

struct LostSealReply {
    inner: Arc<FakeHost>,
    commit_first: bool,
    failed: AtomicBool,
    seals: AtomicUsize,
    stages: AtomicUsize,
}
impl Host for LostSealReply {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.stage" {
            self.stages.fetch_add(1, Ordering::SeqCst);
        }
        if method == "host.artifacts.seal" {
            self.seals.fetch_add(1, Ordering::SeqCst);
            if !self.failed.swap(true, Ordering::SeqCst) {
                if self.commit_first {
                    self.inner.call(method, params, cancelled)?;
                }
                return Err(error("host_unavailable", "Injected lost seal reply"));
            }
        }
        self.inner.call(method, params, cancelled)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_recovers_original_seal_candidate_without_generation_or_new_stage() {
    for commit_first in [true, false] {
        let (root, count, _, server) = server(Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(LostSealReply {
            inner: FakeHost::new(),
            commit_first,
            failed: AtomicBool::new(false),
            seals: AtomicUsize::new(0),
            stages: AtomicUsize::new(0),
        });
        let service = Service::new(directory.path(), host.clone()).unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration(&root), 0, None, None)
            .unwrap();
        let prepared = request(&config.profiles[0], vec![]);
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), request.clone(), false).unwrap();
        service.wait_idle().await;
        server.join().unwrap();
        let receipt = service
            .journal
            .get("test.consumer", &request.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(matches!(receipt.execution, Execution::Succeeded { .. }));
        assert!(matches!(receipt.delivery, Delivery::Unavailable { .. }));
        let candidate = service
            .journal
            .output_descriptor("test.consumer", &request.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(candidate.sha256, hex::encode(Sha256::digest(png(42))));
        drop(service);
        // Recovery does not depend on current profiles, credentials or tokens.
        std::fs::write(directory.path().join("profiles.json"), b"broken").unwrap();
        let recovered = Service::new(directory.path(), host.clone()).unwrap();
        recovered.activate().unwrap();
        let restored = recovered
            .status("test.consumer", &request.operation_id)
            .unwrap();
        assert_eq!(restored.execution, receipt.execution);
        assert_eq!(restored.delivery, Delivery::Available { output: candidate });
        assert_eq!(recovered.start(caller(), request, false).unwrap(), restored);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(host.stages.load(Ordering::SeqCst), 1);
        assert_eq!(
            host.seals.load(Ordering::SeqCst),
            if commit_first { 1 } else { 2 }
        );
    }
}

struct HeldOutputStage {
    inner: Arc<FakeHost>,
    entered: AtomicUsize,
    released: (Mutex<bool>, std::sync::Condvar),
}
impl Host for HeldOutputStage {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.stage" {
            self.entered.fetch_add(1, Ordering::SeqCst);
            let (released, ready) = &self.released;
            let mut released = released.lock().unwrap();
            while !*released {
                released = ready.wait(released).unwrap();
            }
        }
        self.inner.call(method, params, cancelled)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_queue_never_dispatches_and_live_io_retains_worker_leases() {
    let servers: Vec<_> = (0..4).map(|_| server(Duration::ZERO)).collect();
    let untouched = TcpListener::bind("127.0.0.1:0").unwrap();
    untouched.set_nonblocking(true).unwrap();
    let unused_root = format!("http://{}/images", untouched.local_addr().unwrap());
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(HeldOutputStage {
        inner: FakeHost::new(),
        entered: AtomicUsize::new(0),
        released: (Mutex::new(false), std::sync::Condvar::new()),
    });
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        image_generation_backend::service::ServicePolicy {
            operation_budget: Duration::from_millis(500),
            ..Default::default()
        },
    )
    .unwrap();
    service.activate().unwrap();
    let mut config = configuration(&unused_root);
    for (index, (root, _, _, _)) in servers.iter().enumerate() {
        let mut profile = configuration(root).profiles.remove(0);
        if let Profile::Http { id, .. } = &mut profile {
            *id = format!("active-{index}");
        }
        config.profiles.push(profile);
    }
    let config = service.profiles.save(config, 0, None, None).unwrap();
    let mut active = vec![];
    for profile in &config.profiles[1..] {
        let prepared = request(profile, vec![]);
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), request.clone(), false).unwrap();
        active.push(request);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while host.entered.load(Ordering::SeqCst) < 4 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let queued = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), queued.clone(), false).unwrap();
    let deadline = service
        .journal
        .deadline("test.consumer", &queued.operation_id)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert_eq!(
        service
            .status("test.consumer", &queued.operation_id)
            .unwrap()
            .execution,
        Execution::Cancelled {}
    );
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    assert_eq!(host.entered.load(Ordering::SeqCst), 4);
    assert!(matches!(untouched.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    assert_eq!(
        service
            .start(caller(), queued.clone(), false)
            .unwrap()
            .execution,
        Execution::Cancelled {}
    );
    assert_eq!(
        service
            .journal
            .deadline("test.consumer", &queued.operation_id)
            .unwrap(),
        deadline
    );
    *host.released.0.lock().unwrap() = true;
    host.released.1.notify_all();
    service.wait_idle().await;
    for request in active {
        assert!(matches!(
            service
                .status("test.consumer", &request.operation_id)
                .unwrap()
                .execution,
            Execution::Succeeded { .. }
        ));
    }
    assert_eq!(
        service
            .status("test.consumer", &queued.operation_id)
            .unwrap()
            .execution,
        Execution::Cancelled {}
    );
    for (_, count, _, server) in servers {
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    service.quiesce().unwrap();
    drop(service);
    let restored = Service::new(directory.path(), host).unwrap();
    restored.activate().unwrap();
    assert_eq!(
        restored
            .journal
            .deadline("test.consumer", &queued.operation_id)
            .unwrap(),
        deadline
    );
    assert_eq!(
        restored.start(caller(), queued, false).unwrap().execution,
        Execution::Cancelled {}
    );
    assert!(matches!(untouched.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_deadline_stops_local_http_with_uncertain_remote_outcome_and_no_retry() {
    let (root, count, wire, server) = server(Duration::from_millis(350));
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        image_generation_backend::service::ServicePolicy {
            operation_budget: Duration::from_millis(150),
            ..Default::default()
        },
    )
    .unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    wire.recv_timeout(Duration::from_secs(2)).unwrap();
    let deadline = service
        .journal
        .deadline("test.consumer", &request.operation_id)
        .unwrap();
    let status = terminal(&service, &request.operation_id).await;
    assert!(matches!(status.execution, Execution::Unknown { .. }));
    assert_eq!(status.delivery, Delivery::None {});
    assert_eq!(
        service.start(caller(), request.clone(), false).unwrap(),
        status
    );
    let db = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM cancellations WHERE caller=? AND operation=?",
            rusqlite::params!["test.consumer", request.operation_id],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    drop(db);
    service.quiesce().unwrap();
    drop(service);
    let restored = Service::new(directory.path(), host).unwrap();
    restored.activate().unwrap();
    assert_eq!(
        restored
            .journal
            .deadline("test.consumer", &request.operation_id)
            .unwrap(),
        deadline
    );
    assert_eq!(restored.start(caller(), request, false).unwrap(), status);
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

struct HeldTestUpdate {
    inner: Arc<FakeHost>,
    entered: AtomicBool,
    released: (Mutex<bool>, std::sync::Condvar),
}
impl Host for HeldTestUpdate {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        if method == "host.services.test.update" {
            self.entered.store(true, Ordering::Release);
            let mut released = self.released.0.lock().unwrap();
            while !*released {
                released = self.released.1.wait(released).unwrap();
            }
        }
        self.inner.call(method, params, cancel)
    }
    fn event(&self, name: &str, params: Value) -> Result<()> {
        self.inner.event(name, params)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_unknown_is_not_idle_until_actual_io_and_leases_end() {
    let (root, count, wire, server) = server(Duration::from_millis(350));
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(HeldTestUpdate {
        inner: FakeHost::new(),
        entered: AtomicBool::new(false),
        released: (Mutex::new(false), std::sync::Condvar::new()),
    });
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        image_generation_backend::service::ServicePolicy {
            operation_budget: Duration::from_millis(150),
            ..Default::default()
        },
    )
    .unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let operation = "12345678-1234-1234-1234-123456789abc";
    service.settings("test",json!({"requestId":operation,"profileId":"http","expectedConfigurationRevision":config.document_revision})).unwrap();
    wire.recv_timeout(Duration::from_secs(2)).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !host.entered.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let receipt = service
        .journal
        .get("xnmp.image-generation", operation, None)
        .unwrap()
        .unwrap();
    assert!(matches!(receipt.execution, Execution::Unknown { .. }));
    assert!(!service
        .operation_idle("xnmp.image-generation", operation)
        .unwrap());
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service
        .discard_operation("xnmp.image-generation", operation)
        .is_err());
    *host.released.0.lock().unwrap() = true;
    host.released.1.notify_all();
    service.wait_idle().await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !service
            .operation_idle("xnmp.image-generation", operation)
            .unwrap()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        service
            .journal
            .get("xnmp.image-generation", operation, None)
            .unwrap()
            .unwrap(),
        receipt
    );
    service.quiesce().unwrap();
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_cancellation_io_retains_ownership_after_the_original_worker_ends() {
    let (root, count, wire, server) = server(Duration::from_millis(350));
    let directory = tempfile::tempdir().unwrap();
    let entered = Arc::new(AtomicBool::new(false));
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    struct Release(Arc<(Mutex<bool>, std::sync::Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0 .0.lock().unwrap() = true;
            self.0 .1.notify_all();
        }
    }
    let _release_on_failure = Release(gate.clone());
    let service = Service::with_policy(
        directory.path(),
        FakeHost::new(),
        image_generation_backend::service::ServicePolicy {
            operation_budget: Duration::from_millis(150),
            before_deadline_cancel: {
                let entered = entered.clone();
                let gate = gate.clone();
                Arc::new(move || {
                    entered.store(true, Ordering::Release);
                    let mut released = gate.0.lock().unwrap();
                    while !*released {
                        released = gate.1.wait(released).unwrap();
                    }
                })
            },
            ..Default::default()
        },
    )
    .unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    wire.recv_timeout(Duration::from_secs(2)).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !entered.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    // Explicit cancellation ends the original HTTP worker while its deadline
    // timer remains blocked in independently owned cancellation metadata IO.
    service
        .cancel("test.consumer", &request.operation_id)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), service.wait_idle())
        .await
        .unwrap();
    let receipt = service
        .journal
        .get("test.consumer", &request.operation_id, None)
        .unwrap()
        .unwrap();
    assert!(matches!(receipt.execution, Execution::Unknown { .. }));
    assert!(!service
        .operation_idle("test.consumer", &request.operation_id)
        .unwrap());
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !service
            .operation_idle("test.consumer", &request.operation_id)
            .unwrap()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        service
            .journal
            .get("test.consumer", &request.operation_id, None)
            .unwrap()
            .unwrap(),
        receipt
    );
    service.quiesce().unwrap();
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_discard_uses_original_unavailable_candidate_and_commits_before_event() {
    for with_candidate in [true, false] {
        let (root, count, _, server) = server(Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(LostSealReply {
            inner: FakeHost::new(),
            commit_first: false,
            failed: AtomicBool::new(false),
            seals: AtomicUsize::new(0),
            stages: AtomicUsize::new(0),
        });
        let service = Service::new(directory.path(), host.clone()).unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration(&root), 0, None, None)
            .unwrap();
        let prepared = request(&config.profiles[0], vec![]);
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), request.clone(), false).unwrap();
        service.wait_idle().await;
        server.join().unwrap();
        let before = service
            .journal
            .get("test.consumer", &request.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(matches!(before.delivery, Delivery::Unavailable { .. }));
        let db = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
        if !with_candidate {
            db.execute("UPDATE operations SET output_descriptor=NULL", [])
                .unwrap();
        }
        let sha = service
            .journal
            .output_sha256("test.consumer", &request.operation_id)
            .unwrap();
        let events = host.inner.events.lock().unwrap().len();
        db.execute_batch("CREATE TRIGGER discard_write_failure BEFORE UPDATE ON operations BEGIN SELECT RAISE(FAIL,'injected failure'); END;").unwrap();
        assert!(service
            .discard_operation("test.consumer", &request.operation_id)
            .is_err());
        assert_eq!(host.inner.events.lock().unwrap().len(), events);
        assert_eq!(
            service
                .journal
                .get("test.consumer", &request.operation_id, None)
                .unwrap()
                .unwrap(),
            before
        );
        db.execute_batch("DROP TRIGGER discard_write_failure;")
            .unwrap();
        let discarded = service
            .discard_operation("test.consumer", &request.operation_id)
            .unwrap();
        assert_eq!(discarded.delivery, Delivery::Discarded {});
        assert_eq!(discarded.execution, before.execution);
        assert_eq!(discarded.revision, before.revision + 1);
        assert_eq!(
            service
                .discard_operation("test.consumer", &request.operation_id)
                .unwrap(),
            discarded
        );
        assert_eq!(
            service
                .journal
                .output_sha256("test.consumer", &request.operation_id)
                .unwrap(),
            sha
        );
        assert_eq!(host.seals.load(Ordering::SeqCst), 1);
        assert_eq!(host.stages.load(Ordering::SeqCst), 1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(
            host.inner.events.lock().unwrap().last().unwrap()["payload"]["status"],
            serde_json::to_value(&discarded).unwrap()
        );
        drop(db);
        service.quiesce().unwrap();
        drop(service);
        let recovered = Service::new(directory.path(), host).unwrap();
        recovered.activate().unwrap();
        assert_eq!(
            recovered
                .discard_operation("test.consumer", &request.operation_id)
                .unwrap(),
            discarded
        );
    }
}

struct HeldKnownSuccessStage {
    inner: Arc<FakeHost>,
    entered: AtomicBool,
    release: (Mutex<bool>, std::sync::Condvar),
    lose_reply: bool,
    hold_method: &'static str,
    seals: AtomicUsize,
}
impl HeldKnownSuccessStage {
    fn release(&self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}
impl Host for HeldKnownSuccessStage {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.seal" {
            self.seals.fetch_add(1, Ordering::SeqCst);
        }
        if method == self.hold_method && !self.entered.swap(true, Ordering::AcqRel) {
            let mut released = self.release.0.lock().unwrap();
            while !*released {
                released = self.release.1.wait(released).unwrap();
            }
            if self.lose_reply {
                return Err(error("host_unavailable", "Fixture stage reply lost"));
            }
        }
        self.inner.call(method, params, cancelled)
    }
    fn event(&self, name: &str, params: Value) -> Result<()> {
        self.inner.event(name, params)
    }
}
struct ReleaseKnownStage(Arc<HeldKnownSuccessStage>);
impl Drop for ReleaseKnownStage {
    fn drop(&mut self) {
        self.0.release()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn known_success_is_durable_before_held_stage_and_survives_deadline_or_lost_handoff_without_replay(
) {
    for lose_reply in [false, true] {
        let (root, count, wire, server) = server(Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(HeldKnownSuccessStage {
            inner: FakeHost::new(),
            entered: AtomicBool::new(false),
            release: (Mutex::new(false), std::sync::Condvar::new()),
            lose_reply,
            hold_method: "host.artifacts.stage",
            seals: AtomicUsize::new(0),
        });
        let _release_on_failure = ReleaseKnownStage(host.clone());
        let service = Service::with_policy(
            directory.path(),
            host.clone(),
            image_generation_backend::service::ServicePolicy {
                operation_budget: Duration::from_millis(150),
                ..Default::default()
            },
        )
        .unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration(&root), 0, None, None)
            .unwrap();
        let prepared = request(&config.profiles[0], vec![]);
        let prepared = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), prepared.clone(), false).unwrap();
        wire.recv_timeout(Duration::from_secs(2)).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while !host.entered.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
        })
        .await
        .unwrap();
        // Wait for the real short deadline cancellation transaction while byte
        // handoff remains held, not merely a fabricated cancelled flag.
        let db = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let cancelled: i64 = db
                    .query_row(
                        "SELECT COUNT(*) FROM cancellations WHERE operation=?1",
                        [&prepared.operation_id],
                        |r| r.get(0),
                    )
                    .unwrap();
                if cancelled == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await
            }
        })
        .await
        .unwrap();
        let receipt = service
            .journal
            .get("test.consumer", &prepared.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(
            matches!(receipt.execution, Execution::Succeeded { .. }),
            "Validated successful PNG was not checkpointed before held stage: {receipt:?}"
        );
        assert!(matches!(receipt.delivery, Delivery::Unavailable { .. }));
        assert_eq!(
            service
                .journal
                .output_sha256("test.consumer", &prepared.operation_id)
                .unwrap(),
            Some(hex::encode(Sha256::digest(png(42))))
        );
        assert!(service
            .journal
            .output_descriptor("test.consumer", &prepared.operation_id)
            .unwrap()
            .is_none());
        assert!(!service
            .operation_idle("test.consumer", &prepared.operation_id)
            .unwrap());
        assert_eq!(service.quiesce().unwrap_err().code, "busy");
        // Restore a durable checkpoint taken at exactly this crash boundary into
        // another isolated profile. No live provider state or output bytes copied.
        service.journal.checkpoint().unwrap();
        let crash = tempfile::tempdir().unwrap();
        for name in [
            "operations.sqlite",
            "operations.initialized",
            "profiles.json",
        ] {
            std::fs::copy(directory.path().join(name), crash.path().join(name)).unwrap();
        }
        let recovered = Service::new(crash.path(), host.clone()).unwrap();
        recovered.activate().unwrap();
        assert_eq!(
            recovered.start(caller(), prepared.clone(), false).unwrap(),
            receipt
        );
        assert_eq!(
            recovered
                .status("test.consumer", &prepared.operation_id)
                .unwrap(),
            receipt
        );
        assert!(recovered
            .operation_idle("test.consumer", &prepared.operation_id)
            .unwrap());
        recovered.quiesce().unwrap();
        drop(recovered);
        host.release();
        service.wait_idle().await;
        let completed = service
            .status("test.consumer", &prepared.operation_id)
            .unwrap();
        assert_eq!(completed.execution, receipt.execution);
        if lose_reply {
            assert!(matches!(completed.delivery, Delivery::Unavailable { .. }));
        } else {
            assert!(matches!(completed.delivery, Delivery::Available { .. }));
        }
        assert_eq!(service.start(caller(), prepared, false).unwrap(), completed);
        service.quiesce().unwrap();
        server.join().unwrap();
        assert_eq!(
            count.load(Ordering::SeqCst),
            1,
            "Paid generation replayed during handoff/recovery"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_candidate_status_never_races_the_original_owned_seal_io() {
    let (root, count, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(HeldKnownSuccessStage {
        inner: FakeHost::new(),
        entered: AtomicBool::new(false),
        release: (Mutex::new(false), std::sync::Condvar::new()),
        lose_reply: false,
        hold_method: "host.artifacts.seal",
        seals: AtomicUsize::new(0),
    });
    let _release_on_failure = ReleaseKnownStage(host.clone());
    let service = Service::new(directory.path(), host.clone()).unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let prepared = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), prepared.clone(), false).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !host.entered.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(5)).await
        }
    })
    .await
    .unwrap();
    assert!(service
        .journal
        .output_descriptor("test.consumer", &prepared.operation_id)
        .unwrap()
        .is_some());
    for _ in 0..3 {
        let status = service
            .status("test.consumer", &prepared.operation_id)
            .unwrap();
        assert!(matches!(status.execution, Execution::Succeeded { .. }));
        assert!(matches!(status.delivery, Delivery::Unavailable { .. }));
        assert!(!service
            .operation_idle("test.consumer", &prepared.operation_id)
            .unwrap());
        assert_eq!(
            host.seals.load(Ordering::SeqCst),
            1,
            "Status raced an already owned output seal"
        );
    }
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    host.release();
    service.wait_idle().await;
    assert!(matches!(
        service
            .status("test.consumer", &prepared.operation_id)
            .unwrap()
            .delivery,
        Delivery::Available { .. }
    ));
    assert_eq!(host.seals.load(Ordering::SeqCst), 1);
    service.quiesce().unwrap();
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
