//! OpenAI image adapters. Captured input bytes and the submitted recipe
//! enter Trace before a paid request; publication uses a retained native anchor.
#[cfg(test)]
use crate::image_operation::execute_with_completion;
use crate::image_operation::{execute_recorded, GeneratedImage};
use crate::{error::AppError, plugin_job, trace};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const API_ROOT: &str = "https://api.openai.com/v1/images";
const MAX_INPUT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_INPUTS: usize = 8;
const MAX_TOTAL_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 70 * 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(180);

mod codex;
mod codex_executable;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImageBackend {
    #[default]
    ApiKey,
    Codex,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageRequest {
    #[serde(default)]
    pub backend: ImageBackend,
    #[serde(default)]
    pub codex_path: String,
    pub source_path: Option<String>,
    #[serde(default)]
    pub expected_source_digest: Option<String>,
    #[serde(default)]
    pub reference_paths: Vec<String>,
    pub prompt: String,
    pub output_dir: String,
    pub output_filename: String,
    pub model: String,
    pub size: String,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    pub quality: String,
    pub background: String,
}

struct CapturedInput {
    path: String,
    bytes: Vec<u8>,
    digest: String,
    mime: &'static str,
}

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

fn validate_request(request: &ImageRequest) -> Result<PathBuf, AppError> {
    if request
        .expected_source_digest
        .as_ref()
        .is_some_and(|digest| {
            request.source_path.is_none()
                || digest.len() != 64
                || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(invalid("Invalid expected source revision"));
    }
    if request.reference_paths.len() >= MAX_INPUTS
        || (request.source_path.is_none() && !request.reference_paths.is_empty())
    {
        return Err(invalid(
            "Choose an edit target and at most seven reference images",
        ));
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 16_000 {
        return Err(invalid("Enter an image prompt of 1–16,000 bytes"));
    }
    if ![
        "gpt-image-2",
        "gpt-image-2.5-sunburst",
        "gpt-image-2.5-flare",
    ]
    .contains(&request.model.as_str())
    {
        return Err(invalid("Unsupported OpenAI image model"));
    }
    if !valid_image_size(&request.size) {
        return Err(invalid("Unsupported image size"));
    }
    if request
        .resolution
        .as_deref()
        .is_some_and(|value| !["1k", "2k", "4k"].contains(&value))
        || request.aspect_ratio.as_deref().is_some_and(|value| {
            !["keep", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"].contains(&value)
        })
    {
        return Err(invalid("Unsupported resolution or aspect ratio"));
    }
    if !["auto", "low", "medium", "high"].contains(&request.quality.as_str()) {
        return Err(invalid("Unsupported image quality"));
    }
    if !["auto", "opaque", "transparent"].contains(&request.background.as_str()) {
        return Err(invalid("Unsupported image background"));
    }
    if request.backend == ImageBackend::Codex
        && (request.model != "gpt-image-2"
            || request.quality != "auto"
            || request.background != "auto")
    {
        return Err(invalid(
            "Codex image mode uses built-in defaults; describe visual requirements in the prompt",
        ));
    }
    if !request
        .output_filename
        .to_ascii_lowercase()
        .ends_with(".png")
    {
        return Err(invalid("OpenAI image outputs must use a .png filename"));
    }
    plugin_job::validate_output_target(&request.output_dir, &request.output_filename)
}

fn valid_image_size(size: &str) -> bool {
    if size == "auto" {
        return true;
    }
    let Some((width, height)) = size.split_once('x') else {
        return false;
    };
    let (Ok(width), Ok(height)) = (width.parse::<u64>(), height.parse::<u64>()) else {
        return false;
    };
    // Bound edges before multiplication to keep malformed values overflow-safe.
    width > 0
        && height > 0
        && width <= 3840
        && height <= 3840
        && width % 16 == 0
        && height % 16 == 0
        && width <= height * 3
        && height <= width * 3
        && (655_360..=8_294_400).contains(&(width * height))
}

fn resolve_key(provided: &str) -> Result<String, AppError> {
    let key = if provided.trim().is_empty() {
        std::env::var("OPENAI_API_KEY").unwrap_or_default()
    } else {
        provided.trim().to_owned()
    };
    if key.is_empty() {
        return Err(invalid(
            "Configure an OpenAI API key in plugin settings or set OPENAI_API_KEY",
        ));
    }
    if key.len() > 512 || key.contains(['\r', '\n']) {
        return Err(invalid("Invalid OpenAI API key"));
    }
    Ok(key)
}

fn capture_input(path: Option<&str>) -> Result<Option<CapturedInput>, AppError> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !Path::new(path).is_absolute() {
        return Err(invalid("Input image path must be absolute"));
    }
    let physical = std::fs::canonicalize(path)?;
    if !std::fs::symlink_metadata(&physical)?.is_file() {
        return Err(invalid("Input image must be a regular file"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let mut file = options.open(&physical)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("Input image must be a regular file"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(invalid("Input image exceeds the 20 MiB limit"));
    }
    let mime = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => return Err(invalid("Use a PNG, JPEG, or WebP input image")),
    };
    validate_image(
        &bytes,
        image::guess_format(&bytes).map_err(|_| invalid("Invalid input image"))?,
    )?;
    Ok(Some(CapturedInput {
        path: physical.to_string_lossy().into_owned(),
        digest: hex::encode(Sha256::digest(&bytes)),
        bytes,
        mime,
    }))
}

fn capture_inputs(request: &ImageRequest) -> Result<Vec<CapturedInput>, AppError> {
    if request.reference_paths.len() >= MAX_INPUTS {
        return Err(invalid("At most eight input images are supported"));
    }
    let mut inputs = Vec::new();
    let mut total = 0;
    for path in request
        .source_path
        .iter()
        .chain(request.reference_paths.iter())
    {
        let input = capture_input(Some(path))?.expect("a supplied path is captured");
        if inputs
            .iter()
            .any(|previous: &CapturedInput| previous.path == input.path)
        {
            return Err(invalid("The same input image was selected more than once"));
        }
        total += input.bytes.len();
        if total > MAX_TOTAL_INPUT_BYTES {
            return Err(invalid("Combined input images exceed the 64 MiB limit"));
        }
        inputs.push(input);
    }
    if let Some(expected) = &request.expected_source_digest {
        if inputs
            .first()
            .is_none_or(|input| !input.digest.eq_ignore_ascii_case(expected))
        {
            return Err(invalid(
                "The source image changed since the editor opened. Reopen it before editing.",
            ));
        }
    }
    Ok(inputs)
}

fn recipe(request: &ImageRequest, inputs: &[CapturedInput]) -> trace::OperationStart {
    trace::OperationStart {
        operation: if !inputs.is_empty() {
            "openai.image.edit"
        } else {
            "openai.image.generate"
        }
        .into(),
        parameters: if request.backend == ImageBackend::Codex {
            json!({
                "provider": "codex-cli", "authentication": "saved_chatgpt_sign_in",
                "prompt": request.prompt, "agent_task": codex::task(request, inputs.len()),
                "model": null, "documented_image_model": "gpt-image-2",
                "image_tool_prompt": null, "provider_revision": null, "cost": null,
                "settings_source": "requested_via_codex_task",
                "size": request.size, "resolution": request.resolution, "aspect_ratio": request.aspect_ratio,
                "input_roles": input_roles(inputs),
            })
        } else {
            json!({
                "provider": "openai", "model": request.model,
                "endpoint": if !inputs.is_empty() { "images/edits" } else { "images/generations" },
                "prompt": request.prompt, "size": request.size, "quality": request.quality,
                "resolution": request.resolution, "aspect_ratio": request.aspect_ratio,
                "submitted_prompt": api_prompt(request, inputs.len()),
                "background": request.background, "output_format": "png", "n": 1,
                "provider_revision": null, "cost": null,
                "input_roles": input_roles(inputs),
            })
        },
        inputs: inputs
            .iter()
            .map(|input| trace::OperationInput {
                path: input.path.clone(),
                digest: input.digest.clone(),
            })
            .collect(),
    }
}

fn input_roles(inputs: &[CapturedInput]) -> Value {
    inputs
        .iter()
        .enumerate()
        .map(|(index, input)| {
            json!({
                "position": index + 1, "role": if index == 0 { "edit_target" } else { "reference" },
                "path": input.path, "digest": input.digest,
            })
        })
        .collect()
}

fn api_prompt(request: &ImageRequest, input_count: usize) -> String {
    if input_count <= 1 {
        return request.prompt.clone();
    }
    format!("Edit image 1, the primary target. Images 2 through {input_count} are ordered references. \
        Preserve target details unless the user's request asks to change them; use references as directed. \
        User's visual request: {}", json!({"prompt": request.prompt}))
}

fn fields(request: &ImageRequest, input_count: usize) -> Value {
    json!({"model": request.model, "prompt": api_prompt(request, input_count), "size": request.size,
        "quality": request.quality, "background": request.background, "output_format": "png", "n": 1})
}

fn multipart(request: &ImageRequest, inputs: &[CapturedInput], boundary: &str) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, value) in fields(request, inputs.len())
        .as_object()
        .expect("fixed image fields")
    {
        let value = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        write!(
            body,
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .expect("writing to Vec");
    }
    for (index, input) in inputs.iter().enumerate() {
        let extension = match input.mime {
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => "png",
        };
        let filename = format!("source-{}.{extension}", index + 1);
        write!(body, "--{boundary}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{filename}\"\r\nContent-Type: {}\r\n\r\n", input.mime).expect("writing to Vec");
        body.extend_from_slice(&input.bytes);
        write!(body, "\r\n").expect("writing to Vec");
    }
    write!(body, "--{boundary}--\r\n").expect("writing to Vec");
    body
}

fn request_image(
    root: &str,
    request: &ImageRequest,
    inputs: &[CapturedInput],
    key: &str,
) -> Result<GeneratedImage, AppError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(HTTP_TIMEOUT))
        .max_redirects(0)
        .build()
        .into();
    let auth = format!("Bearer {key}");
    let response = if !inputs.is_empty() {
        // An unpredictable boundary avoids collisions with prompts/input bytes.
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| invalid("Could not prepare OpenAI upload"))?;
        let boundary = format!("TraceExplorer{}", hex::encode(nonce));
        agent
            .post(&format!("{root}/edits"))
            .header("Authorization", &auth)
            .header(
                "Content-Type",
                &format!("multipart/form-data; boundary={boundary}"),
            )
            .send(multipart(request, inputs, &boundary).as_slice())
    } else {
        agent
            .post(&format!("{root}/generations"))
            .header("Authorization", &auth)
            .send_json(fields(request, 0))
    };
    let mut response =
        response.map_err(|error| invalid(&format!("OpenAI image request failed: {error}")))?;
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_vec()
        .map_err(|_| invalid("OpenAI image response was unreadable or exceeded the size limit"))?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("OpenAI returned invalid JSON"))?;
    decode_response(value, request_id)
}

