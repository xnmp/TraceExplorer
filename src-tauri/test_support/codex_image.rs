use super::*;

const THREAD: &str = "01234567-89ab-7cde-8f01-23456789abcd";
const PNG: &[u8] = include_bytes!("../icons/32x32.png");

fn request(dir: &Path, source: Option<&Path>) -> ImageRequest {
    ImageRequest {
        backend: ImageBackend::Codex,
        codex_path: String::new(),
        source_path: source.map(|path| path.to_string_lossy().into_owned()),
        expected_source_digest: None,
        reference_paths: vec![],
        prompt: "Preserve the face; add a warm lantern".into(),
        output_dir: dir.to_string_lossy().into_owned(),
        output_filename: "result.png".into(),
        model: "gpt-image-2".into(),
        size: "auto".into(),
        resolution: None,
        aspect_ratio: None,
        quality: "auto".into(),
        background: "auto".into(),
    }
}

fn events(id: &str) -> Vec<u8> {
    format!("{}\n{}\n", json!({"type":"thread.started","thread_id":id}), json!({"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3,"private_field":"secret"}})).into_bytes()
}

#[test]
fn cli_protocol_retains_only_completed_thread_identity_and_numeric_usage() {
    let (thread, usage) = completed_thread(&events(THREAD)).unwrap();
    assert_eq!(thread, THREAD);
    assert_eq!(usage, json!({"input_tokens":12,"output_tokens":3}));
}

#[test]
fn unsuccessful_and_malformed_cli_streams_are_not_outputs() {
    for bytes in [
        b"not JSON".to_vec(),
        events("../../elsewhere"),
        b"{\"type\":\"turn.completed\"}\n".to_vec(),
        format!("{}\n", json!({"type":"thread.started","thread_id":THREAD})).into_bytes(),
        [events(THREAD), b"{\"type\":\"turn.failed\"}\n".to_vec()].concat(),
        [events(THREAD), events(THREAD)].concat(),
    ] {
        assert!(completed_thread(&bytes).is_err());
    }
}

#[test]
fn generated_output_belongs_to_the_exact_thread_and_must_be_unique() {
    let home = tempfile::tempdir().unwrap();
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
    let home = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
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
    let home = tempfile::tempdir().unwrap();
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
    let reference_bytes = include_bytes!("../icons/128x128.png");
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
    let dir = tempfile::tempdir().unwrap();
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
        generate(&request, &inputs, &control)
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
    let directory = tempfile::tempdir().unwrap();
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
