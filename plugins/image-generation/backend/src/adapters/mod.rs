use crate::{
    domain::{Profile, MAX_INPUT, MAX_OUTPUT},
    error::{error, storage, Result},
    host::Host,
};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use te_image_generation_contract::{ArtifactDescriptor, EffectiveRecipe, ImageMetadata};
mod codex;
mod codex_executable;
mod codex_prompt;
mod codex_turn;
mod http;
pub struct Input {
    pub bytes: Vec<u8>,
    pub mime: String,
}
pub enum Evidence {
    Turn(te_image_generation_contract::OperationDiagnostics),
    Failure {
        receipt: te_image_generation_contract::OperationDiagnostics,
        error: te_image_generation_contract::SafeError,
    },
}
pub type EvidenceSink = Arc<dyn Fn(Evidence) -> Result<()> + Send + Sync>;
pub struct Output {
    pub bytes: Vec<u8>,
    pub metadata: ImageMetadata,
}
pub fn metadata(recipe: &EffectiveRecipe) -> ImageMetadata {
    ImageMetadata {
        adapter: recipe.adapter.clone(),
        endpoint_identity: recipe.endpoint_identity.clone(),
        requested_model: recipe.model.clone(),
        actual_model: None,
        external_request_id: None,
        thread_id: None,
        options: recipe.options.clone(),
        remote_charge_uncertain: false,
    }
}
pub fn read_input(path: &Path, descriptor: &ArtifactDescriptor) -> Result<Input> {
    let bytes = read_regular(path, MAX_INPUT as usize)?;
    if bytes.len() as u64 != descriptor.byte_length
        || hex::encode(Sha256::digest(&bytes)) != descriptor.sha256
    {
        return Err(error(
            "input_changed",
            "Captured image input is missing or changed",
        ));
    }
    let mime = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        _ => {
            return Err(error(
                "invalid_request",
                "Captured image format is unsupported",
            ))
        }
    };
    if mime != descriptor.media_type {
        return Err(error(
            "input_changed",
            "Captured image format does not match its descriptor",
        ));
    }
    validate_image(&bytes, image::guess_format(&bytes).unwrap())?;
    Ok(Input {
        bytes,
        mime: mime.into(),
    })
}
pub fn read_regular(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(storage)?;
    if !file.metadata().map_err(storage)?.is_file()
        || file.metadata().map_err(storage)?.len() > max as u64
    {
        return Err(error(
            "invalid_response",
            "Image output must be a bounded regular file",
        ));
    }
    let mut bytes = vec![];
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(storage)?;
    if bytes.len() > max {
        return Err(error(
            "invalid_response",
            "Image data exceeds its size limit",
        ));
    }
    Ok(bytes)
}
pub fn validate_image(bytes: &[u8], format: image::ImageFormat) -> Result<()> {
    let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| error("invalid_response", "Unreadable image data"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16_777_216 {
        return Err(error(
            "invalid_response",
            "Image exceeds the 16 megapixel limit",
        ));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| error("invalid_response", "Invalid image data"))?;
    Ok(())
}
pub async fn generate(
    profile: Profile,
    recipe: EffectiveRecipe,
    inputs: Vec<Input>,
    key: Option<String>,
    host: Arc<dyn Host>,
    cancel: Arc<AtomicBool>,
    evidence: EvidenceSink,
) -> Result<Output> {
    if cancel.load(Ordering::Acquire) {
        return Err(error(
            "cancelled",
            "Image generation cancelled before dispatch",
        ));
    }
    match profile {
        Profile::Http { base_url, .. } => {
            http::generate(&base_url, &recipe, inputs, key, cancel).await
        }
        Profile::Codex {
            executable_path, ..
        } => tokio::task::spawn_blocking(move || {
            codex::generate(
                &executable_path,
                &recipe,
                &inputs,
                host.as_ref(),
                &cancel,
                evidence.as_ref(),
            )
        })
        .await
        .map_err(|_| error("interrupted", "Image worker was interrupted"))?,
    }
}
pub fn check_cli(path: &str) -> Result<()> {
    codex_executable::resolve(path).map(|_| ())
}
