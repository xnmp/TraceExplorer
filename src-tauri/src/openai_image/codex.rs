//! Headless Codex transport. Codex owns authentication and generation; this
//! adapter reads only the fresh thread's generated image, never credentials.
use super::codex_executable::CodexExecutable;
use super::codex_turn::{read_turn, valid_thread_id, Failure, Turn, TurnStatus};
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
        input_framing(input_count).unwrap_or_default(),
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
    receipt: impl FnMut(&Value) -> Result<(), AppError>,
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
    generate_with_receipt(request, inputs, control, &executable, &home, receipt)
}

#[cfg(test)]
fn generate_at(
    request: &ImageRequest,
    inputs: &[CapturedInput],
    control: &plugin_job::JobControl,
    executable: &CodexExecutable,
    home: &Path,
) -> Result<GeneratedImage, AppError> {
    generate_with_receipt(request, inputs, control, executable, home, |_| Ok(()))
}

fn generate_with_receipt(
    request: &ImageRequest,
    inputs: &[CapturedInput],
    control: &plugin_job::JobControl,
    executable: &CodexExecutable,
    home: &Path,
    mut receipt: impl FnMut(&Value) -> Result<(), AppError>,
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
    let turn = read_turn(&output.stdout).map_err(|error| invalid(error.message()))?;
    // A failed run keeps a bounded excerpt of Codex's final reply and of the
    // error it reported, so the user can see why no image was made (the run
    // is --ephemeral; no transcript survives). Reasoning and inputs are never
    // kept, and a successful run keeps neither.
    let mut details = json!({"transport":"codex_exec","thread_id":turn.thread_id,"usage":turn.usage,"usage_source":"codex_turn","stage":"turn_completed","image_tool_prompt":null,"provider_revision":null,"cost":null});
    // A crashed or killed CLI with nothing to say keeps the generic advice.
    if let Some(failure) = Failure::of_turn(&turn) {
        if output.status.success() || turn.error.is_some() || turn.status == TurnStatus::Failed {
            return Err(failed(&mut details, &mut receipt, failure));
        }
    }
    if !output.status.success() {
        return Err(invalid("Headless Codex image generation failed. Check your Codex version, ChatGPT sign-in, and usage limits"));
    }
    let thread_id = turn
        .thread_id
        .clone()
        .ok_or_else(|| invalid("Codex did not return a thread identity"))?;
    // Retain a safe receipt before filesystem discovery.
    receipt(&details)?;
    let bytes = match read_generated_image(home, &thread_id) {
        Ok(bytes) => bytes,
        Err(Discovery::NoThreadOutput) => {
            return Err(failed(&mut details, &mut receipt, Failure::no_image(&turn)))
        }
        Err(Discovery::NoImage) => {
            return Err(failed(
                &mut details,
                &mut receipt,
                Failure::OutputMissing { thread_id },
            ))
        }
        Err(Discovery::Invalid(error)) => return Err(error),
    };
    validate_image(&bytes, image::ImageFormat::Png)?;
    let (width, height) =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png)
            .into_dimensions()
            .map_err(|_| invalid("Unreadable Codex image"))?;
    details["stage"] = json!("image_validated");
    details["actual_size"] = json!({"width":width,"height":height});
    Ok(GeneratedImage { bytes, details })
}

/// Records why the job produced no image and returns its user-facing error.
fn failed(
    details: &mut Value,
    receipt: &mut impl FnMut(&Value) -> Result<(), AppError>,
    failure: Failure,
) -> AppError {
    merge(details, failure.record());
    if let Err(error) = receipt(details) {
        log::warn!("[openai-image] Codex failure details were not recorded: {error}");
    }
    invalid(&failure.message())
}

fn merge(details: &mut Value, fields: Value) {
    if let (Some(details), Value::Object(fields)) = (details.as_object_mut(), fields) {
        details.extend(fields);
    }
}

/// A completed turn with a thread identity, as prompt titles require.
fn completed_turn(bytes: &[u8]) -> Result<Turn, AppError> {
    let turn = read_turn(bytes).map_err(|error| invalid(error.message()))?;
    if let Some(failure) = Failure::of_turn(&turn) {
        return Err(invalid(&failure.message()));
    }
    if turn.thread_id.is_none() {
        return Err(invalid("Codex did not return a thread identity"));
    }
    Ok(turn)
}

/// Why no image was read for a thread.
#[derive(Debug)]
enum Discovery {
    /// Codex created no output folder for the thread: no image was saved.
    NoThreadOutput,
    /// The thread's output folder exists but holds no PNG.
    NoImage,
    Invalid(AppError),
}

impl From<std::io::Error> for Discovery {
    fn from(error: std::io::Error) -> Self {
        Self::Invalid(error.into())
    }
}

/// Each new Codex thread owns its generated-images directory. Never scan a
/// global folder for the newest file or trust a path supplied by model text.
fn read_generated_image(home: &Path, thread_id: &str) -> Result<Vec<u8>, Discovery> {
    let reject = |message: &str| Discovery::Invalid(invalid(message));
    if !valid_thread_id(thread_id) {
        return Err(reject("Invalid Codex thread identity"));
    }
    let absent = |missing: Discovery| {
        move |error: std::io::Error| match error.kind() {
            std::io::ErrorKind::NotFound => missing,
            _ => error.into(),
        }
    };
    let generated = home
        .join("generated_images")
        .canonicalize()
        .map_err(absent(Discovery::NoThreadOutput))?;
    let directory = generated.join(thread_id);
    let metadata =
        std::fs::symlink_metadata(&directory).map_err(absent(Discovery::NoThreadOutput))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(reject("Invalid Codex image directory"));
    }
    let mut selected = None;
    for (index, entry) in std::fs::read_dir(&directory)?.enumerate() {
        if index >= 16 {
            return Err(reject("Too many files in Codex image output"));
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
            return Err(reject("Codex output must be a regular PNG file"));
        }
        if selected.replace(path).is_some() {
            return Err(reject("Codex returned multiple images for one job"));
        }
    }
    let path = selected.ok_or(Discovery::NoImage)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(absent(Discovery::NoImage))?;
    if !file.metadata()?.is_file() {
        return Err(reject("Codex output must be a regular PNG file"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_OUTPUT_BYTES {
        return Err(reject("Codex image exceeds the 50 MiB output limit"));
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "../../test_support/codex_image.rs"]
mod tests;