fn decode_response(value: Value, request_id: Option<String>) -> Result<GeneratedImage, AppError> {
    let encoded = value["data"]
        .as_array()
        .filter(|data| data.len() == 1)
        .and_then(|data| data[0]["b64_json"].as_str())
        .ok_or_else(|| invalid("OpenAI returned no single image result"))?;
    if encoded.len() > MAX_OUTPUT_BYTES * 4 / 3 + 4 {
        return Err(invalid("Generated image exceeds the size limit"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("OpenAI returned invalid image encoding"))?;
    if bytes.len() > MAX_OUTPUT_BYTES
        || !matches!(image::guess_format(&bytes), Ok(image::ImageFormat::Png))
    {
        return Err(invalid("OpenAI returned an invalid PNG image"));
    }
    validate_image(&bytes, image::ImageFormat::Png)?;
    Ok(GeneratedImage {
        bytes,
        details: json!({
            "request_id": request_id.filter(|id| id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))),
            "provider_created": value["created"].as_u64(),
            "usage": usage_counts(&value["usage"]), "cost": null,
        }),
    })
}

fn usage_counts(value: &Value) -> Value {
    let fields = ["input_tokens", "output_tokens", "total_tokens"];
    let mut counts = serde_json::Map::new();
    for field in fields {
        if let Some(count) = value[field].as_u64() {
            counts.insert(field.into(), count.into());
        }
    }
    for field in ["input_tokens_details", "output_tokens_details"] {
        let mut details = serde_json::Map::new();
        for kind in ["image_tokens", "text_tokens"] {
            if let Some(count) = value[field][kind].as_u64() {
                details.insert(kind.into(), count.into());
            }
        }
        if !details.is_empty() {
            counts.insert(field.into(), details.into());
        }
    }
    if counts.is_empty() {
        Value::Null
    } else {
        counts.into()
    }
}

