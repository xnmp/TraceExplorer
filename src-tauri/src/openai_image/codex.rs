//! Headless Codex transport. Codex owns authentication and generation; this
//! adapter reads only the fresh thread's generated image, never credentials.
use super::codex_executable::CodexExecutable;
use super::*;
use crate::process_ext::{output_controlled, NoConsole};
use std::process::Command;

const MAX_EVENTS: usize = 16 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 64 * 1024;

pub(super) fn task(request: &ImageRequest, input_count: usize) -> String {
    format!(
        "Use the built-in image generation tool exactly once to {} an image for a local image editor. \
         The following JSON contains the user's visual request: {}. \
         Use the requested pixel dimensions for the image generation tool when size is not auto. \
         {} Return the generated image and leave it at the normal built-in generated-images location. \
         Do not copy or move the result, execute commands, read files, use other tools, or call an API separately. \
         If image generation is unavailable, report that and stop.",
        if input_count > 0 { "edit" } else { "generate" },
        json!({"prompt": request.prompt, "size": request.size, "resolution": request.resolution, "aspect_ratio": request.aspect_ratio}),
        if input_count > 0 {
            format!("There are {input_count} attached images in order. The first is the edit target; subsequent images are references. Preserve target details the request does not ask to change. Use the references as directed in the user's request.")
        } else { String::new() },
    )
}

fn command(executable: &CodexExecutable) -> Command {
    let mut command = Command::new(&executable.program);
    command
        .no_console()
        .env("PATH", &executable.search_path)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN");
    command
}

fn run(
    command: &mut Command,
    control: &plugin_job::JobControl,
) -> Result<std::process::Output, AppError> {
    output_controlled(
        command,
        || control.check().is_err(),
        (MAX_EVENTS, MAX_DIAGNOSTICS),
        "Codex image job cancelled",
    )
    .map_err(|error| match error {
        AppError::NotFound(_) => invalid("Codex could not start. Check the Codex executable path and its Node runtime in Settings → AI / OpenAI Images."),
        _ => error,
    })
}

pub(super) fn generate(
    request: &ImageRequest,
    inputs: &[CapturedInput],
    control: &plugin_job::JobControl,
) -> Result<GeneratedImage, AppError> {
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| invalid("Codex home directory is unavailable"))?;
    let executable = super::codex_executable::resolve(&request.codex_path)?;
    log::info!(
        "[openai-image] using Codex executable: {}",
        executable.program.display()
    );
    generate_at(request, inputs, control, &executable, &home)
}

fn generate_at(
    request: &ImageRequest,
    inputs: &[CapturedInput],
    control: &plugin_job::JobControl,
    executable: &CodexExecutable,
    home: &Path,
) -> Result<GeneratedImage, AppError> {
    let work = tempfile::Builder::new()
        .prefix("tauri-explorer-codex-image-")
        .tempdir()?;
    let auth = run(
        command(executable)
            .args(["login", "status"])
            .current_dir(work.path()),
        control,
    )?;
    let saved_chatgpt = auth.status.success()
        && [&auth.stdout, &auth.stderr]
            .iter()
            .any(|bytes| String::from_utf8_lossy(bytes).contains("Logged in using ChatGPT"));
    if !saved_chatgpt {
        return Err(invalid(
            "Codex needs a saved ChatGPT sign-in. Run codex login and choose ChatGPT",
        ));
    }
    let mut child = command(executable);
    child
        .args([
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
        ])
        .current_dir(work.path());
    for (index, input) in inputs.iter().enumerate() {
        let extension = match input.mime {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => "png",
        };
        let path = work
            .path()
            .join(format!("source-{}.{extension}", index + 1));
        std::fs::write(&path, &input.bytes)?;
        child.arg("--image").arg(path);
    }
    // --image accepts a variable number of paths; terminate its values before
    // the positional prompt so the prompt is never interpreted as a filename.
    child.arg("--").arg(task(request, inputs.len()));
    let output = run(&mut child, control)?;
    if !output.status.success() {
        return Err(invalid("Headless Codex image generation failed. Check your Codex version, ChatGPT sign-in, and usage limits"));
    }
    let (thread_id, usage) = completed_thread(&output.stdout)?;
    let bytes = read_generated_image(home, &thread_id)?;
    validate_image(&bytes, image::ImageFormat::Png)?;
    Ok(GeneratedImage {
        bytes,
        details: json!({
            "transport": "codex_exec", "thread_id": thread_id, "usage": usage,
            "usage_source": "codex_turn", "image_tool_prompt": null,
            "provider_revision": null, "cost": null,
        }),
    })
}

fn valid_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// Interpret the CLI protocol, never the agent's prose or a returned filename.
fn completed_thread(bytes: &[u8]) -> Result<(String, Value), AppError> {
    let mut thread = None;
    let mut completed = false;
    let mut usage = serde_json::Map::new();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let event: Value =
            serde_json::from_slice(line).map_err(|_| invalid("Malformed Codex event stream"))?;
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                let id = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_thread_id(id))
                    .ok_or_else(|| invalid("Invalid Codex thread identity"))?;
                if thread.replace(id.to_owned()).is_some() {
                    return Err(invalid("Multiple Codex threads returned for one image job"));
                }
            }
            Some("turn.failed" | "error") => {
                return Err(invalid("Codex reported an unsuccessful image generation"))
            }
            Some("turn.completed") => {
                completed = true;
                for key in [
                    "input_tokens",
                    "cached_input_tokens",
                    "output_tokens",
                    "reasoning_output_tokens",
                ] {
                    if let Some(value) = event
                        .get("usage")
                        .and_then(|usage| usage.get(key))
                        .and_then(Value::as_u64)
                    {
                        usage.insert(key.into(), value.into());
                    }
                }
            }
            _ => {}
        }
    }
    if !completed {
        return Err(invalid("Codex did not complete its image turn"));
    }
    Ok((
        thread.ok_or_else(|| invalid("Codex did not return a thread identity"))?,
        Value::Object(usage),
    ))
}

/// Each new Codex thread owns its generated-images directory. Never scan a
/// global folder for the newest file or trust a path supplied by model text.
fn read_generated_image(home: &Path, thread_id: &str) -> Result<Vec<u8>, AppError> {
    if !valid_thread_id(thread_id) {
        return Err(invalid("Invalid Codex thread identity"));
    }
    let generated = home.join("generated_images").canonicalize()?;
    let directory = generated.join(thread_id);
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid("Invalid Codex image directory"));
    }
    let mut selected = None;
    for (index, entry) in std::fs::read_dir(&directory)?.enumerate() {
        if index >= 16 {
            return Err(invalid("Too many files in Codex image output"));
        }
        let path = entry?.path();
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("png"))
        {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(invalid("Codex output must be a regular PNG file"));
        }
        if selected.replace(path).is_some() {
            return Err(invalid("Codex returned multiple images for one job"));
        }
    }
    let path = selected.ok_or_else(|| invalid("Codex completed without producing a PNG image"))?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("Codex output must be a regular PNG file"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(invalid("Codex image exceeds the 50 MiB output limit"));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "../../test_support/codex_image.rs"]
mod tests;
