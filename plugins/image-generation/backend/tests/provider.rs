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
    /// The advertised `processStdin` bound; `None` mirrors an older host.
    stdin_bound: Option<usize>,
}
impl FakeHost {
    fn new() -> Arc<Self> {
        Self::with_stdin(None)
    }
    fn with_stdin(stdin_bound: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            directory: tempfile::tempdir().unwrap(),
            artifacts: Mutex::new(HashMap::new()),
            secrets: Mutex::new(HashMap::new()),
            events: Mutex::new(vec![]),
            processes: Mutex::new(vec![]),
            stdin_bound,
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
    fn process_stdin_bound(&self) -> Option<usize> {
        self.stdin_bound
    }
    fn call(&self, method: &str, p: Value, _: &AtomicBool) -> Result<Value> {
        match method {
            "host.artifacts.read" => {
                let descriptor: ArtifactDescriptor =
                    serde_json::from_value(p["artifact"].clone()).unwrap();
                // Like the native store: an unknown or unsealed handle is a
                // generic refusal; only sealed bytes are typed missing/corrupt.
                let entries = self.artifacts.lock().unwrap();
                let (path, stored) = entries
                    .get(&descriptor.handle)
                    .filter(|(_, stored)| stored == &descriptor)
                    .ok_or_else(|| {
                        error(
                            "service_unavailable",
                            "Service state: artifact read is not granted to this operation owner",
                        )
                    })?;
                if !path.exists() {
                    return Err(error("not_found", "Sealed artifact is missing"));
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
                // Like the native store, resealing an already sealed handle is
                // idempotent and re-verifies its bytes; it never re-describes them.
                if let Some((_, sealed)) = self.artifacts.lock().unwrap().get(&handle) {
                    if bytes.len() as u64 != sealed.byte_length
                        || hex::encode(Sha256::digest(&bytes)) != sealed.sha256
                    {
                        return Err(error("corrupt", "Sealed artifact is missing or corrupt"));
                    }
                    return Ok(json!(sealed));
                }
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
                // Like the native host: a host without stdin refuses the
                // unknown field (untyped on such hosts); a supporting host
                // bounds it before spawning.
                let stdin = p
                    .get("stdin")
                    .map(|stdin| stdin.as_str().unwrap().to_owned());
                match (&stdin, self.stdin_bound) {
                    (Some(_), None) => {
                        return Err(error("service_unavailable", "Invalid host process request"))
                    }
                    (Some(stdin), Some(bound)) if stdin.len() > bound => {
                        return Err(error(
                            "invalid_request",
                            "Host process request exceeds its limits",
                        ))
                    }
                    _ => {}
                }
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
                let output = match stdin {
                    None => command.output().unwrap(),
                    Some(stdin) => {
                        let mut child = command
                            .stdin(std::process::Stdio::piped())
                            .stdout(std::process::Stdio::piped())
                            .stderr(std::process::Stdio::piped())
                            .spawn()
                            .unwrap();
                        let mut pipe = child.stdin.take().unwrap();
                        let writer = std::thread::spawn(move || {
                            let _ = pipe.write_all(stdin.as_bytes());
                        });
                        let output = child.wait_with_output().unwrap();
                        writer.join().unwrap();
                        output
                    }
                };
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
/// A one-shot test signal. Waits are bounded so a failing test reports instead
/// of leaving a blocked thread that hangs runtime shutdown.
struct Gate(Mutex<bool>, std::sync::Condvar);
impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self(Mutex::new(false), std::sync::Condvar::new()))
    }
    fn open(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
    fn wait(&self) -> bool {
        let (open, _) = self
            .1
            .wait_timeout_while(self.0.lock().unwrap(), Duration::from_secs(10), |open| {
                !*open
            })
            .unwrap();
        *open
    }
}
type Server = (
    String,
    Arc<AtomicUsize>,
    std::sync::mpsc::Receiver<String>,
    std::thread::JoinHandle<()>,
);
fn server(delay: Duration) -> Server {
    serve(Gate::new(), move || std::thread::sleep(delay))
}
/// The server answers only when `release` is used or dropped, and opens
/// `received` once a complete request is on the wire, so wall-clock budgets
/// cannot cut a request short or answer it before the test is ready.
struct HeldServer {
    root: String,
    count: Arc<AtomicUsize>,
    wire: std::sync::mpsc::Receiver<String>,
    received: Arc<Gate>,
    release: Option<std::sync::mpsc::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl HeldServer {
    fn new() -> Self {
        let (release, held) = std::sync::mpsc::channel::<()>();
        let received = Gate::new();
        let (root, count, wire, worker) = serve(received.clone(), move || {
            let _ = held.recv_timeout(Duration::from_secs(10));
        });
        Self {
            root,
            count,
            wire,
            received,
            release: Some(release),
            worker: Some(worker),
        }
    }
    /// Answer the held request and wait for the server to finish.
    fn finish(&mut self) {
        drop(self.release.take());
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
impl Drop for HeldServer {
    fn drop(&mut self) {
        drop(self.release.take());
    }
}
fn serve(received: Arc<Gate>, hold: impl FnOnce() + Send + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!(
        "http://{}/vendor/v1/images/",
        listener.local_addr().unwrap()
    );
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        // Bounded accept: a test that never dispatches must not hang its join.
        listener.set_nonblocking(true).unwrap();
        let started = std::time::Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if started.elapsed() > Duration::from_secs(10) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = vec![];
        // A client that hangs up early is reported through `count`/`wire`
        // by the test, not by a panic on this thread.
        let mut fill = |bytes: &mut Vec<u8>| {
            let mut buffer = [0; 8192];
            match stream.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    bytes.extend_from_slice(&buffer[..n]);
                    true
                }
                _ => false,
            }
        };
        let header_end = loop {
            if !fill(&mut bytes) {
                return;
            }
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
            if !fill(&mut bytes) {
                return;
            }
        }
        observed.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(String::from_utf8_lossy(&bytes).to_string());
        received.open();
        hold();
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
/// The HTTP credential is resolved before the receipt is admitted.
const HTTP_STAGES: [&str; 8] = [
    "credential_check_started",
    "credential_check_done",
    "admitted",
    "process_started",
    "process_finished",
    "output_found",
    "output_stored",
    "delivery_acquired",
];
/// Every stage is present, and the stages happened in the order given.
fn assert_in_order(timings: &std::collections::BTreeMap<String, i64>, expected: &[&str]) {
    let mut keys: Vec<_> = timings.keys().map(String::as_str).collect();
    let mut wanted = expected.to_vec();
    keys.sort_unstable();
    wanted.sort_unstable();
    assert_eq!(keys, wanted, "recorded stages");
    let times: Vec<i64> = expected.iter().map(|stage| timings[*stage]).collect();
    assert!(
        times.windows(2).all(|pair| pair[0] <= pair[1]),
        "stages out of order: {timings:?}"
    );
    assert!(times[0] > 1_600_000_000_000, "not epoch milliseconds");
}
async fn http_operation(service: &Arc<Service>, root: &str) -> (StartRequest, OperationStatus) {
    let config = service
        .profiles
        .save(configuration(root), 0, None, None)
        .unwrap();
    let prepared = request(&config.profiles[0], vec![]);
    let request = start(
        prepared.clone(),
        service.prepare(caller(), prepared).unwrap(),
    );
    service.start(caller(), request.clone(), false).unwrap();
    let status = terminal(service, &request.operation_id).await;
    (request, status)
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_http_operation_records_each_stage_in_order() {
    let (root, _, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    let (request, status) = http_operation(&service, &root).await;
    let Delivery::Available { output } = status.delivery else {
        panic!("Missing delivery")
    };
    service
        .journal
        .acknowledge(
            "test.consumer",
            &request.operation_id,
            &output.sha256,
            "acquired",
            Some("fixture-transfer"),
        )
        .unwrap();
    let timings = service
        .journal
        .timings("test.consumer", &request.operation_id)
        .unwrap();
    assert_in_order(&timings, &HTTP_STAGES);
    // A repeated acknowledgement does not move a recorded stage.
    service
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
            .journal
            .timings("test.consumer", &request.operation_id)
            .unwrap(),
        timings
    );
    server.join().unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failing_timing_writes_never_fail_the_operation() {
    let (root, _, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    service.activate().unwrap();
    service.journal.fail_timings_for_test(true);
    let (request, status) = http_operation(&service, &root).await;
    assert!(matches!(status.execution, Execution::Succeeded { .. }));
    assert!(matches!(status.delivery, Delivery::Available { .. }));
    let timings = service
        .journal
        .timings("test.consumer", &request.operation_id)
        .unwrap();
    assert_eq!(timings.keys().collect::<Vec<_>>(), vec!["admitted"]);
    server.join().unwrap();
}
#[test]
fn journal_without_timings_column_gains_it_and_keeps_its_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let mut configuration = configuration("https://custom.test/images");
    configuration.profiles[0].set_revision("legacy-revision".into());
    let prepared = request(&configuration.profiles[0], vec![]);
    let recipe = image_generation_backend::domain::recipe(&configuration.profiles[0], &prepared)
        .unwrap();
    let journal = image_generation_backend::journal::Journal::open(directory.path()).unwrap();
    journal.activate().unwrap();
    journal
        .accept(&caller(), "old-operation", &"a".repeat(64), &recipe, false)
        .unwrap();
    drop(journal);
    // The shape of a journal written before timings existed.
    let raw = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    raw.execute_batch("ALTER TABLE operations DROP COLUMN timings")
        .unwrap();
    drop(raw);
    let journal = image_generation_backend::journal::Journal::open(directory.path()).unwrap();
    journal.activate().unwrap();
    assert!(journal
        .get("test.consumer", "old-operation", None)
        .unwrap()
        .is_some());
    assert!(journal
        .timings("test.consumer", "old-operation")
        .unwrap()
        .is_empty());
    journal.record_timing("test.consumer", "old-operation", "process_started");
    let timings = journal.timings("test.consumer", "old-operation").unwrap();
    assert_eq!(timings.keys().collect::<Vec<_>>(), vec!["process_started"]);
    // Unknown operations are ignored, not an error.
    journal.record_timing("test.consumer", "no-such-operation", "process_started");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_dispatched_http_reports_unknown_without_retry() {
    let mut held = HeldServer::new();
    let root = held.root.clone();
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
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
    service
        .cancel("test.consumer", &request.operation_id)
        .unwrap();
    let status = terminal(&service, &request.operation_id).await;
    assert!(matches!(status.execution, Execution::Unknown { .. }));
    assert!(matches!(
        service.start(caller(), request, false).unwrap().execution,
        Execution::Unknown { .. }
    ));
    held.finish();
    assert_eq!(held.count.load(Ordering::SeqCst), 1);
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
/// A storage read error after the provider proved success must not downgrade
/// the paid result to unknown: the proof is committed by one transaction that
/// needs no separate prior read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_failure_after_proven_success_never_downgrades_it_to_unknown() {
    let mut held = HeldServer::new();
    let root = held.root.clone();
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
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
    // Journal reads fail from the moment the provider answers.
    service.journal.fail_reads_for_test(true);
    held.finish();
    // Journal reads are down, so observe the durable receipt directly.
    let db = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
    let mut state = String::new();
    for _ in 0..500 {
        let status: String = db
            .query_row(
                "SELECT status FROM operations WHERE operation=?",
                [&request.operation_id],
                |r| r.get(0),
            )
            .unwrap();
        state = serde_json::from_str::<Value>(&status).unwrap()["execution"]["state"]
            .as_str()
            .unwrap()
            .to_owned();
        if state != "running" && state != "accepted" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    service.journal.fail_reads_for_test(false);
    assert_eq!(state, "succeeded");
    let status = terminal(&service, &request.operation_id).await;
    assert!(matches!(status.execution, Execution::Succeeded { .. }));
    assert_eq!(held.count.load(Ordering::SeqCst), 1);
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
    let record = host.artifacts.lock().unwrap()[&descriptor.handle].clone();
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
/// Records every reverse call so a test can prove no new stage or generation.
struct CallLog {
    inner: Arc<FakeHost>,
    calls: Mutex<Vec<String>>,
}
impl CallLog {
    fn count(&self, method: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == method)
            .count()
    }
}
impl Host for CallLog {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        self.calls.lock().unwrap().push(method.into());
        self.inner.call(method, params, cancelled)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
/// Plan §21.3 #7 (provider): a sealed output corrupted in place (same length,
/// different bytes) after success leaves the proven execution untouched and
/// reports delivery as unavailable, never failed, with no replay, stage or
/// generation. Repairing the bytes restores the same delivery; once acquired,
/// later corruption cannot regress the acquisition.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sealed_output_corrupted_in_place_is_unavailable_without_replay() {
    let (root, count, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let fake = FakeHost::new();
    let host = Arc::new(CallLog {
        inner: fake.clone(),
        calls: Mutex::new(vec![]),
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
    let succeeded = terminal(&service, &request.operation_id).await;
    server.join().unwrap();
    let output = match &succeeded.delivery {
        Delivery::Available { output } => output.clone(),
        state => panic!("No sealed image: {state:?}"),
    };
    assert!(matches!(succeeded.execution, Execution::Succeeded { .. }));
    let stages = host.count("host.artifacts.stage");
    assert_eq!(stages, 1);
    let path = fake.artifacts.lock().unwrap()[&output.handle].0.clone();
    let original = std::fs::read(&path).unwrap();
    let mut corrupt = original.clone();
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 0xff;
    assert_eq!(corrupt.len() as u64, output.byte_length);
    std::fs::write(&path, &corrupt).unwrap();
    for _ in 0..2 {
        let observed = service
            .status("test.consumer", &request.operation_id)
            .unwrap();
        assert_eq!(observed.execution, succeeded.execution);
        assert!(
            matches!(observed.delivery, Delivery::Unavailable { .. }),
            "corrupt output was reported as {:?}",
            observed.delivery
        );
    }
    let duplicate = service.start(caller(), request.clone(), false).unwrap();
    assert_eq!(duplicate.execution, succeeded.execution);
    assert!(matches!(duplicate.delivery, Delivery::Unavailable { .. }));
    assert_eq!(
        service
            .cancel("test.consumer", &request.operation_id)
            .unwrap()
            .execution,
        succeeded.execution
    );
    service.wait_idle().await;
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(host.count("host.artifacts.stage"), stages);
    // The recovery attempt re-verified the original handle; it did not reseal
    // different bytes under a new identity.
    assert_eq!(fake.artifacts.lock().unwrap()[&output.handle].1, output);
    std::fs::write(&path, &original).unwrap();
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap()
            .delivery,
        Delivery::Available {
            output: output.clone()
        }
    );
    service
        .journal
        .acknowledge(
            "test.consumer",
            &request.operation_id,
            &output.sha256,
            "acquired",
            Some("fixture-transfer"),
        )
        .unwrap();
    std::fs::write(&path, &corrupt).unwrap();
    let after_ack = service
        .status("test.consumer", &request.operation_id)
        .unwrap();
    assert_eq!(after_ack.execution, succeeded.execution);
    assert_eq!(
        after_ack.delivery,
        Delivery::Acquired {
            transfer_receipt: "fixture-transfer".into()
        }
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(host.count("host.artifacts.stage"), stages);
}
/// Plan §21.3 #11: saved-login Codex runs with API-key variables populated in
/// the provider's own environment. The child observes them cleared, no auth
/// switch is attempted, and the exact fresh thread's image is selected even when
/// a newer unrelated thread image exists.
///
/// The task travels as `-` plus stdin when the host advertises stdin, and as
/// the last argument when it does not. Both runs share one test because they
/// set the process-wide CODEX_HOME.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fake_cli_preserves_launcher_runtime_order_saved_login_and_managed_image_model() {
    fake_cli_generation(None).await;
    fake_cli_generation(Some(256 * 1024)).await;
}
#[cfg(unix)]
async fn fake_cli_generation(stdin_bound: Option<usize>) {
    use std::os::unix::fs::PermissionsExt;
    let installation = tempfile::tempdir().unwrap();
    let bin = installation.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let home = installation.path().join("home");
    std::fs::create_dir(&home).unwrap();
    const AUTH: [&str; 3] = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];
    let canary = format!(
        "sk-te-env-canary-{}",
        image_generation_backend::profiles::nonce().unwrap()
    );
    struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
    let _restore = Restore(
        std::iter::once("CODEX_HOME")
            .chain(AUTH)
            .map(|key| (key, std::env::var_os(key)))
            .collect(),
    );
    std::env::set_var("CODEX_HOME", &home);
    for key in AUTH {
        std::env::set_var(key, format!("{canary}-{key}"));
    }
    let launcher = bin.join("codex");
    std::fs::write(&launcher, b"#!/usr/bin/env fake-node\n").unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = bin.join("fake-node");
    let invocations = bin.join("invocations.jsonl");
    let script=format!("#!/usr/bin/env python3\nimport os,sys,json,base64,time\nargs=sys.argv[2:]\nenv={{k:v for k,v in os.environ.items() if k in {auth:?} or 'te-env-canary' in v}}\nopen(os.path.join(os.path.dirname(os.path.realpath(__file__)),'invocations.jsonl'),'a').write(json.dumps({{'args':args,'env':env}})+'\\n')\nif args==['login','status']:\n print('Logged in using ChatGPT',file=sys.stderr)\nelse:\n assert '--ignore-user-config' in args and '--ephemeral' in args\n assert '--model' not in args and '-m' not in args\n assert args[-2]=='--'\n paths=[args[i+1] for i,a in enumerate(args) if a=='--image']\n assert len(paths)==2 and paths[0].endswith('source-1.png') and paths[1].endswith('source-2.png')\n task=sys.stdin.read() if args[-1]=='-' else args[-1]\n open(os.path.join(os.path.dirname(os.path.realpath(__file__)),'tasks.jsonl'),'a').write(json.dumps(task)+'\\n')\n assert 'equal inputs; none is the main image' in task\n thread='12345678-1234-1234-1234-123456789abc'\n images=os.path.join(os.environ['CODEX_HOME'],'generated_images')\n target=os.path.join(images,thread)\n os.makedirs(target)\n open(os.path.join(target,'output.png'),'wb').write(base64.b64decode('{right}'))\n other=os.path.join(images,'87654321-4321-4321-4321-cba987654321')\n os.makedirs(other)\n newer=os.path.join(other,'output.png')\n open(newer,'wb').write(base64.b64decode('{wrong}'))\n later=time.time()+3600\n os.utime(newer,(later,later))\n os.utime(other,(later,later))\n print(json.dumps({{'type':'thread.started','thread_id':thread}}))\n print(json.dumps({{'type':'item.completed','item':{{'type':'agent_message','text':'Successful transcript must never be persisted'}}}}))\n print(json.dumps({{'type':'turn.completed','usage':{{}}}}))\n",auth=AUTH.to_vec(),right=STANDARD.encode(png(99)),wrong=STANDARD.encode(png(7)));
    std::fs::write(&runtime, script).unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::with_stdin(stdin_bound);
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
    assert!(!persisted.contains("te-env-canary"));
    assert!(result.diagnostics.as_ref().unwrap().valid(true));
    // The exact fresh thread's image was sealed, not the newer unrelated one.
    let output = match &result.delivery {
        Delivery::Available { output } => output.clone(),
        state => panic!("No sealed CLI image: {state:?}"),
    };
    let sealed = host.artifacts.lock().unwrap()[&output.handle].0.clone();
    assert_eq!(std::fs::read(sealed).unwrap(), png(99));
    // The child saw the saved-login environment only, and no auth switch ran.
    let observed: Vec<Value> = std::fs::read_to_string(&invocations)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(observed.len(), 2);
    assert_eq!(observed[0]["args"], json!(["login", "status"]));
    for invocation in &observed {
        assert_eq!(invocation["env"], json!({}), "API key reached Codex");
    }
    let exec = observed[1]["args"].as_array().unwrap();
    assert_eq!(exec[0], "exec");
    let (_task, options) = exec.split_last().unwrap();
    for arg in options
        .iter()
        .map(|arg| arg.as_str().unwrap().to_ascii_lowercase())
    {
        for auth in ["login", "api-key", "api_key", "apikey", "auth", "token"] {
            assert!(!arg.contains(auth), "auth switch argument {arg}");
        }
    }
    let processes = host.processes.lock().unwrap();
    assert!(!json!(*processes).to_string().contains("te-env-canary"));
    assert_eq!(processes.len(), 2);
    assert_eq!(processes[0]["args"], json!(["login", "status"]));
    assert_eq!(processes[1]["program"], launcher.to_str().unwrap());
    assert!(processes[1]["env"][0][1]
        .as_str()
        .unwrap()
        .starts_with(bin.to_str().unwrap()));
    let task = service
        .prepare(caller(), request.prepared())
        .unwrap()
        .effective_recipe
        .agent_task
        .unwrap();
    let last = processes[1]["args"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    match stdin_bound {
        // `-` as the prompt argument, and the task byte for byte on stdin.
        Some(_) => {
            assert_eq!(last, "-");
            assert_eq!(processes[1]["stdin"], task);
        }
        // An older host: argv only, and no field it would refuse.
        None => {
            assert_eq!(last, task.as_str());
            assert!(processes[1].get("stdin").is_none());
        }
    }
    assert!(
        processes[0].get("stdin").is_none(),
        "login status needs no input"
    );
    let received: Vec<String> = std::fs::read_to_string(bin.join("tasks.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(received, vec![task], "Codex did not receive the exact task");
    let timings = service
        .journal
        .timings("test.consumer", &request.operation_id)
        .unwrap();
    assert_in_order(
        &timings,
        &[
            "admitted",
            "credential_check_started",
            "credential_check_done",
            "process_started",
            "process_finished",
            "output_found",
            "output_stored",
        ],
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
    released: Arc<Gate>,
}
impl Host for HeldInputGrants {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.read" {
            self.entered.send(()).unwrap();
            self.released.wait();
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
        released: Gate::new(),
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
    host.released.open();
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
    let mut held = HeldServer::new();
    let root = held.root.clone();
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
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
    assert_eq!(service.quiesce().unwrap_err().code, "busy");
    assert!(service.ready());
    drop(held.release.take());
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
    assert_eq!(held.count.load(Ordering::Acquire), 1);
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
    held.finish();
    assert_eq!(held.count.load(Ordering::Acquire), 1);
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
        "empty_with_marker",
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
            "missing" | "empty_with_marker" => {
                for name in [
                    "operations.sqlite",
                    "operations.sqlite-wal",
                    "operations.sqlite-shm",
                ] {
                    let _ = std::fs::remove_file(directory.path().join(name));
                }
                if corruption == "empty_with_marker" {
                    rusqlite::Connection::open(directory.path().join("operations.sqlite"))
                        .unwrap()
                        .execute_batch("PRAGMA journal_mode=WAL;")
                        .unwrap();
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
        if corruption == "missing" {
            assert!(!directory.path().join("operations.sqlite").exists());
        }
    }
}
/// Only `operations.initialized` proves receipts existed. A first activation
/// interrupted after taking the owner lock, or before its schema committed,
/// leaves a fresh journal that a later activation initializes.
#[tokio::test]
async fn interrupted_first_activation_is_fresh_until_the_marker_proves_receipts() {
    let usable = |directory: &std::path::Path| {
        let service = Service::new(directory, FakeHost::new()).unwrap();
        service.activate().unwrap();
        let config = service
            .profiles
            .save(configuration("https://images.test/v1/"), 0, None, None)
            .unwrap();
        let profile = &config.profiles[0];
        let recipe =
            image_generation_backend::domain::recipe(profile, &request(profile, vec![])).unwrap();
        let receipt = service
            .journal
            .accept(
                &caller(),
                "first-operation",
                &"c".repeat(64),
                &recipe,
                false,
            )
            .unwrap();
        assert!(receipt.1, "fresh journal must accept a new operation");
        assert!(directory.join("operations.initialized").is_file());
        service.quiesce().unwrap();
    };
    // An obstacle makes the first activation fail after the owner lock exists.
    let directory = tempfile::tempdir().unwrap();
    let obstacle = directory.path().join("operations.sqlite-wal");
    std::fs::create_dir(&obstacle).unwrap();
    let service = Service::new(directory.path(), FakeHost::new()).unwrap();
    assert!(service.activate().is_err());
    drop(service);
    assert!(directory.path().join("operations.owner.lock").exists());
    assert!(!directory.path().join("operations.initialized").exists());
    std::fs::remove_dir(&obstacle).unwrap();
    usable(directory.path());
    // A database whose schema transaction never committed is empty.
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("operations.owner.lock"), b"").unwrap();
    rusqlite::Connection::open(directory.path().join("operations.sqlite"))
        .unwrap()
        .execute_batch("PRAGMA journal_mode=WAL;")
        .unwrap();
    usable(directory.path());
    // Without a marker, any schema object still means a journal to validate.
    let directory = tempfile::tempdir().unwrap();
    rusqlite::Connection::open(directory.path().join("operations.sqlite"))
        .unwrap()
        .execute_batch("CREATE TABLE unrelated(x);")
        .unwrap();
    assert!(Service::new(directory.path(), FakeHost::new()).is_err());
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
    all_entered: Arc<Gate>,
    released: Arc<Gate>,
}
impl Host for HeldOutputStage {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.stage" {
            if self.entered.fetch_add(1, Ordering::SeqCst) + 1 == 4 {
                self.all_entered.open();
            }
            self.released.wait();
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
        all_entered: Gate::new(),
        released: Gate::new(),
    });
    struct Release(Arc<Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.open()
        }
    }
    let _release = Release(host.released.clone());
    // Deadlines apply only once every worker holds its proven output in stage.
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        gated_deadline(host.all_entered.clone()),
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
    tokio::task::block_in_place(|| assert!(host.all_entered.wait()));
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
    // The queued operation's own deadline cancels it while every slot is held.
    tokio::time::timeout(Duration::from_secs(5), async {
        while service
            .status("test.consumer", &queued.operation_id)
            .unwrap()
            .execution
            != (Execution::Cancelled {})
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
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
    host.released.open();
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

/// The automatic deadline really expires, but its cancellation is applied only
/// after `ready` opens: a loaded machine cannot cut the request short or let
/// the deadline win before the state under test exists. The budget leaves
/// room for admission and claim commits before dispatch.
fn gated_deadline(ready: Arc<Gate>) -> image_generation_backend::service::ServicePolicy {
    image_generation_backend::service::ServicePolicy {
        operation_budget: Duration::from_millis(1000),
        before_deadline_cancel: Arc::new(move || assert!(ready.wait())),
        ..Default::default()
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_deadline_stops_local_http_with_uncertain_remote_outcome_and_no_retry() {
    let mut held = HeldServer::new();
    let root = held.root.clone();
    let directory = tempfile::tempdir().unwrap();
    let host = FakeHost::new();
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        gated_deadline(held.received.clone()),
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
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
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
    held.finish();
    assert_eq!(held.count.load(Ordering::SeqCst), 1);
}

struct HeldTestUpdate {
    inner: Arc<FakeHost>,
    entered: AtomicBool,
    released: Arc<Gate>,
}
impl Host for HeldTestUpdate {
    fn call(&self, method: &str, params: Value, cancel: &AtomicBool) -> Result<Value> {
        if method == "host.services.test.update" {
            self.entered.store(true, Ordering::Release);
            self.released.wait();
        }
        self.inner.call(method, params, cancel)
    }
    fn event(&self, name: &str, params: Value) -> Result<()> {
        self.inner.event(name, params)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_unknown_is_not_idle_until_actual_io_and_leases_end() {
    let mut held = HeldServer::new();
    let root = held.root.clone();
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(HeldTestUpdate {
        inner: FakeHost::new(),
        entered: AtomicBool::new(false),
        released: Gate::new(),
    });
    // Released on every exit path, so a failed assertion cannot leave the
    // blocking test-update worker parked during runtime shutdown.
    struct Release(Arc<Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.open()
        }
    }
    let _release = Release(host.released.clone());
    let service = Service::with_policy(
        directory.path(),
        host.clone(),
        gated_deadline(held.received.clone()),
    )
    .unwrap();
    service.activate().unwrap();
    let config = service
        .profiles
        .save(configuration(&root), 0, None, None)
        .unwrap();
    let operation = "12345678-1234-1234-1234-123456789abc";
    service.settings("test",json!({"requestId":operation,"profileId":"http","expectedConfigurationRevision":config.document_revision})).unwrap();
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
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
    host.released.open();
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
    held.finish();
    assert_eq!(held.count.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_cancellation_io_retains_ownership_after_the_original_worker_ends() {
    let mut held = HeldServer::new();
    let root = held.root.clone();
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
            operation_budget: Duration::from_millis(1000),
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
    tokio::task::block_in_place(|| held.wire.recv_timeout(Duration::from_secs(5)).unwrap());
    tokio::time::timeout(Duration::from_secs(5), async {
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
    held.finish();
    assert_eq!(held.count.load(Ordering::SeqCst), 1);
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
    held: Arc<Gate>,
    released: Arc<Gate>,
    lose_reply: bool,
    hold_method: &'static str,
    seals: AtomicUsize,
}
impl HeldKnownSuccessStage {
    fn new(hold_method: &'static str, lose_reply: bool) -> Arc<Self> {
        Arc::new(Self {
            inner: FakeHost::new(),
            entered: AtomicBool::new(false),
            held: Gate::new(),
            released: Gate::new(),
            lose_reply,
            hold_method,
            seals: AtomicUsize::new(0),
        })
    }
    fn release(&self) {
        self.released.open()
    }
}
impl Host for HeldKnownSuccessStage {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.seal" {
            self.seals.fetch_add(1, Ordering::SeqCst);
        }
        if method == self.hold_method && !self.entered.swap(true, Ordering::AcqRel) {
            self.held.open();
            self.released.wait();
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
        let host = HeldKnownSuccessStage::new("host.artifacts.stage", lose_reply);
        let _release_on_failure = ReleaseKnownStage(host.clone());
        // The deadline expires during the held stage, never before success.
        let service = Service::with_policy(
            directory.path(),
            host.clone(),
            gated_deadline(host.held.clone()),
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
        wire.recv_timeout(Duration::from_secs(5)).unwrap();
        tokio::task::block_in_place(|| assert!(host.held.wait()));
        // Wait for the real short deadline cancellation transaction while byte
        // handoff remains held, not merely a fabricated cancelled flag.
        let db = rusqlite::Connection::open(directory.path().join("operations.sqlite")).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
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

/// What a consumer polling this operation accepts (Trace's receipt rules):
/// revisions never go back, an equal revision is an identical receipt, and a
/// terminal execution never changes or becomes non-terminal.
fn assert_consumer_accepts(observed: &[OperationStatus]) {
    let terminal = |status: &OperationStatus| {
        !matches!(
            status.execution,
            Execution::Accepted {} | Execution::Running {}
        )
    };
    for pair in observed.windows(2) {
        let (old, new) = (&pair[0], &pair[1]);
        assert!(new.revision >= old.revision, "revision regressed: {pair:?}");
        if new.revision == old.revision {
            assert_eq!(old, new, "revision reused for a different receipt");
        }
        if terminal(old) {
            assert_eq!(old.execution, new.execution, "terminal changed: {pair:?}");
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proven_success_reads_as_running_until_its_seal_outcome_is_committed() {
    for lose_reply in [false, true] {
        let (root, count, _, server) = server(Duration::ZERO);
        let directory = tempfile::tempdir().unwrap();
        let host = HeldKnownSuccessStage::new("host.artifacts.seal", lose_reply);
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
        let mut observed = vec![service.start(caller(), prepared.clone(), false).unwrap()];
        tokio::task::block_in_place(|| assert!(host.held.wait()));
        // The proof of paid success and its exact candidate are durable...
        let durable = service
            .journal
            .get("test.consumer", &prepared.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(matches!(durable.execution, Execution::Succeeded { .. }));
        assert!(service
            .journal
            .output_descriptor("test.consumer", &prepared.operation_id)
            .unwrap()
            .is_some());
        // ...but no reader is told about it while the original seal is held.
        let events = host.inner.events.lock().unwrap().len();
        for _ in 0..3 {
            let status = service
                .status("test.consumer", &prepared.operation_id)
                .unwrap();
            assert_eq!(status.execution, Execution::Running {}, "{status:?}");
            assert_eq!(status.delivery, Delivery::None {});
            observed.push(status);
            observed.push(service.start(caller(), prepared.clone(), false).unwrap());
            assert!(!service
                .operation_idle("test.consumer", &prepared.operation_id)
                .unwrap());
        }
        let cancelled = service
            .cancel("test.consumer", &prepared.operation_id)
            .unwrap();
        assert_eq!(cancelled.execution, Execution::Running {});
        observed.push(cancelled);
        assert!(service
            .discard_operation("test.consumer", &prepared.operation_id)
            .is_err());
        let sha = service
            .journal
            .output_sha256("test.consumer", &prepared.operation_id)
            .unwrap()
            .unwrap();
        assert!(service
            .acknowledge(
                "test.consumer",
                &prepared.operation_id,
                &sha,
                "discarded",
                None
            )
            .is_err());
        assert_eq!(host.inner.events.lock().unwrap().len(), events);
        assert_eq!(service.quiesce().unwrap_err().code, "busy");
        assert_eq!(
            host.seals.load(Ordering::SeqCst),
            1,
            "Status raced the owned seal"
        );
        host.release();
        service.wait_idle().await;
        // The committed seal outcome is announced: available, or honestly
        // unavailable when the original seal reply was lost.
        let announced = service
            .journal
            .get("test.consumer", &prepared.operation_id, None)
            .unwrap()
            .unwrap();
        assert!(matches!(announced.execution, Execution::Succeeded { .. }));
        if lose_reply {
            assert!(matches!(announced.delivery, Delivery::Unavailable { .. }));
        } else {
            assert!(matches!(announced.delivery, Delivery::Available { .. }));
        }
        let event = host.inner.events.lock().unwrap().last().cloned().unwrap();
        assert_eq!(
            event["payload"]["status"],
            serde_json::to_value(&announced).unwrap()
        );
        observed.push(announced);
        // Afterwards status may only restore delivery from the original seal.
        let completed = service
            .status("test.consumer", &prepared.operation_id)
            .unwrap();
        assert!(matches!(completed.delivery, Delivery::Available { .. }));
        observed.push(completed);
        assert_consumer_accepts(&observed);
        assert_eq!(
            host.seals.load(Ordering::SeqCst),
            if lose_reply { 2 } else { 1 }
        );
        service.quiesce().unwrap();
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1, "Paid generation replayed");
    }
}

/// Fakes the owned `codex` processes without running anything: login reports
/// a saved login unless the case fails it; the image turn fails with a host error.
struct CodexHostFailure {
    inner: Arc<FakeHost>,
    login: Option<&'static str>,
    turn: &'static str,
    logins: AtomicUsize,
    turns: AtomicUsize,
    login_entered: Arc<Gate>,
}
impl Host for CodexHostFailure {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method != "host.process.run" {
            return self.inner.call(method, params, cancelled);
        }
        if params["args"] != json!(["login", "status"]) {
            self.turns.fetch_add(1, Ordering::SeqCst);
            return Err(error(
                self.turn,
                "Fixture host failure during the image turn",
            ));
        }
        let index = self.logins.fetch_add(1, Ordering::SeqCst);
        match self.login {
            None => {
                let stdout = self.inner.directory.path().join(format!("login-{index}"));
                std::fs::write(&stdout, "Logged in using ChatGPT\n").unwrap();
                Ok(
                    json!({"handle":format!("login-{index}"),"status":0,"stdout":stdout,"stderr":stdout}),
                )
            }
            Some("cancel") => {
                // Like the native runtime: a cancelled wait returns a local
                // host failure, never a process result.
                self.login_entered.open();
                let started = std::time::Instant::now();
                while !cancelled.load(Ordering::Acquire)
                    && started.elapsed() < Duration::from_secs(10)
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error(
                    "host_unavailable",
                    "Host service failed or was cancelled",
                ))
            }
            Some(code) => Err(error(code, "Fixture host failure during login status")),
        }
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
/// After `codex exec` may have started, only a host rejection proven to precede
/// spawning is a definite failure; anything else could have run a paid turn and
/// stays unknown. The host's typed pre-spawn refusals are definite; an older
/// host's untyped `service_unavailable` and post-spawn `interrupted` are not.
/// `login status` never starts a turn, so its failures and cancellation are
/// definite non-executions.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_host_failures_are_unknown_after_the_turn_starts_and_definite_before_it() {
    for (login, turn, expected) in [
        (None, "service_unavailable", "unknown"),
        (None, "interrupted", "unknown"),
        (None, "protocol_error", "unknown"),
        (None, "storage_unavailable", "unknown"),
        (None, "capacity_reached", "failed"),
        (None, "not_found", "failed"),
        (None, "permission_denied", "failed"),
        (None, "invalid_request", "failed"),
        (None, "not_started", "failed"),
        (Some("host_unavailable"), "service_unavailable", "failed"),
        (Some("service_unavailable"), "service_unavailable", "failed"),
        (Some("cancel"), "service_unavailable", "cancelled"),
    ] {
        let case = format!("{login:?}/{turn}");
        let host = Arc::new(CodexHostFailure {
            inner: FakeHost::new(),
            login,
            turn,
            logins: AtomicUsize::new(0),
            turns: AtomicUsize::new(0),
            login_entered: Gate::new(),
        });
        let launcher = host.inner.directory.path().join("codex");
        std::fs::write(&launcher, b"#!/bin/sh\nexit 99\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let directory = tempfile::tempdir().unwrap();
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
        let mut prepared = request(&saved.profiles[0], vec![]);
        prepared.model = None;
        prepared.options.quality = "auto".into();
        prepared.options.background = "auto".into();
        let request = start(
            prepared.clone(),
            service.prepare(caller(), prepared).unwrap(),
        );
        service.start(caller(), request.clone(), false).unwrap();
        if login == Some("cancel") {
            tokio::task::block_in_place(|| assert!(host.login_entered.wait()));
            service
                .cancel("test.consumer", &request.operation_id)
                .unwrap();
        }
        let status = terminal(&service, &request.operation_id).await;
        match (expected, &status.execution) {
            ("unknown", Execution::Unknown { error }) => {
                assert_eq!(error.code, "remote_outcome_unknown", "{case}")
            }
            ("failed", Execution::Failed { error }) => {
                // The host's own refusal is kept; a login failure is unavailable.
                let code = if login.is_none() { turn } else { "unavailable" };
                assert_eq!(error.code, code, "{case}")
            }
            ("cancelled", Execution::Cancelled {}) => {}
            _ => panic!("{case}: expected {expected}, got {status:?}"),
        }
        assert_eq!(status.delivery, Delivery::None {}, "{case}");
        let turns = usize::from(login.is_none());
        assert_eq!(host.turns.load(Ordering::SeqCst), turns, "{case}");
        // Neither a duplicate start nor status ever runs another process.
        assert_eq!(service.start(caller(), request, false).unwrap(), status);
        assert_eq!(host.turns.load(Ordering::SeqCst), turns, "{case}");
        assert_eq!(host.logins.load(Ordering::SeqCst), 1, "{case}");
        service.quiesce().unwrap();
    }
}

/// Reads and reseals of sealed outputs fail with `failure` while it is set.
struct FlakyArtifacts {
    inner: Arc<FakeHost>,
    failure: Mutex<Option<&'static str>>,
    seals: AtomicUsize,
}
impl Host for FlakyArtifacts {
    fn call(&self, method: &str, params: Value, cancelled: &AtomicBool) -> Result<Value> {
        if method == "host.artifacts.seal" {
            self.seals.fetch_add(1, Ordering::SeqCst);
        }
        if matches!(method, "host.artifacts.read" | "host.artifacts.seal") {
            if let Some(code) = *self.failure.lock().unwrap() {
                return Err(error(code, "Fixture transient artifact failure"));
            }
        }
        self.inner.call(method, params, cancelled)
    }
    fn event(&self, name: &str, payload: Value) -> Result<()> {
        self.inner.event(name, payload)
    }
}
/// Status is a read: a transient host condition is reported to the caller but
/// never rewrites durable delivery; only a verified missing/corrupt answer may.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_artifact_failures_never_rewrite_available_delivery() {
    let (root, count, _, server) = server(Duration::ZERO);
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(FlakyArtifacts {
        inner: FakeHost::new(),
        failure: Mutex::new(None),
        seals: AtomicUsize::new(0),
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
    let available = terminal(&service, &request.operation_id).await;
    assert!(matches!(available.delivery, Delivery::Available { .. }));
    let seals = host.seals.load(Ordering::SeqCst);
    for code in [
        "capacity_reached",
        "host_unavailable",
        "busy",
        "storage_unavailable",
    ] {
        *host.failure.lock().unwrap() = Some(code);
        let failure = service
            .status("test.consumer", &request.operation_id)
            .unwrap_err();
        assert_eq!(failure.code, "storage_unavailable", "{code}");
        assert_eq!(
            service
                .journal
                .get("test.consumer", &request.operation_id, None)
                .unwrap()
                .unwrap(),
            available,
            "{code} rewrote durable delivery"
        );
        assert_eq!(host.seals.load(Ordering::SeqCst), seals, "{code}");
    }
    *host.failure.lock().unwrap() = None;
    assert_eq!(
        service
            .status("test.consumer", &request.operation_id)
            .unwrap(),
        available
    );
    // A verified answer still changes delivery, without generating again.
    *host.failure.lock().unwrap() = Some("not_found");
    let missing = service
        .status("test.consumer", &request.operation_id)
        .unwrap();
    assert_eq!(
        missing.delivery,
        Delivery::Unavailable {
            reason: "missing".into()
        }
    );
    assert_eq!(missing.execution, available.execution);
    *host.failure.lock().unwrap() = None;
    let restored = service
        .status("test.consumer", &request.operation_id)
        .unwrap();
    assert_eq!(restored.delivery, available.delivery);
    assert_consumer_accepts(&[available, missing, restored]);
    service.quiesce().unwrap();
    server.join().unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
