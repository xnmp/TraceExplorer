use super::*;
use std::io::{BufRead, BufReader};

const PNG: &[u8] = include_bytes!("../icons/32x32.png");
const TEST_KEY: &str = "test-secret-do-not-record";

fn request(dir: &Path, source: Option<&Path>) -> ImageRequest {
    ImageRequest {
        backend: ImageBackend::ApiKey,
        codex_path: String::new(),
        source_path: source.map(|path| path.to_string_lossy().into_owned()),
        expected_source_digest: None,
        reference_paths: vec![],
        prompt: "Preserve the face; add a warm lantern".into(),
        output_dir: dir.to_string_lossy().into_owned(),
        output_filename: "result.png".into(),
        model: "gpt-image-2".into(),
        size: "1024x1024".into(),
        resolution: None,
        aspect_ratio: None,
        quality: "low".into(),
        background: "auto".into(),
    }
}

fn response() -> Value {
    json!({"created": 42, "data": [{"b64_json": STANDARD.encode(PNG)}], "usage": {"total_tokens": 123, "unexpected_secret": TEST_KEY}})
}
fn generated() -> GeneratedImage {
    decode_response(response(), Some("req_example".into())).unwrap()
}

fn graph(db: &Path, path: &Path) -> Value {
    serde_json::to_value(trace::graph_for_path_at(db, path).unwrap().unwrap()).unwrap()
}

#[test]
fn generation_publishes_a_png_and_retains_the_submitted_recipe_and_usage() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let request = request(dir.path(), None);
    let target = validate_request(&request).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, &[])).unwrap();
    let path = execute_recorded(&run, &target, &plugin_job::JobControl::new(), || {
        Ok(generated())
    })
    .unwrap();
    assert_eq!(path.path, target.to_string_lossy());
    assert!(path.warning.is_none());
    assert_eq!(std::fs::read(&target).unwrap(), PNG);
    let recorded = graph(&db, &target);
    assert_eq!(recorded["artifacts"].as_array().unwrap().len(), 1);
    assert_eq!(recorded["runs"][0]["inputIds"], json!([]));
    assert_eq!(recorded["runs"][0]["status"], "succeeded");
    assert_eq!(recorded["runs"][0]["parameters"]["prompt"], request.prompt);
    assert_eq!(recorded["runs"][0]["parameters"]["model"], "gpt-image-2");
    assert_eq!(recorded["runs"][0]["details"]["usage"]["total_tokens"], 123);
    assert!(!recorded.to_string().contains(TEST_KEY));
    assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".tauri-explorer-stage-")));
}

#[test]
fn edit_records_the_exact_captured_input_even_when_the_source_changes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let source = dir.path().join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let request = request(dir.path(), Some(&source));
    let input = capture_input(request.source_path.as_deref())
        .unwrap()
        .unwrap();
    std::fs::write(&source, b"changed while remote request is running").unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, std::slice::from_ref(&input)))
        .unwrap();
    let target = validate_request(&request).unwrap();
    execute_recorded(&run, &target, &plugin_job::JobControl::new(), || {
        Ok(generated())
    })
    .unwrap();
    let recorded = graph(&db, &target);
    assert_eq!(recorded["runs"][0]["operation"], "openai.image.edit");
    let source_id = recorded["runs"][0]["inputIds"][0].as_i64().unwrap();
    let source_record = recorded["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["id"] == source_id)
        .unwrap();
    assert_eq!(source_record["digest"], hex::encode(Sha256::digest(PNG)));
    assert_eq!(input.bytes, PNG);
}

#[test]
fn provider_failure_and_cancellation_keep_history_without_inventing_outputs() {
    for cancelled in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("trace.sqlite");
        let source = dir.path().join("source.png");
        std::fs::write(&source, PNG).unwrap();
        let request = request(dir.path(), Some(&source));
        let input = capture_input(request.source_path.as_deref()).unwrap();
        let run = trace::begin_operation_for_test(&db, recipe(&request, input.as_slice())).unwrap();
        let target = validate_request(&request).unwrap();
        let control = plugin_job::JobControl::new();
        if cancelled {
            assert!(control.cancel());
        }
        let result = execute_recorded(&run, &target, &control, || {
            assert!(!cancelled, "cancelled job contacted provider");
            Err(invalid("provider refused request"))
        });
        assert!(result.is_err());
        assert!(!target.exists());
        let recorded = graph(&db, &source);
        assert_eq!(recorded["artifacts"].as_array().unwrap().len(), 1);
        assert_eq!(
            recorded["runs"][0]["status"],
            if cancelled { "cancelled" } else { "failed" }
        );
    }
}

#[test]
fn an_occupied_output_is_preserved_and_the_run_fails() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let source = dir.path().join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let request = request(dir.path(), Some(&source));
    let target = validate_request(&request).unwrap();
    std::fs::write(&target, b"user's existing result").unwrap();
    let input = capture_input(request.source_path.as_deref()).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, input.as_slice())).unwrap();
    assert!(
        execute_recorded(&run, &target, &plugin_job::JobControl::new(), || panic!(
            "occupied destination contacted provider"
        ))
        .is_err()
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"user's existing result");
    assert_eq!(graph(&db, &source)["runs"][0]["status"], "failed");
}

