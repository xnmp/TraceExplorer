//! Real stdio + isolated PATH + fake owned-process replies. Never launches Codex.
use image_generation_backend::domain::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
const THREAD: &str = "12345678-1234-1234-1234-123456789abc";
struct Provider {
    child: std::process::Child,
    input: std::process::ChildStdin,
    frames: mpsc::Receiver<Value>,
    root: PathBuf,
    seq: u64,
    processes: usize,
    generation_calls: usize,
    stages: usize,
    case: &'static str,
    /// Whether initialization advertises `processStdin`, as newer hosts do.
    stdin_host: bool,
    /// The image turn's prompt argument and stdin, per request.
    prompts: Vec<(String, Option<String>)>,
}
impl Drop for Provider {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Provider {
    fn new(root: &Path, case: &'static str) -> Self {
        Self::start(root, case, false)
    }
    fn start(root: &Path, case: &'static str, stdin_host: bool) -> Self {
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let executable = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::write(&executable, "#!/bin/sh\nexit 99\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        )))
        .unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_image-generation-backend"))
            .args(["--data-dir", root.to_str().unwrap()])
            .env("CODEX_HOME", &home)
            .env("PATH", path)
            .env("OPENAI_API_KEY", "fixture-poison-must-be-cleared")
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
        let mut provider = Self {
            child,
            input,
            frames,
            root: root.into(),
            seq: 0,
            processes: 0,
            generation_calls: 0,
            stages: 0,
            case,
            stdin_host,
            prompts: vec![],
        };
        let mut initialize = json!({"protocolVersion":1,"validationOnly":false,"deferRecovery":true,"processService":true,"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1},"hostControl":{"token":"a".repeat(64)}});
        if stdin_host {
            initialize["processStdin"] = json!({"version":1,"maxBytes":256 * 1024});
        }
        assert_eq!(provider.rpc("initialize", initialize)["ready"], false);
        assert_eq!(provider.rpc("lifecycle.activate", json!({}))["ready"], true);
        provider
    }
    fn send(&mut self, value: Value) {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
    }
    fn response(&mut self, method: &str, params: Value) -> Value {
        self.seq += 1;
        let id = self.seq;
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}));
        loop {
            let frame: Value = self
                .frames
                .recv_timeout(Duration::from_secs(5))
                .expect("Provider frame timed out");
            if frame["method"].is_string() {
                self.host(frame);
                continue;
            }
            assert_eq!(frame["id"], id, "Unexpected response {frame}");
            return frame;
        }
    }
    fn rpc(&mut self, method: &str, params: Value) -> Value {
        let frame = self.response(method, params);
        assert!(frame.get("error").is_none(), "{frame}");
        frame["result"].clone()
    }
    fn host(&mut self, frame: Value) {
        let p = &frame["params"];
        let result = match frame["method"].as_str().unwrap() {
            "event" => return,
            "host.process.run" => {
                self.processes += 1;
                assert_eq!(
                    p["program"],
                    self.root
                        .join("bin")
                        .join(if cfg!(windows) { "codex.exe" } else { "codex" })
                        .to_string_lossy()
                        .as_ref()
                );
                for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] {
                    assert!(p["env"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|env| env[0] == key && env[1].is_null()));
                }
                let stdout = self.root.join(format!("stdout-{}", self.processes));
                let stderr = self.root.join(format!("stderr-{}", self.processes));
                let login = p["args"] == json!(["login", "status"]);
                let mut exit = 0;
                let text = if login {
                    "Logged in using ChatGPT\n".into()
                } else {
                    self.generation_calls += 1;
                    // An older host refuses the unknown field outright.
                    assert!(self.stdin_host || p.get("stdin").is_none(), "{p}");
                    self.prompts.push((
                        p["args"]
                            .as_array()
                            .unwrap()
                            .last()
                            .unwrap()
                            .as_str()
                            .unwrap()
                            .into(),
                        p["stdin"].as_str().map(str::to_owned),
                    ));
                    assert!(p["args"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|arg| arg == "--ignore-user-config"));
                    assert!(!p["args"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|arg| arg == "--model" || arg == "-m"));
                    let reply = if self.case == "success" {
                        "Successful transcript must never be persisted".into()
                    } else {
                        format!("Fixture refusal {}", "鳥".repeat(3000))
                    };
                    let mut events = vec![
                        json!({"type":"thread.started","thread_id":THREAD}),
                        json!({"type":"turn.started"}),
                        json!({"type":"item.completed","item":{"type":"agent_message","text":reply}}),
                    ];
                    if self.case == "failed" {
                        events.push(json!({"type":"turn.failed","error":{"message":"Reported fixture refusal"}}));
                        exit = 1;
                    } else if self.case != "incomplete" {
                        events.push(json!({"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4,"cached_input_tokens":2,"untrusted":"not-retained"}}));
                    }
                    if self.case == "success" {
                        let directory = self.root.join("home/generated_images").join(THREAD);
                        std::fs::create_dir_all(&directory).unwrap();
                        let mut bytes = std::io::Cursor::new(vec![]);
                        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                            16,
                            16,
                            image::Rgba([0, 0, 255, 255]),
                        ))
                        .write_to(&mut bytes, image::ImageFormat::Png)
                        .unwrap();
                        std::fs::write(directory.join("output.png"), bytes.into_inner()).unwrap();
                    }
                    events
                        .iter()
                        .map(Value::to_string)
                        .collect::<Vec<_>>()
                        .join("\n")
                        + "\n"
                };
                std::fs::write(&stdout, text).unwrap();
                std::fs::write(&stderr, []).unwrap();
                json!({"handle":format!("process-{}",self.processes),"status":exit,"stdout":stdout,"stderr":stderr})
            }
            "host.process.release" => {
                let i = p["handle"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("process-")
                    .unwrap();
                for prefix in ["stdout", "stderr"] {
                    std::fs::remove_file(self.root.join(format!("{prefix}-{i}"))).unwrap();
                }
                Value::Null
            }
            "host.artifacts.stage" => {
                self.stages += 1;
                let row = self.receipt(p["operationId"].as_str().unwrap());
                assert_eq!(row["execution"]["state"], "succeeded");
                assert_eq!(row["delivery"]["state"], "unavailable");
                assert_eq!(row["diagnostics"]["threadId"], THREAD);
                assert!(row["diagnostics"]["explanation"].is_null());
                let path = self.root.join("stage-output");
                std::fs::write(&path, []).unwrap();
                json!({"handle":"stage-output","path":path})
            }
            "host.artifacts.seal" => self.descriptor(),
            "host.artifacts.read" => {
                json!({"path":self.root.join("stage-output"),"artifact":self.descriptor()})
            }
            other => panic!("Unexpected reverse request {other}"),
        };
        self.send(json!({"jsonrpc":"2.0","id":frame["id"],"result":result}));
    }
    fn descriptor(&self) -> Value {
        let bytes = std::fs::read(self.root.join("stage-output")).unwrap();
        json!({"handle":"stage-output","sha256":hex::encode(Sha256::digest(&bytes)),"byteLength":bytes.len(),"mediaType":"image/png"})
    }
    fn receipt(&self, operation: &str) -> Value {
        let db = rusqlite::Connection::open_with_flags(
            self.root.join("operations.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let raw: String = db
            .query_row(
                "SELECT status FROM operations WHERE caller=? AND operation=?",
                rusqlite::params!["test.consumer", operation],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn prepare(&mut self) -> Value {
        let config = Configuration {
            schema_version: 1,
            document_revision: 0,
            default_connection_id: Some("cli".into()),
            profiles: vec![Profile::Codex {
                id: "cli".into(),
                name: "CLI".into(),
                recipe_revision: "".into(),
                executable_path: "".into(),
                model_selection: false,
                credential: Credential::CliSavedLogin,
            }],
        };
        let saved = self.rpc(
            "settings.save",
            json!({"expectedRevision":0,"configuration":config}),
        );
        assert_eq!(
            self.rpc("settings.check", json!({"profileId":"cli"}))["available"],
            true
        );
        let mut request = json!({"operationId":format!("cli-{}",self.case),"connectionId":"cli","expectedConnectionRevision":saved["profiles"][0]["recipeRevision"],"model":null,"prompt":"Safe fixture prompt","inputs":[],"options":{"size":"1024x1024","quality":"auto","background":"auto","resolution":null,"aspectRatio":null}});
        let preparation = self.service("prepare", request.clone());
        assert_eq!(
            preparation["effectiveRecipe"]["endpointIdentity"],
            "codex-cli:auto-discovery"
        );
        request["preparationToken"] = preparation["preparationToken"].clone();
        request["effectiveRecipeDigest"] = preparation["effectiveRecipeDigest"].clone();
        request
    }
    fn service(&mut self, method: &str, request: Value) -> Value {
        self.rpc(&format!("services.image-generation.v1.{method}"),json!({"caller":{"packageId":"test.consumer","packageDigest":"b".repeat(64),"incarnation":1},"request":request}))
    }
    fn terminal(&mut self, operation: &str) -> Value {
        for _ in 0..300 {
            let status = self.service("status", json!({"operationId":operation}));
            if !matches!(
                status["execution"]["state"].as_str(),
                Some("accepted" | "running")
            ) {
                if self.case == "success"
                    && status["execution"]["state"] == "succeeded"
                    && status["delivery"]["state"] != "available"
                {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                return status;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("CLI operation did not settle");
    }
    fn quiesce(&mut self) {
        for _ in 0..100 {
            let frame = self.response("lifecycle.quiesce", json!({}));
            if frame["result"] == json!({"ready":false,"idle":true,"checkpoint":true}) {
                return;
            }
            assert_eq!(frame["error"]["data"]["code"], "busy");
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("CLI worker did not drain");
    }
}
#[cfg(unix)]
#[test]
fn native_path_discovery_success_retains_safe_turn_facts_without_transcript() {
    for stdin_host in [false, true] {
        discovery_success(stdin_host);
    }
}
/// The task travels on stdin only when initialization advertised it.
fn discovery_success(stdin_host: bool) {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = Provider::start(directory.path(), "success", stdin_host);
    let request = provider.prepare();
    provider.service("start", request.clone());
    let status = provider.terminal(request["operationId"].as_str().unwrap());
    assert_eq!(status["execution"]["state"], "succeeded");
    assert_eq!(status["delivery"]["state"], "available");
    assert_eq!(status["diagnostics"]["threadId"], THREAD);
    assert_eq!(status["diagnostics"]["turnState"], "completed");
    assert_eq!(status["diagnostics"]["usage"]["inputTokens"], 3);
    assert!(!status.to_string().contains("Successful transcript"));
    assert_eq!(provider.generation_calls, 1);
    assert_eq!(provider.stages, 1);
    let (argument, stdin) = provider.prompts[0].clone();
    if stdin_host {
        assert_eq!(argument, "-");
        assert!(stdin.unwrap().contains("Safe fixture prompt"));
    } else {
        assert!(argument.contains("Safe fixture prompt"));
        assert_eq!(stdin, None);
    }
    provider.quiesce();
    drop(provider);
    let mut recovered = Provider::start(directory.path(), "success", stdin_host);
    assert_eq!(recovered.service("start", request), status);
    assert_eq!(recovered.generation_calls, 0);
    assert_eq!(recovered.stages, 0);
}
#[cfg(unix)]
#[test]
fn native_discovery_and_failed_turn_receipts_survive_restart_without_replay() {
    for case in ["missing", "failed", "incomplete"] {
        let directory = tempfile::tempdir().unwrap();
        let mut provider = Provider::new(directory.path(), case);
        let request = provider.prepare();
        provider.service("start", request.clone());
        let status = provider.terminal(request["operationId"].as_str().unwrap());
        assert_eq!(status["execution"]["state"], "unknown");
        assert_eq!(status["delivery"]["state"], "none");
        assert_eq!(status["diagnostics"]["threadId"], THREAD);
        assert_eq!(
            status["diagnostics"]["turnState"],
            match case {
                "failed" => "failed",
                "incomplete" => "incomplete",
                _ => "completed",
            }
        );
        let explanation = &status["diagnostics"]["explanation"];
        assert!(explanation["text"].as_str().unwrap().len() <= 4096);
        if case == "failed" {
            assert_eq!(explanation["kind"], "error");
            assert_eq!(explanation["text"], "Reported fixture refusal");
        } else {
            assert_eq!(explanation["kind"], "reply");
            assert_eq!(explanation["truncated"], true);
        }
        assert!(status["execution"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("refusal"));
        assert_eq!(provider.generation_calls, 1);
        assert_eq!(provider.stages, 0);
        assert_eq!(
            provider.receipt(request["operationId"].as_str().unwrap()),
            status
        );
        provider.quiesce();
        drop(provider);
        std::fs::write(directory.path().join("profiles.json"), b"broken").unwrap();
        let mut recovered = Provider::new(directory.path(), case);
        assert_eq!(recovered.service("start", request), status);
        assert_eq!(recovered.generation_calls, 0);
        assert_eq!(recovered.processes, 0);
    }
}
