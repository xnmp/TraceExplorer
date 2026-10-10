use super::*;

const THREAD: &str = "01234567-89ab-7cde-8f01-23456789abcd";
const PNG: &[u8] = include_bytes!("fixtures/source32.png");

fn request(dir: &Path, source: Option<&Path>) -> ImageRequest {
    ImageRequest {
        batch: None,
        backend: ImageBackend::Codex,
        codex_path: String::new(),
        source_path: source.map(|path| path.to_string_lossy().into_owned()),
        expected_source_digest: None,
        reference_paths: vec![],
        expected_reference_digests: vec![],
        prompt: "Preserve the face; add a warm lantern".into(),
        output_dir: dir.to_string_lossy().into_owned(),
        output_filename: "result.png".into(),
        model: "gpt-image-2".into(),
        size: "auto".into(),
        resolution: None,
        aspect_ratio: None,
        quality: "auto".into(),
        background: "auto".into(),
        retry_of: None,
    }
}

fn events(id: &str) -> Vec<u8> {
    format!("{}\n{}\n", json!({"type":"thread.started","thread_id":id}), json!({"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3,"private_field":"secret"}})).into_bytes()
}

#[test]
fn cli_protocol_retains_only_completed_thread_identity_and_numeric_usage() {
    let turn = completed_turn(&events(THREAD)).unwrap();
    assert_eq!(turn.thread_id.as_deref(), Some(THREAD));
    assert_eq!(turn.usage, json!({"input_tokens":12,"output_tokens":3}));
}

#[test]
fn unsuccessful_and_malformed_cli_streams_are_not_outputs() {
    for bytes in [
        b"not JSON\n".to_vec(),
        events("../../elsewhere"),
        b"{\"type\":\"turn.completed\"}\n".to_vec(),
        format!("{}\n", json!({"type":"thread.started","thread_id":THREAD})).into_bytes(),
        [events(THREAD), b"{\"type\":\"turn.failed\"}\n".to_vec()].concat(),
        [events(THREAD), events(THREAD)].concat(),
    ] {
        assert!(completed_turn(&bytes).is_err());
    }
}

#[test]
fn a_missing_generated_thread_is_distinguished_from_a_thread_without_a_png() {
    let home = crate::test_support::tempdir().unwrap();
    assert!(matches!(
        read_generated_image(home.path(), THREAD),
        Err(Discovery::NoThreadOutput)
    ));
    std::fs::create_dir(home.path().join("generated_images")).unwrap();
    assert!(matches!(
        read_generated_image(home.path(), THREAD),
        Err(Discovery::NoThreadOutput)
    ));
    let directory = home.path().join("generated_images").join(THREAD);
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("notes.txt"), b"not an image").unwrap();
    assert!(matches!(
        read_generated_image(home.path(), THREAD),
        Err(Discovery::NoImage)
    ));
}

#[test]
fn generated_output_belongs_to_the_exact_thread_and_must_be_unique() {
    let home = crate::test_support::tempdir().unwrap();
    let directory = home.path().join("generated_images").join(THREAD);
    std::fs::create_dir_all(&directory).unwrap();
    let other = home.path().join("generated_images/stale-thread");
    std::fs::create_dir(&other).unwrap();
    std::fs::write(other.join("stale.png"), PNG).unwrap();
    assert!(read_generated_image(home.path(), THREAD).is_err());
    std::fs::write(directory.join("image.png"), PNG).unwrap();
    assert_eq!(read_generated_image(home.path(), THREAD).unwrap(), PNG);
    std::fs::write(directory.join("second.png"), PNG).unwrap();
    assert!(read_generated_image(home.path(), THREAD).is_err());
}

#[cfg(unix)]
#[test]
fn symlinked_output_files_and_thread_directories_are_rejected() {
    use std::os::unix::fs::symlink;
    let home = crate::test_support::tempdir().unwrap();
    let elsewhere = crate::test_support::tempdir().unwrap();
    std::fs::write(elsewhere.path().join("image.png"), PNG).unwrap();
    let directory = home.path().join("generated_images");
    std::fs::create_dir(&directory).unwrap();
    symlink(elsewhere.path(), directory.join(THREAD)).unwrap();
    assert!(read_generated_image(home.path(), THREAD).is_err());
    std::fs::remove_file(directory.join(THREAD)).unwrap();
    std::fs::create_dir(directory.join(THREAD)).unwrap();
    symlink(
        elsewhere.path().join("image.png"),
        directory.join(THREAD).join("image.png"),
    )
    .unwrap();
    assert!(read_generated_image(home.path(), THREAD).is_err());
}

#[cfg(unix)]
#[test]
fn headless_adapter_stages_captured_bytes_and_publishes_native_provenance() {
    use std::os::unix::fs::PermissionsExt;
    let home = crate::test_support::tempdir().unwrap();
    let executable = home.path().join("fake-codex");
    let directory = home.path().join("generated_images").join(THREAD);
    std::fs::create_dir_all(&directory).unwrap();
    let source = home.path().join("source.png");
    std::fs::write(&source, PNG).unwrap();
    let provider = home.path().join("provider.png");
    std::fs::write(&provider, PNG).unwrap();
    let captured = home.path().join("captured.png");
    let flags = home.path().join("flags.txt");
    std::fs::write(
        &executable,
        format!(
            r#"#!/bin/sh
if [ "$1" = login ]; then printf 'Logged in using ChatGPT\n' >&2; exit 0; fi
printf '%s\n' "$@" > '{}'
previous=''
for arg in "$@"; do
  if [ "$previous" = --image ]; then count=$((count + 1)); cp "$arg" '{}-'"$count"; fi
  previous="$arg"
done
cp '{}' '{}/image.png'
printf '%s\n' '{}' '{}'
"#,
            flags.display(),
            captured.display(),
            provider.display(),
            directory.display(),
            json!({"type":"thread.started","thread_id":THREAD}),
            json!({"type":"turn.completed","usage":{"output_tokens":3}})
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let reference = home.path().join("reference.png");
    let reference_bytes = include_bytes!("fixtures/source.png");
    std::fs::write(&reference, reference_bytes).unwrap();
    let mut request = request(home.path(), Some(&source));
    request.reference_paths = vec![reference.to_string_lossy().into_owned()];
    let inputs = capture_inputs(&request).unwrap();
    std::fs::write(&source, b"changed original after capture").unwrap();
    std::fs::write(&reference, b"changed reference after capture").unwrap();
    let db = home.path().join("trace.sqlite");
    let run = trace::begin_operation_for_test(&db, recipe(&request, &inputs)).unwrap();
    let target = validate_request(&request).unwrap();
    let control = plugin_job::JobControl::new();
    execute_recorded(&run, &target, &control, || {
        generate_at(
            &request,
            &inputs,
            &control,
            &super::super::codex_executable::resolve(executable.to_str().unwrap()).unwrap(),
            home.path(),
        )
    })
    .unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), PNG);
    assert_eq!(
        std::fs::read(format!("{}-1", captured.display())).unwrap(),
        PNG
    );
    assert_eq!(
        std::fs::read(format!("{}-2", captured.display())).unwrap(),
        reference_bytes
    );
    let flags = std::fs::read_to_string(flags).unwrap();
    assert!(flags.contains("--sandbox\nread-only"));
    assert!(flags.contains(
        "2 images are attached, numbered Image 1 to Image 2 in the order they are attached"
    ));
    assert!(!flags.contains("edit target") && !flags.contains("references"));
    let roles = &recipe(&request, &inputs).parameters["input_roles"];
    assert_eq!(roles[0]["label"], "Image 1");
    assert_eq!(roles[1]["label"], "Image 2");
    assert_eq!(roles[1]["digest"], inputs[1].digest);
    assert!(flags.contains("--disable\nshell_tool"));
    let graph =
        serde_json::to_value(trace::graph_for_path_at(&db, &target).unwrap().unwrap()).unwrap();
    assert_eq!(graph["runs"][0]["parameters"]["provider"], "codex-cli");
    assert_eq!(graph["runs"][0]["parameters"]["model"], Value::Null);
    assert_eq!(graph["runs"][0]["details"]["thread_id"], THREAD);
    assert_eq!(graph["runs"][0]["status"], "succeeded");
    assert_eq!(
        graph["runs"][0]["inputIds"].as_array().unwrap().len(),
        inputs.len()
    );
}

/// Manual, account-backed qualification; never executes in CI by default.
#[test]
#[ignore = "requires installed Codex CLI and an existing ChatGPT sign-in"]
fn live_codex_edit_records_a_real_output() {
    let source = std::env::var("TRACE_CODEX_TEST_SOURCE")
        .expect("set TRACE_CODEX_TEST_SOURCE to the smoke-test image");
    let dir = crate::test_support::tempdir().unwrap();
    let mut request = request(dir.path(), Some(Path::new(&source)));
    request.prompt =
        "Change only the mug to green; preserve geometry, white background, framing and lighting"
            .into();
    if let Ok(reference) = std::env::var("TRACE_CODEX_TEST_REFERENCE") {
        request.reference_paths = vec![reference];
        request.prompt = "Combine the two attached mugs into one studio product photograph: red mug on the left and blue mug on the right, side by side on a white background. Preserve each mug's shape, handle, and color.".into();
    }
    let inputs = capture_inputs(&request).unwrap();
    let db = dir.path().join("trace.sqlite");
    let run = trace::begin_operation_for_test(&db, recipe(&request, &inputs)).unwrap();
    let target = validate_request(&request).unwrap();
    let control = plugin_job::JobControl::new();
    execute_recorded(&run, &target, &control, || {
        generate(&request, &inputs, &control, |_| Ok(()))
    })
    .unwrap();
    let graph =
        serde_json::to_value(trace::graph_for_path_at(&db, &target).unwrap().unwrap()).unwrap();
    assert_eq!(graph["runs"][0]["status"], "succeeded");
    assert_eq!(
        graph["runs"][0]["inputIds"].as_array().unwrap().len(),
        inputs.len()
    );
    if let Ok(output) = std::env::var("TRACE_CODEX_TEST_OUTPUT") {
        std::fs::copy(&target, output).unwrap();
    }
}

#[test]
fn requested_image_settings_reach_codex_and_the_recorded_recipe() {
    let directory = crate::test_support::tempdir().unwrap();
    let mut input = request(directory.path(), None);
    input.size = "2048x1536".into();
    input.resolution = Some("2k".into());
    input.aspect_ratio = Some("4:3".into());
    assert!(validate_request(&input).is_ok());
    let task = task(&input, 0);
    assert!(task.contains("2048x1536"));
    assert!(task.contains("requested pixel dimensions"));
    let recorded = recipe(&input, &[]);
    assert_eq!(recorded.parameters["prompt"], input.prompt);
    assert_eq!(recorded.parameters["resolution"], "2k");
    assert_eq!(recorded.parameters["aspect_ratio"], "4:3");
}

/// A fake `codex` that prints a recorded `--json` stream and exits with `code`.
#[cfg(unix)]
fn recorded_codex(
    home: &Path,
    fixture: &str,
    code: i32,
) -> super::super::codex_executable::CodexExecutable {
    use std::os::unix::fs::PermissionsExt;
    let stream = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("test_support/fixtures/codex")
        .join(fixture);
    let executable = home.join("fake-codex");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nif [ \"$1\" = login ]; then printf 'Logged in using ChatGPT\\n' >&2; exit 0; fi\ncat '{}'\nexit {code}\n",
            stream.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    super::super::codex_executable::resolve(executable.to_str().unwrap()).unwrap()
}

/// Runs a recorded stream through the adapter; returns the outcome and the
/// last details it recorded for the run.
#[cfg(unix)]
fn run_recorded(
    home: &Path,
    fixture: &str,
    code: i32,
) -> (Result<GeneratedImage, AppError>, Option<Value>) {
    let executable = recorded_codex(home, fixture, code);
    let mut recorded = None;
    let result = generate_with_receipt(
        &request(home, None),
        &[],
        &plugin_job::JobControl::new(),
        &executable,
        home,
        |details| {
            recorded = Some(details.clone());
            Ok(())
        },
    );
    (result, recorded)
}

const RECORDED_THREAD: &str = "01a11dad-5c1e-7f3a-9b2d-4e6f8a0c2d41";

#[cfg(unix)]
#[test]
fn a_text_reply_without_an_image_fails_with_the_reply_and_records_it() {
    let home = crate::test_support::tempdir().unwrap();
    let (result, recorded) = run_recorded(home.path(), "refusal.jsonl", 0);
    let error = result.err().unwrap().to_string();
    assert!(
        error.starts_with("Codex replied without generating an image: “I can’t make that edit"),
        "{error}"
    );
    assert!(!error.contains("Raw details"));
    let recorded = recorded.unwrap();
    assert_eq!(recorded["stage"], "no_image");
    assert_eq!(recorded["thread_id"], RECORDED_THREAD);
    assert_eq!(recorded["usage"]["output_tokens"], 291);
    assert!(recorded["codex_reply"]["text"]
        .as_str()
        .unwrap()
        .starts_with("I can’t make that edit"));
    assert!(!recorded.to_string().contains("Considering the request"));
}

#[cfg(unix)]
#[test]
fn a_tool_success_without_a_saved_png_keeps_the_thread_id() {
    let home = crate::test_support::tempdir().unwrap();
    let directory = home.path().join("generated_images").join(RECORDED_THREAD);
    std::fs::create_dir_all(&directory).unwrap();
    let (result, recorded) = run_recorded(home.path(), "image-saved.jsonl", 0);
    let error = result.err().unwrap().to_string();
    assert_eq!(
        error,
        format!("Codex's image tool ran for thread {RECORDED_THREAD}, but no PNG was found in its output folder")
    );
    let recorded = recorded.unwrap();
    assert_eq!(recorded["stage"], "image_missing");
    assert!(recorded.get("codex_reply").is_none());
}

#[cfg(unix)]
#[test]
fn a_saved_image_succeeds_without_keeping_codexs_reply() {
    let home = crate::test_support::tempdir().unwrap();
    let directory = home.path().join("generated_images").join(RECORDED_THREAD);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("ig_0.png"), PNG).unwrap();
    let (result, _) = run_recorded(home.path(), "image-saved.jsonl", 0);
    let image = result.unwrap();
    assert_eq!(image.bytes, PNG);
    assert_eq!(image.details["stage"], "image_validated");
    assert!(image.details.get("codex_reply").is_none());
    assert!(!image.details.to_string().contains("edited image"));
}

#[cfg(unix)]
#[test]
fn a_failed_turn_reports_codexs_error_even_when_the_cli_exits_with_an_error() {
    let home = crate::test_support::tempdir().unwrap();
    let (result, recorded) = run_recorded(home.path(), "turn-failed.jsonl", 1);
    assert_eq!(
        result.err().unwrap().to_string(),
        "Codex reported an error: You've hit your usage limit. Try again at 4:05 PM."
    );
    assert_eq!(recorded.unwrap()["stage"], "turn_failed");
}

#[cfg(unix)]
#[test]
fn cut_off_and_malformed_streams_are_explained() {
    let home = crate::test_support::tempdir().unwrap();
    let (result, recorded) = run_recorded(home.path(), "truncated.jsonl", 0);
    assert_eq!(
        result.err().unwrap().to_string(),
        "Codex stopped before finishing. Its last reply: “Working on the edit now.”"
    );
    assert_eq!(recorded.unwrap()["stage"], "turn_unfinished");
    // A killed CLI with nothing to say keeps the generic advice.
    let (result, _) = run_recorded(home.path(), "truncated.jsonl", 137);
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .starts_with("Headless Codex image generation failed"));
    let (result, recorded) = run_recorded(home.path(), "malformed.jsonl", 0);
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .starts_with("Codex returned an unreadable event stream"));
    assert!(recorded.is_none());
}