#[test]
fn a_target_created_during_the_remote_call_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let request = request(dir.path(), None);
    let target = validate_request(&request).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, &[])).unwrap();
    assert!(
        execute_recorded(&run, &target, &plugin_job::JobControl::new(), || {
            std::fs::write(&target, b"file created by another process").unwrap();
            Ok(generated())
        })
        .is_err()
    );
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"file created by another process"
    );
    let history = serde_json::to_value(trace::recent_image_runs_at(&db).unwrap()).unwrap();
    assert_eq!(history[0]["run"]["status"], "failed");
    assert_eq!(history[0]["outputPath"], Value::Null);
}

#[test]
fn failed_generation_is_reachable_in_durable_history_without_an_image() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let request = request(dir.path(), None);
    let target = validate_request(&request).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, &[])).unwrap();
    assert!(
        execute_recorded(&run, &target, &plugin_job::JobControl::new(), || Err(
            invalid("provider failure")
        ))
        .is_err()
    );
    let history = serde_json::to_value(trace::recent_image_runs_at(&db).unwrap()).unwrap();
    assert_eq!(history[0]["run"]["status"], "failed");
    assert_eq!(history[0]["run"]["parameters"]["prompt"], request.prompt);
    assert_eq!(history[0]["outputPath"], Value::Null);
}

#[test]
fn cancellation_while_waiting_for_provider_prevents_output_publication() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let request = request(dir.path(), None);
    let target = validate_request(&request).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, &[])).unwrap();
    let control = plugin_job::JobControl::new();
    assert!(execute_recorded(&run, &target, &control, || {
        assert!(control.cancel());
        Ok(generated())
    })
    .is_err());
    assert!(!target.exists());
    let history = serde_json::to_value(trace::recent_image_runs_at(&db).unwrap()).unwrap();
    assert_eq!(history[0]["run"]["status"], "cancelled");
}

#[test]
fn published_output_is_reported_as_success_when_trace_completion_needs_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("trace.sqlite");
    let request = request(dir.path(), None);
    let target = validate_request(&request).unwrap();
    let run = trace::begin_operation_for_test(&db, recipe(&request, &[])).unwrap();
    let control = plugin_job::JobControl::new();
    let outcome = execute_with_completion(
        &run,
        &target,
        &control,
        || Ok(generated()),
        |_, _| Err(invalid("database unavailable")),
    )
    .unwrap();
    assert_eq!(outcome.path, target.to_string_lossy());
    assert!(outcome.warning.unwrap().contains("Image saved"));
    assert_eq!(std::fs::read(&target).unwrap(), PNG);
    assert!(!control.cancel(), "published job accepted cancellation");
    let history = serde_json::to_value(trace::recent_image_runs_at(&db).unwrap()).unwrap();
    assert_eq!(history[0]["run"]["status"], "uncertain");
    assert_eq!(history[0]["outputPath"], Value::Null);
    let prepared = Path::new(history[0]["preparedOutputPath"].as_str().unwrap());
    assert!(prepared.is_absolute());
    assert_eq!(
        std::fs::canonicalize(prepared).unwrap(),
        std::fs::canonicalize(&target).unwrap()
    );
    trace::reconcile_unfinished_at(&db).unwrap();
    let recorded = graph(&db, &target);
    assert_eq!(recorded["runs"][0]["status"], "succeeded");
    assert_eq!(recorded["runs"][0]["recovered"], true);
}

#[test]
fn malformed_requests_and_provider_images_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let valid = request(dir.path(), None);
    for request in [
        ImageRequest {
            prompt: " ".into(),
            ..valid.clone()
        },
        ImageRequest {
            prompt: "x".repeat(16_001),
            ..valid.clone()
        },
        ImageRequest {
            output_filename: "../escape.png".into(),
            ..valid.clone()
        },
        ImageRequest {
            output_filename: "image.jpg".into(),
            ..valid.clone()
        },
        ImageRequest {
            model: "arbitrary-model".into(),
            ..valid.clone()
        },
        ImageRequest {
            quality: "max".into(),
            ..valid.clone()
        },
    ] {
        assert!(validate_request(&request).is_err());
    }
    for value in [
        Value::Null,
        json!({"data": []}),
        json!({"data": [{"b64_json": "invalid!"}]}),
        json!({"data": [{"b64_json": STANDARD.encode(&PNG[..40])}]}),
        json!({"data": [{"b64_json": STANDARD.encode(b"not PNG")} ]}),
    ] {
        assert!(decode_response(value, None).is_err());
    }
    let invalid_source = dir.path().join("bad.png");
    std::fs::write(&invalid_source, b"not image data").unwrap();
    assert!(capture_input(invalid_source.to_str()).is_err());
    assert!(capture_input(dir.path().to_str()).is_err());
    assert!(resolve_key("secret\r\nInjected: header").is_err());
}

