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

// ---------------------------------------------------------------------------
// Plan §14.2 / §21.2: a real key never leaves the provider except in the
// outbound Authorization header. The real backend binary runs against a fake
// stdio host and loopback HTTP fixtures; everything it emits is captured.

const PROXY_VARS: [&str; 8] = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];

/// One loopback HTTP peer that records the raw request it receives and answers
/// with a scripted response. It accepts at most one connection.
struct Recorder {
    address: std::net::SocketAddr,
    received: std::sync::mpsc::Receiver<String>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Recorder {
    fn new(response: impl Fn(&str) -> String + Send + 'static) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let serving = listener;
        let (tx, received) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            let mut stream = loop {
                match serving.accept() {
                    Ok((stream, _)) => break stream,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() > deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("Recorder accept failed: {e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = vec![];
            let mut chunk = [0; 8192];
            let end = loop {
                let read = std::io::Read::read(&mut stream, &mut chunk).unwrap();
                assert!(read > 0, "Recorder peer closed before headers");
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let length = String::from_utf8_lossy(&bytes[..end])
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            while bytes.len() < end + length {
                let read = std::io::Read::read(&mut stream, &mut chunk).unwrap();
                assert!(read > 0, "Recorder peer closed before body");
                bytes.extend_from_slice(&chunk[..read]);
            }
            let request = String::from_utf8_lossy(&bytes).into_owned();
            let _ = stream.write_all(response(&request).as_bytes());
            let _ = tx.send(request);
        });
        Self {
            address,
            received,
            worker: Some(worker),
        }
    }
    /// The single request this peer received, if any.
    fn request(mut self) -> Option<String> {
        self.worker.take().unwrap().join().unwrap();
        self.received.try_recv().ok()
    }
}
fn http_response(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
        body.len()
    )
}
fn png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        16,
        16,
        image::Rgba([7, 99, 0, 255]),
    ));
    let mut bytes = std::io::Cursor::new(vec![]);
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}