fn validate_image(bytes: &[u8], format: image::ImageFormat) -> Result<(), AppError> {
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| invalid("Unreadable image data"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
        return Err(invalid("Image dimensions exceed the 16 megapixel limit"));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| invalid("Unreadable image data"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_openai_image_job(
    app: AppHandle,
    request: ImageRequest,
    api_key: String,
) -> Result<u64, AppError> {
    let target = validate_request(&request)?;
    let key = if request.backend == ImageBackend::ApiKey {
        Some(resolve_key(&api_key)?)
    } else {
        None
    };
    let (request, inputs, run) = tokio::task::spawn_blocking(move || {
        let inputs = capture_inputs(&request)?;
        let run = trace::begin_operation(recipe(&request, &inputs))?;
        Ok::<_, AppError>((request, inputs, run))
    })
    .await
    .map_err(|_| invalid("Image input capture failed"))??;
    let _ = app.emit("trace:changed", ());
    let job_id = plugin_job::next_job_id();
    let control = plugin_job::JobControl::new();
    let worker_control = control.clone();
    let worker_app = app.clone();
    let attempt = crate::image_operation::Attempt::new(run, control.clone()).with_app(app.clone());
    tokio::spawn(async move {
        let job = async {
            tokio::task::spawn_blocking(move || {
                let result = execute_recorded(&attempt.run, &target, &worker_control, || {
                    match request.backend {
                        ImageBackend::ApiKey => request_image(
                            API_ROOT,
                            &request,
                            &inputs,
                            key.as_deref().expect("validated API key"),
                        ),
                        ImageBackend::Codex => codex::generate(&request, &inputs, &worker_control),
                    }
                });
                attempt.settle();
                let _ = worker_app.emit("trace:changed", ());
                result
            })
            .await
            .map_err(|_| invalid("OpenAI image worker failed"))?
        };
        plugin_job::run_and_emit_detailed(&app, "openai-image", job_id, control, job).await;
    });
    Ok(job_id)
}

#[cfg(test)]
#[path = "../test_support/openai_image.rs"]
mod tests;