#[cfg(unix)]
#[test]
fn a_named_pipe_cannot_block_input_capture() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pipe.png");
    let native = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(native.as_ptr(), 0o600) }, 0);
    assert!(capture_input(path.to_str()).is_err());
}

/// Return the complete request observed by a local HTTP fixture.
fn server(body: Value) -> (String, std::thread::JoinHandle<(String, Vec<u8>)>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut headers = String::new();
        let mut length = 0;
        {
            let mut reader = BufReader::new(&mut stream);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':') {
                    if key.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
                headers.push_str(&line);
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            drop(reader);
            let body = body.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nx-request-id: req_fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            (headers, bytes)
        }
    });
    (root, thread)
}

#[test]
fn http_generation_uses_the_official_json_contract_and_decodes_the_result() {
    let dir = tempfile::tempdir().unwrap();
    let request = request(dir.path(), None);
    let (root, server) = server(response());
    let image = request_image(&root, &request, &[], TEST_KEY).unwrap();
    let (headers, bytes) = server.join().unwrap();
    assert!(headers.starts_with("POST /generations HTTP/1.1"));
    assert!(headers
        .to_ascii_lowercase()
        .contains(&format!("authorization: bearer {TEST_KEY}")));
    let payload: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(payload["model"], "gpt-image-2");
    assert_eq!(payload["prompt"], request.prompt);
    assert_eq!(payload["output_format"], "png");
    assert_eq!(image.bytes, PNG);
    assert_eq!(image.details["request_id"], "req_fixture");
}

#[test]
fn http_edit_uploads_captured_bytes_with_no_original_filename_in_the_wire_format() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("private-name.png");
    std::fs::write(&source, PNG).unwrap();
    let reference = dir.path().join("private-reference.png");
    let reference_bytes = include_bytes!("../icons/128x128.png");
    std::fs::write(&reference, reference_bytes).unwrap();
    let mut request = request(dir.path(), Some(&source));
    request.reference_paths = vec![reference.to_string_lossy().into_owned()];
    let inputs = capture_inputs(&request).unwrap();
    let (root, server) = server(response());
    request_image(&root, &request, &inputs, TEST_KEY).unwrap();
    let (headers, bytes) = server.join().unwrap();
    assert!(headers.starts_with("POST /edits HTTP/1.1"));
    assert!(headers
        .to_ascii_lowercase()
        .contains("content-type: multipart/form-data; boundary="));
    let wire = String::from_utf8_lossy(&bytes);
    assert!(wire.contains("name=\"image[]\"; filename=\"source-1.png\""));
    assert!(wire.contains("name=\"image[]\"; filename=\"source-2.png\""));
    assert!(!wire.contains("private-reference"));
    assert!(bytes
        .windows(reference_bytes.len())
        .any(|window| window == reference_bytes));
    assert!(!wire.contains("private-name"));
    assert!(bytes.windows(PNG.len()).any(|window| window == PNG));
    assert!(wire.contains(&request.prompt));
    assert!(wire.contains("Edit image 1, the primary target"));
    assert!(wire.contains("Images 2 through 2 are ordered references"));
    assert_eq!(
        recipe(&request, &inputs).parameters["submitted_prompt"],
        api_prompt(&request, 2)
    );
}

#[test]
fn reference_inputs_require_a_target_and_cannot_repeat_or_exceed_limits() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let mut request = request(dir.path(), None);
    request.reference_paths = vec![source.to_string_lossy().into_owned()];
    assert!(validate_request(&request).is_err());
    request.source_path = Some(source.to_string_lossy().into_owned());
    assert!(capture_inputs(&request).is_err());
    request.reference_paths = vec!["/unused.png".into(); 8];
    assert!(validate_request(&request).is_err());
    assert!(capture_inputs(&request).is_err());
    request.reference_paths = vec![];
    request.backend = ImageBackend::Codex;
    request.quality = "high".into();
    assert!(validate_request(&request).is_err());
}

#[test]
fn an_editor_revision_change_is_refused_before_provider_submission() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let mut request = request(dir.path(), Some(&source));
    request.expected_source_digest = Some(hex::encode(Sha256::digest(PNG)));
    assert!(capture_inputs(&request).is_ok());
    request.expected_source_digest = Some("0".repeat(64));
    assert!(capture_inputs(&request)
        .err()
        .unwrap()
        .to_string()
        .contains("changed since the editor opened"));
}

#[test]
fn custom_dimensions_are_validated_before_generation() {
    let directory = tempfile::tempdir().unwrap();
    for size in ["2048x1536", "2048x2048", "3840x2160", "1024x1024"] {
        let mut input = request(directory.path(), None);
        input.size = size.into();
        assert!(validate_request(&input).is_ok(), "{size}");
    }
    for size in [
        "",
        "0x0",
        "2047x1024",
        "4096x4096",
        "3840x3840",
        "2048x512",
        "128x128",
        "18446744073709551615x16",
        "nope",
    ] {
        let mut input = request(directory.path(), None);
        input.size = size.into();
        assert!(validate_request(&input).is_err(), "{size}");
    }
}