/// The real backend process, answered by a minimal stdio host. Every line the
/// backend writes and all of its stderr are retained for inspection.
struct Backend {
    child: Child,
    stdin: std::process::ChildStdin,
    frames: std::sync::mpsc::Receiver<(String, Value)>,
    reader: std::thread::JoinHandle<()>,
    stderr: std::thread::JoinHandle<Vec<u8>>,
    emitted: Vec<String>,
    host_files: tempfile::TempDir,
    secrets: std::collections::HashMap<String, String>,
    sealed: std::collections::HashMap<String, Value>,
    next_id: u64,
}
impl Backend {
    fn spawn(data: &std::path::Path, env: &[(&str, String)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_image-generation-backend"));
        command
            .args(["--data-dir", data.to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in PROXY_VARS.into_iter().chain([
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "REQUEST_METHOD",
        ]) {
            command.env_remove(key);
        }
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = Child(command.spawn().unwrap());
        let stdin = child.0.stdin.take().unwrap();
        let stdout = child.0.stdout.take().unwrap();
        let mut stderr_pipe = child.0.stderr.take().unwrap();
        let stderr = std::thread::spawn(move || {
            let mut bytes = vec![];
            let _ = std::io::Read::read_to_end(&mut stderr_pipe, &mut bytes);
            bytes
        });
        let (tx, frames) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let frame: Value = serde_json::from_str(&line).unwrap();
                if tx.send((line, frame)).is_err() {
                    break;
                }
            }
        });
        let mut backend = Self {
            child,
            stdin,
            frames,
            reader,
            stderr,
            emitted: vec![],
            host_files: tempfile::tempdir().unwrap(),
            secrets: Default::default(),
            sealed: Default::default(),
            next_id: 1,
        };
        let init = backend.call("initialize", json!({"protocolVersion":1,"hostControl":{"token":"b".repeat(64)},"processService":true,"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1}}));
        assert_eq!(init["result"]["ready"], false, "{init}");
        let ready = backend.call("lifecycle.activate", json!({}));
        assert_eq!(ready["result"]["ready"], true, "{ready}");
        backend
    }
    fn write(&mut self, frame: Value) {
        writeln!(self.stdin, "{frame}").unwrap();
        self.stdin.flush().unwrap();
    }
    /// Sends one request and serves reverse host calls until its reply arrives.
    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let (line, frame) = self
                .frames
                .recv_timeout(Duration::from_secs(30))
                .expect("Backend frame timed out");
            self.emitted.push(line);
            if frame["id"] == id {
                return frame;
            }
            if let (Some(reverse), Some(method)) = (frame["id"].as_str(), frame["method"].as_str())
            {
                let reply = match self.host(method, &frame["params"]) {
                    Ok(result) => json!({"jsonrpc":"2.0","id":reverse,"result":result}),
                    Err(code) => {
                        json!({"jsonrpc":"2.0","id":reverse,"error":{"code":-32000,"message":"Fake host refused","data":{"code":code}}})
                    }
                };
                self.write(reply);
            }
        }
    }
    fn host(&mut self, method: &str, p: &Value) -> std::result::Result<Value, &'static str> {
        match method {
            "host.credentials.put" => {
                let id = format!("secret-{}", self.secrets.len() + 1);
                self.secrets
                    .insert(id.clone(), p["key"].as_str().unwrap().into());
                Ok(json!({"id":id}))
            }
            "host.credentials.get" => self
                .secrets
                .get(p["id"].as_str().unwrap())
                .map(|key| json!({"key":key}))
                .ok_or("not_found"),
            "host.credentials.remove" => Ok(json!({"removed":true})),
            "host.artifacts.stage" => {
                let handle = format!("stage-{}", p["operationId"].as_str().unwrap());
                let path = self.host_files.path().join(&handle);
                std::fs::write(&path, []).unwrap();
                Ok(json!({"handle":handle,"path":path}))
            }
            "host.artifacts.seal" => {
                let handle = p["handle"].as_str().unwrap().to_owned();
                let bytes =
                    std::fs::read(self.host_files.path().join(&handle)).map_err(|_| "not_found")?;
                let descriptor = json!({"handle":handle,"sha256":hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes)),"byteLength":bytes.len(),"mediaType":"image/png"});
                self.sealed.insert(handle, descriptor.clone());
                Ok(descriptor)
            }
            "host.artifacts.read" => {
                let handle = p["artifact"]["handle"].as_str().unwrap();
                let descriptor = self.sealed.get(handle).ok_or("not_found")?;
                Ok(json!({"path":self.host_files.path().join(handle),"artifact":descriptor}))
            }
            _ => Err("method_not_found"),
        }
    }
    fn invoke(&mut self, method: &str, request: Value) -> Value {
        let caller =
            json!({"packageId":"test.consumer","packageDigest":"a".repeat(64),"incarnation":1});
        let reply = self.call(
            &format!("services.image-generation.v1.{method}"),
            json!({"caller":caller,"request":request}),
        );
        assert!(reply.get("error").is_none(), "{method}: {reply}");
        reply["result"].clone()
    }
    /// Saves one HTTP profile through the real settings path and stores `key`
    /// through the write-only credential command.
    fn configure(&mut self, base_url: &str, key: &str) -> String {
        let saved = self.call("settings.save", json!({"expectedRevision":0,"configuration":{"schemaVersion":1,"documentRevision":0,"defaultConnectionId":"http","profiles":[{"transport":"openai-images","id":"http","name":"Custom","recipeRevision":"","baseUrl":base_url,"defaultModel":"custom-image-model","allowInsecureHttp":false,"credential":{"kind":"none"}}]}}));
        assert!(saved.get("error").is_none(), "{saved}");
        let stored = self.call(
            "settings.credential.set",
            json!({"profileId":"http","key":key,"expectedRevision":1}),
        );
        assert_eq!(
            stored["result"]["profiles"][0]["hasCredential"], true,
            "{stored}"
        );
        stored["result"]["profiles"][0]["recipeRevision"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    /// Runs one generation to a terminal receipt through the public service.
    fn generate(&mut self, revision: &str) -> Value {
        let request = json!({"operationId":image_generation_backend::profiles::nonce().unwrap(),"connectionId":"http","expectedConnectionRevision":revision,"model":"custom-image-model","prompt":"Keep both hats","inputs":[],"options":{"size":"1024x1024","quality":"low","background":"opaque"}});
        let preparation = self.invoke("prepare", request.clone());
        let mut start = request.clone();
        start["preparationToken"] = preparation["preparationToken"].clone();
        start["effectiveRecipeDigest"] = preparation["effectiveRecipeDigest"].clone();
        self.invoke("start", start);
        for _ in 0..1000 {
            let status = self.invoke("status", json!({"operationId":request["operationId"]}));
            if !matches!(
                status["execution"]["state"].as_str(),
                Some("accepted" | "running")
            ) {
                return status;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("Generation did not settle");
    }
    /// Closes stdin, waits for a clean exit and returns everything observable.
    fn finish(mut self) -> (Vec<String>, String) {
        drop(self.stdin);
        assert!(self.child.0.wait().unwrap().success());
        self.reader.join().unwrap();
        self.emitted
            .extend(self.frames.try_iter().map(|(line, _)| line));
        let stderr = String::from_utf8_lossy(&self.stderr.join().unwrap()).into_owned();
        (self.emitted, stderr)
    }
}
fn files_containing(root: &std::path::Path, needle: &str) -> Vec<std::path::PathBuf> {
    let mut found = vec![];
    let mut pending = vec![root.to_path_buf()];
    let mut seen = 0;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                seen += 1;
                let bytes = std::fs::read(&path).unwrap();
                if bytes.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                    found.push(path);
                }
            }
        }
    }
    assert!(seen > 0, "no persisted state was inspected");
    found
}

