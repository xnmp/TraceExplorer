//! A real provider subprocess must retain a completed image while ordinary
//! settings reads occupy every normal reverse-RPC slot. HTTP and host IO here
//! are local fixtures; no account or remote provider is used.
use base64::{engine::general_purpose::STANDARD, Engine};
use image_generation_backend::{
    domain::{Configuration, Credential, Profile},
    error::{error, Result},
    host::Host,
    service::Service,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Cursor, Read, Write},
    net::TcpListener,
    process::{Command, Stdio},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::Duration,
};

struct NoHost;
impl Host for NoHost {
    fn call(&self, _: &str, _: Value, _: &AtomicBool) -> Result<Value> {
        Err(error("unexpected", "Setup attempted external IO"))
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
fn write(stdin: &mut std::process::ChildStdin, frame: Value) {
    writeln!(stdin, "{frame}").unwrap();
    stdin.flush().unwrap();
}
fn receive(frames: &mpsc::Receiver<Value>) -> Value {
    frames
        .recv_timeout(Duration::from_secs(5))
        .expect("Provider frame timed out")
}
fn rpc(
    stdin: &mut std::process::ChildStdin,
    frames: &mpsc::Receiver<Value>,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    write(
        stdin,
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    );
    loop {
        let frame = receive(frames);
        if frame["id"] == id {
            assert!(frame.get("error").is_none(), "{frame}");
            return frame["result"].clone();
        }
        assert_eq!(frame["method"], "event", "Unexpected reverse IO: {frame}");
    }
}

#[tokio::test]
async fn completed_http_image_survives_all_normal_reverse_slots_being_occupied() {
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        2,
        2,
        image::Rgba([0, 0, 255, 255]),
    ))
    .write_to(&mut png, image::ImageFormat::Png)
    .unwrap();
    let png = png.into_inner();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/images", listener.local_addr().unwrap());
    let (seen, request_seen) = mpsc::channel();
    let (release, respond) = mpsc::channel();
    let body = json!({"data":[{"b64_json":STANDARD.encode(&png)}]}).to_string();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut input = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        input.read_line(&mut line).unwrap();
        assert_eq!(line, "POST /images/generations HTTP/1.1\r\n");
        let mut length = None;
        loop {
            line.clear();
            input.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = Some(value.trim().parse::<usize>().unwrap());
            }
        }
        let length = length.unwrap();
        assert!(length < 64 * 1024);
        let mut request = vec![0; length];
        input.read_exact(&mut request).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&request).unwrap()["model"],
            "fixture-image"
        );
        seen.send(()).unwrap();
        respond.recv_timeout(Duration::from_secs(5)).unwrap();
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        stream.flush().unwrap();
        listener.set_nonblocking(true).unwrap();
        listener
    });
    let directory = tempfile::tempdir().unwrap();
    let service = Service::new(directory.path(), Arc::new(NoHost)).unwrap();
    service.activate().unwrap();
    let profile = |id: &str, credential| Profile::Http {
        id: id.into(),
        name: id.into(),
        recipe_revision: String::new(),
        base_url: base.clone(),
        default_model: "fixture-image".into(),
        allow_insecure_http: false,
        credential,
    };
    let config = service
        .profiles
        .save(
            Configuration {
                schema_version: 1,
                document_revision: 0,
                default_connection_id: Some("generation".into()),
                profiles: vec![
                    profile("generation", Credential::None),
                    profile(
                        "check",
                        Credential::Secret {
                            id: "fixture-secret".into(),
                        },
                    ),
                ],
            },
            0,
            Some(("check", "fixture-secret")),
            None,
        )
        .unwrap();
    drop(service);
    let mut child = Child(
        Command::new(env!("CARGO_BIN_EXE_image-generation-backend"))
            .args(["--data-dir", directory.path().to_str().unwrap()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut stdin = child.0.stdin.take().unwrap();
    let stdout = child.0.stdout.take().unwrap();
    let (tx, frames) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                break;
            }
        }
    });
    rpc(
        &mut stdin,
        &frames,
        1,
        "initialize",
        json!({"protocolVersion":1,"processService":true,"hostControl":{"token":"b".repeat(64)},"serviceService":{"version":1},"artifactService":{"version":1},"credentialService":{"version":1},"jobService":{"version":1}}),
    );
    assert_eq!(
        rpc(&mut stdin, &frames, 2, "lifecycle.activate", json!({}))["ready"],
        true
    );
    let caller =
        json!({"packageId":"test.consumer","packageDigest":"a".repeat(64),"incarnation":1});
    let mut request = json!({"operationId":"held-success","connectionId":"generation","expectedConnectionRevision":config.profiles[0].revision(),"model":"fixture-image","prompt":"Offline fixture","inputs":[],"options":{"size":"1024x1024","quality":"low","background":"auto","resolution":null,"aspectRatio":null}});
    let preparation = rpc(
        &mut stdin,
        &frames,
        3,
        "services.image-generation.v1.prepare",
        json!({"caller":caller,"request":request}),
    );
    request["preparationToken"] = preparation["preparationToken"].clone();
    request["effectiveRecipeDigest"] = preparation["effectiveRecipeDigest"].clone();
    assert_eq!(
        rpc(
            &mut stdin,
            &frames,
            4,
            "services.image-generation.v1.start",
            json!({"caller":caller,"request":request})
        )["execution"]["state"],
        "accepted"
    );
    request_seen.recv_timeout(Duration::from_secs(5)).unwrap();
    for id in 100..128 {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"settings.check","params":{"profileId":"check"}}),
        );
    }
    let mut checks = vec![];
    while checks.len() < 28 {
        let frame = receive(&frames);
        assert_eq!(frame["method"], "host.credentials.get", "{frame}");
        checks.push(frame["id"].clone());
    }
    release.send(()).unwrap();
    let stage = directory.path().join("fixture-output.png");
    std::fs::write(&stage, []).unwrap();
    let handle = "e".repeat(48);
    let descriptor = json!({"handle":handle,"sha256":hex::encode(Sha256::digest(&png)),"byteLength":png.len(),"mediaType":"image/png"});
    let mut sealed = 0;
    let result = loop {
        let frame = receive(&frames);
        match frame["method"].as_str() {
            Some("host.artifacts.stage") => write(
                &mut stdin,
                json!({"jsonrpc":"2.0","id":frame["id"],"result":{"handle":handle,"path":stage}}),
            ),
            Some("host.artifacts.seal") => {
                assert_eq!(std::fs::read(&stage).unwrap(), png);
                sealed += 1;
                write(
                    &mut stdin,
                    json!({"jsonrpc":"2.0","id":frame["id"],"result":descriptor}),
                );
            }
            Some("event") => break frame["params"]["payload"]["status"].clone(),
            _ => panic!("Unexpected frame while configuration reads were held: {frame}"),
        }
    };
    assert_eq!(sealed, 1);
    assert_eq!(result["execution"]["state"], "succeeded");
    assert_eq!(result["delivery"]["state"], "available");
    assert_eq!(result["delivery"]["output"], descriptor);
    let listener = server.join().unwrap();
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "Provider repeated mock HTTP dispatch"
    );
    for id in checks {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"result":{"key":"fixture-key"}}),
        );
    }
    for _ in 0..28 {
        let frame = receive(&frames);
        assert_eq!(frame["result"]["available"], true, "{frame}");
    }
    // The terminal event precedes the worker's lease release, so quiesce may
    // briefly report busy; it must drain without any further reverse IO.
    for id in 5.. {
        write(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"lifecycle.quiesce","params":{}}),
        );
        let frame = receive(&frames);
        assert_eq!(frame["id"], id, "Unexpected reverse IO: {frame}");
        if frame["result"]["idle"] == true {
            break;
        }
        assert_eq!(frame["error"]["data"]["code"], "busy", "{frame}");
        assert!(id < 200, "Completed image worker never drained");
        std::thread::sleep(Duration::from_millis(5));
    }
}
