//! Saved-login CLI uses host-owned process trees and only fresh thread output.
use super::*;
use serde_json::json;
use std::path::PathBuf;
struct ProcessOutput {
    stdout: Vec<u8>,
    exit_status: i64,
}
/// Which owned process a host failure interrupted. Only the image turn can
/// have reached the remote service.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProcessStep {
    LoginStatus,
    ImageTurn,
}
/// Classify a failed owned-process step by what it proves about remote work.
///
/// `login status` never starts an image turn, so any failure there is a
/// definite non-execution: cancelled when requested, otherwise failed. During
/// the image turn only the host's typed pre-spawn refusals stay definite; every
/// other host error (`interrupted` after spawn, a legacy host's untyped
/// `service_unavailable`, and local cancellation) leaves the remote outcome
/// unknown, so it is never retried.
fn process_failure(
    step: ProcessStep,
    failure: te_image_generation_contract::SafeError,
    cancel_requested: bool,
) -> te_image_generation_contract::SafeError {
    match step {
        ProcessStep::LoginStatus if cancel_requested => error(
            "cancelled",
            "Image generation cancelled before the Codex image turn started",
        ),
        ProcessStep::LoginStatus => error(
            "unavailable",
            &format!(
                "Codex login check could not run; no image turn was started: {}",
                failure.message
            ),
        ),
        ProcessStep::ImageTurn
            if te_plugin_runtime::process::proves_not_started(&failure.code) =>
        {
            failure
        }
        ProcessStep::ImageTurn if cancel_requested => error(
            "cancelled_after_dispatch",
            "Codex image turn was cancelled after it started; it will not be replayed",
        ),
        ProcessStep::ImageTurn => error(
            "remote_outcome_unknown",
            &format!(
                "Codex image turn ended without a complete host result; it will not be replayed: {}",
                failure.message
            ),
        ),
    }
}
fn run(
    host: &dyn Host,
    executable: &super::codex_executable::CodexExecutable,
    args: Vec<String>,
    stdin: Option<String>,
    cwd: &Path,
    cancel: &AtomicBool,
) -> Result<ProcessOutput> {
    let login = args == ["login", "status"];
    let request = te_plugin_runtime::process::ProcessRequest {
        program: executable.program.to_string_lossy().into_owned(),
        args: args.clone(),
        cwd: Some(cwd.to_string_lossy().into_owned()),
        env: [
            (
                "PATH",
                Some(executable.search_path.to_string_lossy().into_owned()),
            ),
            ("OPENAI_API_KEY", None),
            ("CODEX_API_KEY", None),
            ("CODEX_ACCESS_TOKEN", None),
        ]
        .map(|(key, value)| (key.to_owned(), value))
        .to_vec(),
        stdout_limit: 16 * 1024 * 1024,
        stderr_limit: 64 * 1024,
        stdin,
    };
    if !request.fits_frame() {
        // Never sent, so nothing ran: a definite refusal on either step.
        return Err(error(
            "invalid_request",
            "Codex request is too large for the host connection",
        ));
    }
    let result = host.call("host.process.run", request.params(), cancel)?;
    let read = (|| {
        let exit_status = result["status"]
            .as_i64()
            .ok_or_else(|| error("invalid_response", "Missing owned process exit status"))?;
        let stdout = result["stdout"]
            .as_str()
            .ok_or_else(|| error("invalid_response", "Missing owned process output"))?;
        let stderr = result["stderr"]
            .as_str()
            .ok_or_else(|| error("invalid_response", "Missing owned process diagnostics"))?;
        let output = read_regular(Path::new(stdout), 16 * 1024 * 1024)?;
        let diagnostics = read_regular(Path::new(stderr), 64 * 1024)?;
        if login && exit_status == 0 && args_is_login(&output, &diagnostics) {
            return Ok(ProcessOutput {
                stdout: b"Logged in using ChatGPT".to_vec(),
                exit_status,
            });
        }
        Ok(ProcessOutput {
            stdout: output,
            exit_status,
        })
    })();
    let _ = host.call(
        "host.process.release",
        json!({"handle":result["handle"]}),
        &AtomicBool::new(false),
    );
    read
}
fn args_is_login(out: &[u8], err: &[u8]) -> bool {
    [out, err]
        .iter()
        .any(|bytes| String::from_utf8_lossy(bytes).contains("Logged in using ChatGPT"))
}
pub(super) fn generate(
    configured: &str,
    recipe: &EffectiveRecipe,
    inputs: &[Input],
    host: &dyn Host,
    cancel: &AtomicBool,
    evidence: &(dyn Fn(Evidence) -> Result<()> + Send + Sync),
    stage: &(dyn Fn(&'static str) + Send + Sync),
) -> Result<Output> {
    let executable = super::codex_executable::resolve(configured)?;
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or_else(|| error("unavailable", "Codex home is unavailable"))?;
    generate_at(
        &executable,
        &home,
        recipe,
        inputs,
        host,
        cancel,
        evidence,
        stage,
    )
}
fn generate_at(
    executable: &super::codex_executable::CodexExecutable,
    home: &Path,
    recipe: &EffectiveRecipe,
    inputs: &[Input],
    host: &dyn Host,
    cancel: &AtomicBool,
    evidence: &(dyn Fn(Evidence) -> Result<()> + Send + Sync),
    stage: &(dyn Fn(&'static str) + Send + Sync),
) -> Result<Output> {
    let work = tempfile::Builder::new()
        .prefix("image-generation-codex-")
        .tempdir()
        .map_err(storage)?;
    stage("credential_check_started");
    let login = run(
        host,
        executable,
        vec!["login".into(), "status".into()],
        None,
        work.path(),
        cancel,
    );
    stage("credential_check_done");
    let login = login.map_err(|failure| {
        process_failure(
            ProcessStep::LoginStatus,
            failure,
            cancel.load(Ordering::Acquire),
        )
    })?;
    if cancel.load(Ordering::Acquire) {
        return Err(error(
            "cancelled",
            "Image generation cancelled before the Codex image turn started",
        ));
    }
    if login.exit_status != 0
        || !String::from_utf8_lossy(&login.stdout).contains("Logged in using ChatGPT")
    {
        return Err(error(
            "unavailable",
            "Codex requires a saved ChatGPT login; run codex login",
        ));
    }
    let mut args: Vec<String> = [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--enable",
        "image_generation",
        "--disable",
        "hooks",
        "--disable",
        "multi_agent",
        "--disable",
        "plugins",
        "--disable",
        "apps",
        "--disable",
        "shell_tool",
        "--disable",
        "computer_use",
        "--disable",
        "browser_use",
        "-c",
        "web_search=\"disabled\"",
        "--json",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for (index, input) in inputs.iter().enumerate() {
        let extension = match input.mime.as_str() {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => "png",
        };
        let path = work
            .path()
            .join(format!("source-{}.{extension}", index + 1));
        std::fs::write(&path, &input.bytes).map_err(storage)?;
        args.extend(["--image".into(), path.to_string_lossy().into_owned()]);
    }
    args.push("--".into());
    let task = recipe
        .agent_task
        .clone()
        .ok_or_else(|| error("invalid_request", "Missing prepared Codex task"))?;
    let stdin = match super::codex_prompt::prompt_transport(
        &task,
        host.process_stdin_bound(),
        cfg!(windows),
        &executable.program,
        &args,
    )? {
        super::codex_prompt::PromptTransport::Stdin => {
            args.push(super::codex_prompt::STDIN_PROMPT.into());
            Some(task)
        }
        super::codex_prompt::PromptTransport::Argv => {
            args.push(task);
            None
        }
    };
    stage("process_started");
    let process = run(host, executable, args, stdin, work.path(), cancel);
    stage("process_finished");
    let process = process.map_err(|failure| {
        process_failure(
            ProcessStep::ImageTurn,
            failure,
            cancel.load(Ordering::Acquire),
        )
    })?;
    let turn = super::codex_turn::read_turn(&process.stdout)
        .map_err(|failure| error("invalid_response", failure.message()))?;
    let thread = turn.thread_id.clone().ok_or_else(|| {
        error(
            "invalid_response",
            "Codex returned no fresh thread identity",
        )
    })?;
    let state = match turn.status {
        super::codex_turn::TurnStatus::Completed => {
            te_image_generation_contract::CodexTurnState::Completed
        }
        super::codex_turn::TurnStatus::Failed => {
            te_image_generation_contract::CodexTurnState::Failed
        }
        super::codex_turn::TurnStatus::Unfinished => {
            te_image_generation_contract::CodexTurnState::Incomplete
        }
    };
    let receipt = crate::domain::codex_evidence::turn(thread.clone(), state, &turn.usage);
    // This owned local commit precedes all fresh-thread filesystem discovery.
    // A crash or missing output cannot erase the paid turn's safe identity.
    evidence(Evidence::Turn(receipt.clone()))?;
    let failed = |failure| -> Result<Output> {
        let receipt = crate::domain::codex_evidence::failure(
            receipt.clone(),
            turn.reply.as_deref(),
            turn.error.as_deref(),
        );
        let failure = crate::domain::codex_evidence::error_message(failure, &receipt);
        evidence(Evidence::Failure {
            receipt,
            error: failure.clone(),
        })?;
        Err(failure)
    };
    if process.exit_status != 0 || turn.status != super::codex_turn::TurnStatus::Completed {
        return failed(error(
            "remote_outcome_unknown",
            "Codex image turn did not complete reliably; it will not be replayed",
        ));
    }
    let bytes = match discover(home, &thread) {
        Ok(bytes) => bytes,
        Err(failure) => return failed(failure),
    };
    stage("output_found");
    let mut metadata = metadata(recipe);
    metadata.thread_id = Some(thread);
    Ok(Output { bytes, metadata })
}
fn discover(home: &Path, thread: &str) -> Result<Vec<u8>> {
    let directory = home.join("generated_images").join(thread);
    let info = std::fs::symlink_metadata(&directory).map_err(storage)?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(error(
            "invalid_response",
            "Codex did not produce a fresh thread image directory",
        ));
    }
    let mut selected = None;
    for (index, entry) in std::fs::read_dir(&directory).map_err(storage)?.enumerate() {
        if index >= 16 {
            return Err(error("invalid_response", "Too many Codex output files"));
        }
        let path = entry.map_err(storage)?.path();
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("png"))
            && selected.replace(path).is_some()
        {
            return Err(error("invalid_response", "Codex returned multiple images"));
        }
    }
    let path = selected.ok_or_else(|| {
        error(
            "invalid_response",
            "Codex saved no PNG image for this thread",
        )
    })?;
    let bytes = read_regular(&path, MAX_OUTPUT)?;
    validate_image(&bytes, image::ImageFormat::Png)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{self, Credential, Profile},
        journal::Journal,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use te_image_generation_contract::*;
    const THREAD: &str = "12345678-1234-1234-1234-123456789abc";
    struct OwnedFixture {
        home: PathBuf,
        calls: AtomicUsize,
    }
    impl Host for OwnedFixture {
        fn call(
            &self,
            method: &str,
            p: serde_json::Value,
            _: &AtomicBool,
        ) -> Result<serde_json::Value> {
            match method {
                "host.process.run" => {
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    let stdout = self.home.join("stdout");
                    let stderr = self.home.join("stderr");
                    let content = if p["args"] == json!(["login", "status"]) {
                        "Logged in using ChatGPT\n".into()
                    } else {
                        let folder = self.home.join("generated_images").join(THREAD);
                        std::fs::create_dir_all(&folder).unwrap();
                        let mut image = std::io::Cursor::new(vec![]);
                        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                            2,
                            2,
                            image::Rgba([0, 0, 255, 255]),
                        ))
                        .write_to(&mut image, image::ImageFormat::Png)
                        .unwrap();
                        std::fs::write(folder.join("output.png"), image.into_inner()).unwrap();
                        [json!({"type":"thread.started","thread_id":THREAD}),json!({"type":"item.completed","item":{"type":"agent_message","text":"Fixture refusal explains a missing output"}}),json!({"type":"turn.completed","usage":{"input_tokens":1}})].iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n")+"\n"
                    };
                    std::fs::write(&stdout, content).unwrap();
                    std::fs::write(&stderr, []).unwrap();
                    Ok(json!({"status":0,"handle":"owned-process","stdout":stdout,"stderr":stderr}))
                }
                "host.process.release" => {
                    std::fs::remove_file(self.home.join("stdout")).unwrap();
                    std::fs::remove_file(self.home.join("stderr")).unwrap();
                    Ok(serde_json::Value::Null)
                }
                _ => panic!("Unexpected reverse IO"),
            }
        }
        fn event(&self, _: &str, _: serde_json::Value) -> Result<()> {
            Ok(())
        }
    }
    fn accepted(journal: &Journal) -> EffectiveRecipe {
        let profile = Profile::Codex {
            id: "cli".into(),
            name: "CLI".into(),
            recipe_revision: "revision-1".into(),
            executable_path: "/fixture/codex".into(),
            model_selection: false,
            credential: Credential::CliSavedLogin,
        };
        let request = PrepareRequest {
            operation_id: "checkpoint-order".into(),
            connection_id: "cli".into(),
            expected_connection_revision: "revision-1".into(),
            model: None,
            prompt: "Draw a bird".into(),
            inputs: vec![],
            options: ImageOptions {
                size: "1024x1024".into(),
                resolution: None,
                aspect_ratio: None,
                quality: "auto".into(),
                background: "auto".into(),
            },
        };
        let recipe = domain::recipe(&profile, &request).unwrap();
        let start = StartRequest {
            operation_id: request.operation_id,
            connection_id: request.connection_id,
            expected_connection_revision: request.expected_connection_revision,
            model: request.model,
            prompt: request.prompt,
            inputs: request.inputs,
            options: request.options,
            preparation_token: "unused".into(),
            effective_recipe_digest: recipe.digest(),
        };
        journal
            .accept(
                &Caller {
                    package_id: "test.consumer".into(),
                    package_digest: "a".repeat(64),
                    incarnation: 1,
                },
                "checkpoint-order",
                &domain::semantic(&start),
                &recipe,
                false,
            )
            .unwrap();
        assert!(journal.claim("test.consumer", "checkpoint-order").unwrap());
        recipe
    }
    #[test]
    fn turn_commit_precedes_output_discovery_and_failed_explanation_survives_restart() {
        let state = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let journal = Journal::open(state.path()).unwrap();
        journal.activate().unwrap();
        let recipe = accepted(&journal);
        let host = OwnedFixture {
            home: home.path().into(),
            calls: AtomicUsize::new(0),
        };
        let executable = super::super::codex_executable::CodexExecutable {
            program: "/fixture/codex".into(),
            search_path: "/fixture".into(),
        };
        let sink = |event| match event {
            Evidence::Turn(receipt) => {
                journal.turn_checkpoint("test.consumer", "checkpoint-order", receipt)?;
                assert!(journal
                    .get("test.consumer", "checkpoint-order", None)?
                    .unwrap()
                    .diagnostics
                    .as_ref()
                    .unwrap()
                    .valid(false));
                // If discovery preceded this callback the adapter would have
                // already read the valid PNG, rather than reporting it missing.
                std::fs::remove_dir_all(home.path().join("generated_images").join(THREAD)).unwrap();
                Ok(())
            }
            Evidence::Failure { receipt, error } => {
                journal.turn_failure("test.consumer", "checkpoint-order", receipt, error)
            }
        };
        assert!(generate_at(
            &executable,
            home.path(),
            &recipe,
            &[],
            &host,
            &AtomicBool::new(false),
            &sink,
            &|_| {}
        )
        .is_err());
        let failed = journal
            .get("test.consumer", "checkpoint-order", None)
            .unwrap()
            .unwrap();
        assert!(matches!(failed.execution, Execution::Unknown { .. }));
        assert!(serde_json::to_string(&failed)
            .unwrap()
            .contains("Fixture refusal"));
        assert_eq!(host.calls.load(Ordering::SeqCst), 2);
        drop(journal);
        let recovered = Journal::open(state.path()).unwrap();
        recovered.activate().unwrap();
        recovered.recover().unwrap();
        assert_eq!(
            recovered
                .get("test.consumer", "checkpoint-order", None)
                .unwrap()
                .unwrap(),
            failed
        );
    }
    #[test]
    fn interruption_after_turn_commit_keeps_safe_identity_and_never_a_successful_transcript() {
        let state = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let journal = Journal::open(state.path()).unwrap();
        journal.activate().unwrap();
        let recipe = accepted(&journal);
        let host = OwnedFixture {
            home: home.path().into(),
            calls: AtomicUsize::new(0),
        };
        let executable = super::super::codex_executable::CodexExecutable {
            program: "/fixture/codex".into(),
            search_path: "/fixture".into(),
        };
        let sink = |event| {
            let Evidence::Turn(receipt) = event else {
                panic!("Discovery proceeded after interrupted checkpoint");
            };
            journal.turn_checkpoint("test.consumer", "checkpoint-order", receipt)?;
            Err(error(
                "interrupted",
                "Injected interruption before filesystem discovery",
            ))
        };
        assert!(generate_at(
            &executable,
            home.path(),
            &recipe,
            &[],
            &host,
            &AtomicBool::new(false),
            &sink,
            &|_| {}
        )
        .is_err());
        drop(journal);
        let recovered = Journal::open(state.path()).unwrap();
        recovered.activate().unwrap();
        recovered.recover().unwrap();
        let status = recovered
            .get("test.consumer", "checkpoint-order", None)
            .unwrap()
            .unwrap();
        assert!(matches!(status.execution, Execution::Unknown { .. }));
        let OperationDiagnostics::CodexImageTurn {
            thread_id,
            turn_state,
            explanation,
            ..
        } = status.diagnostics.unwrap();
        assert_eq!(thread_id, THREAD);
        assert_eq!(turn_state, CodexTurnState::Completed);
        assert_eq!(explanation, None);
        assert_eq!(host.calls.load(Ordering::SeqCst), 2);
    }
}