/// A loopback listener that must never be contacted.
struct Untouched(std::net::TcpListener);
impl Untouched {
    fn new() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        Self(listener)
    }
    fn address(&self) -> std::net::SocketAddr {
        self.0.local_addr().unwrap()
    }
    fn assert_untouched(&self) {
        assert!(
            matches!(self.0.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "{} was contacted",
            self.address()
        );
    }
}

enum Route {
    /// The configured loopback origin answers directly with this status.
    Direct(&'static str),
    /// The origin redirects to a second loopback origin.
    Redirect,
    /// HTTP_PROXY/ALL_PROXY point at a recorder that answers 5xx.
    PlainProxy,
    /// HTTPS_PROXY/ALL_PROXY point at a recorder for an HTTPS root.
    TunnelProxy,
}

/// Runs one fixture and asserts that the canary key appears nowhere the
/// provider writes except (a) the one write-only `host.credentials.put`
/// reverse request and (b) the Authorization header the intended peer gets.
fn assert_key_contained(route: Route, expected: (&str, Option<&str>)) {
    // Shaped like a real key, with log-marker-like text that a careless
    // formatter or redactor might treat specially.
    let key = format!(
        "sk-te-canary-{}-[ERROR]-Bearer:",
        image_generation_backend::profiles::nonce().unwrap()
    );
    let echo = |status: &'static str| {
        let key = key.clone();
        move |request: &str| {
            let body = json!({"error":{"message":format!("Incorrect API key provided: {key}"),"echo":request}}).to_string();
            http_response(status, &format!("X-Echo-Key: {key}\r\n"), &body)
        }
    };
    let image = json!({"data":[{"b64_json":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, png())}]}).to_string();
    let data = tempfile::tempdir().unwrap();
    let mut env = vec![];
    let untouched = Untouched::new();
    let (base_url, peer, target) = match route {
        Route::Direct(status) => {
            let origin = if status.starts_with("200") {
                Recorder::new(move |_| http_response(status, "", &image))
            } else {
                Recorder::new(echo(status))
            };
            let root = format!("http://{}/vendor/v1/images/", origin.address);
            (
                root,
                origin,
                "POST /vendor/v1/images/generations ".to_owned(),
            )
        }
        Route::Redirect => {
            let location = format!("http://{}/steal?key={key}", untouched.address());
            let origin = Recorder::new(move |_| {
                http_response(
                    "307 Temporary Redirect",
                    &format!("Location: {location}\r\n"),
                    "{}",
                )
            });
            let root = format!("http://{}/vendor/v1/images", origin.address);
            (
                root,
                origin,
                "POST /vendor/v1/images/generations ".to_owned(),
            )
        }
        Route::PlainProxy => {
            let proxy = Recorder::new(echo("502 Bad Gateway"));
            let url = format!("http://{}", proxy.address);
            env = vec![("HTTP_PROXY", url.clone()), ("ALL_PROXY", url)];
            let root = format!("http://{}/vendor/v1/images", untouched.address());
            let target = format!("POST {root}/generations ");
            (root, proxy, target)
        }
        Route::TunnelProxy => {
            let proxy = Recorder::new(echo("403 Forbidden"));
            let url = format!("http://{}", proxy.address);
            env = vec![("HTTPS_PROXY", url.clone()), ("ALL_PROXY", url)];
            let root = "https://images.invalid/vendor/v1/images".to_owned();
            (root, proxy, "CONNECT images.invalid:443 ".to_owned())
        }
    };
    let mut backend = Backend::spawn(data.path(), &env);
    let revision = backend.configure(&base_url, &key);
    let status = backend.generate(&revision);
    let settings = backend.call("settings.read", json!({}));
    let described = backend.invoke("describe", json!({}));
    let checked = backend.call("settings.check", json!({"profileId":"http"}));
    assert_eq!(checked["result"]["available"], true, "{checked}");
    let (emitted, stderr) = backend.finish();
    // The intended peer saw the configured request target, carrying the key
    // only in its Authorization header (a CONNECT tunnel sees no key at all).
    let request = peer.request().expect("intended peer was never contacted");
    assert!(request.starts_with(&target), "{request}");
    if target.starts_with("CONNECT") {
        assert!(!request.contains(&key), "tunnel proxy saw the key");
        assert!(!request.to_ascii_lowercase().contains("authorization"));
    } else {
        assert_eq!(request.matches(&key).count(), 1, "{request}");
        assert!(request
            .lines()
            .any(|line| line.eq_ignore_ascii_case(&format!("authorization: Bearer {key}"))));
    }
    untouched.assert_untouched();
    // Outcome is the classified safe error, never the echoed body.
    assert_eq!(status["execution"]["state"], expected.0, "{status}");
    assert_eq!(
        status["execution"]["error"]["code"].as_str(),
        expected.1,
        "{status}"
    );
    for value in [&status, &settings, &described, &checked] {
        let text = value.to_string();
        assert!(!text.contains(&key), "{text}");
        assert!(!text.contains("Incorrect API key"), "{text}");
    }
    // Every provider-written frame (replies, events, reverse requests) is
    // key-free except the single write-only secret store request.
    let leaking: Vec<_> = emitted.iter().filter(|line| line.contains(&key)).collect();
    assert_eq!(leaking.len(), 1, "{leaking:#?}");
    let put: Value = serde_json::from_str(leaking[0]).unwrap();
    assert_eq!(put["method"], "host.credentials.put");
    assert_eq!(put["params"]["key"], key);
    assert!(emitted
        .iter()
        .all(|line| !line.contains("Incorrect API key")));
    assert!(!stderr.contains(&key), "{stderr}");
    assert!(!stderr.contains("Incorrect API key"), "{stderr}");
    assert_eq!(
        files_containing(data.path(), &key),
        Vec::<std::path::PathBuf>::new()
    );
    assert_eq!(
        files_containing(data.path(), "Incorrect API key"),
        Vec::<std::path::PathBuf>::new()
    );
}

#[test]
fn real_key_reaches_only_the_authorization_header_on_success() {
    assert_key_contained(Route::Direct("200 OK"), ("succeeded", None));
}
#[test]
fn real_key_is_not_echoed_from_rejected_or_failed_provider_responses() {
    assert_key_contained(
        Route::Direct("401 Unauthorized"),
        ("failed", Some("provider_rejected")),
    );
    assert_key_contained(
        Route::Direct("500 Internal Server Error"),
        ("unknown", Some("remote_outcome_unknown")),
    );
}
#[test]
fn real_key_is_not_sent_across_a_redirect_to_another_origin() {
    assert_key_contained(Route::Redirect, ("failed", Some("provider_rejected")));
}
/// reqwest honours HTTP(S)_PROXY/ALL_PROXY (curl semantics, no loopback
/// bypass), which the plan's §18.3 inheritance rule keeps. A plain-HTTP root is
/// forwarded to the proxy with the configured absolute target; an HTTPS root is
/// tunnelled so the proxy never sees the key. Neither proxy body is forwarded.
#[test]
fn environment_proxies_use_the_configured_root_and_never_expose_the_key_further() {
    assert_key_contained(
        Route::PlainProxy,
        ("unknown", Some("remote_outcome_unknown")),
    );
    assert_key_contained(
        Route::TunnelProxy,
        ("unknown", Some("remote_outcome_unknown")),
    );
}
