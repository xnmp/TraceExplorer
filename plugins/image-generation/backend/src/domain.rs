//! Pure profile/recipe policy; never opens files or contacts a provider.
pub mod codex_evidence;
pub mod stored_receipt;
use crate::error::{invalid, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use te_image_generation_contract::{
    valid_digest, valid_operation_id, EffectiveRecipe, PrepareRequest, StartRequest,
};
pub const MAX_INPUT: u64 = 20 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 64 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 50 * 1024 * 1024;
/// Wall-clock evidence cannot extend the original live monotonic budget.
pub fn remaining_budget(
    deadline_ms: i64,
    now_ms: i64,
    original: std::time::Duration,
) -> std::time::Duration {
    std::time::Duration::from_millis(deadline_ms.saturating_sub(now_ms).max(0) as u64).min(original)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Credential {
    None,
    Environment { name: String },
    Secret { id: String },
    CliSavedLogin,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "transport",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Profile {
    #[serde(rename = "codex-cli")]
    Codex {
        id: String,
        name: String,
        recipe_revision: String,
        executable_path: String,
        model_selection: bool,
        credential: Credential,
    },
    #[serde(rename = "openai-images")]
    Http {
        id: String,
        name: String,
        recipe_revision: String,
        base_url: String,
        default_model: String,
        allow_insecure_http: bool,
        credential: Credential,
    },
}
impl Profile {
    pub fn id(&self) -> &str {
        match self {
            Self::Codex { id, .. } | Self::Http { id, .. } => id,
        }
    }
    pub fn revision(&self) -> &str {
        match self {
            Self::Codex {
                recipe_revision, ..
            }
            | Self::Http {
                recipe_revision, ..
            } => recipe_revision,
        }
    }
    pub fn set_revision(&mut self, value: String) {
        match self {
            Self::Codex {
                recipe_revision, ..
            }
            | Self::Http {
                recipe_revision, ..
            } => *recipe_revision = value,
        }
    }
    pub fn credential(&self) -> &Credential {
        match self {
            Self::Codex { credential, .. } | Self::Http { credential, .. } => credential,
        }
    }
    pub fn credential_mut(&mut self) -> &mut Credential {
        match self {
            Self::Codex { credential, .. } | Self::Http { credential, .. } => credential,
        }
    }
    pub fn execution_identity(&self) -> serde_json::Value {
        match self {
            Self::Codex {
                executable_path,
                credential,
                ..
            } => json!(["codex-cli", executable_path, credential]),
            Self::Http {
                base_url,
                default_model,
                allow_insecure_http,
                credential,
                ..
            } => json!([
                "openai-images",
                base_url,
                default_model,
                allow_insecure_http,
                credential
            ]),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub schema_version: u32,
    pub document_revision: u64,
    pub default_connection_id: Option<String>,
    pub profiles: Vec<Profile>,
}
impl Default for Configuration {
    fn default() -> Self {
        Self {
            schema_version: 1,
            document_revision: 0,
            default_connection_id: None,
            profiles: vec![],
        }
    }
}
pub fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}
pub fn root(value: &str, allow_http: bool) -> Result<String> {
    if value.len() > 2048 {
        return Err(invalid("Images resource root exceeds 2048 bytes"));
    }
    let url =
        url::Url::parse(value).map_err(|_| invalid("Enter an absolute images resource root"))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid(
            "Images root cannot contain credentials, queries or fragments",
        ));
    }
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && (allow_http || local)) {
        return Err(invalid("Use HTTPS or explicitly allow insecure HTTP"));
    }
    let value = url.as_str().trim_end_matches('/').to_owned();
    if ["generations", "edits"].contains(
        &url.path()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(""),
    ) {
        return Err(invalid(
            "Enter the images resource root, without generations or edits",
        ));
    }
    Ok(value)
}
pub fn validate_configuration(configuration: &mut Configuration) -> Result<()> {
    if configuration.schema_version != 1 {
        return Err(invalid("Unsupported image configuration schema"));
    }
    if configuration.profiles.len() > 32 {
        return Err(invalid("At most 32 image profiles are supported"));
    }
    let mut ids = std::collections::HashSet::new();
    for profile in &mut configuration.profiles {
        if !id(profile.id()) || !ids.insert(profile.id().to_owned()) {
            return Err(invalid("Profile IDs must be unique bounded identifiers"));
        }
        match profile {
            Profile::Codex {
                name,
                executable_path,
                model_selection,
                credential,
                ..
            } => {
                if !label(name)
                    || *model_selection
                    || *credential != Credential::CliSavedLogin
                    || executable_path.len() > 8192
                    || executable_path.chars().any(char::is_control)
                    || (!executable_path.is_empty()
                        && !std::path::Path::new(executable_path).is_absolute())
                {
                    return Err(invalid("Codex uses saved login and an optional absolute executable path, with an adapter-managed image model"));
                }
            }
            Profile::Http {
                name,
                base_url,
                default_model,
                allow_insecure_http,
                credential,
                ..
            } => {
                if !label(name) || !label(default_model) {
                    return Err(invalid("Enter bounded profile name and model ID"));
                }
                *base_url = root(base_url, *allow_insecure_http)?;
                match credential {
                    Credential::Environment { name }
                        if name.len() > 128
                            || name.is_empty()
                            || !name.bytes().enumerate().all(|(i, b)| {
                                b == b'_'
                                    || b.is_ascii_alphabetic()
                                    || (i > 0 && b.is_ascii_digit())
                            }) =>
                    {
                        return Err(invalid("Invalid credential environment variable name"))
                    }
                    Credential::Secret { id: secret } if !id(secret) => {
                        return Err(invalid("Invalid saved credential reference"))
                    }
                    Credential::CliSavedLogin => {
                        return Err(invalid("HTTP profiles cannot use CLI login"))
                    }
                    _ => {}
                }
            }
        }
    }
    if configuration
        .default_connection_id
        .as_ref()
        .is_some_and(|selected| !ids.contains(selected))
    {
        return Err(invalid(
            "Select an existing image default or leave it unconfigured",
        ));
    }
    Ok(())
}
pub fn valid_size(value: &str) -> bool {
    if value == "auto" {
        return true;
    }
    let Some((w, h)) = value
        .split_once('x')
        .and_then(|(w, h)| Some((w.parse::<u64>().ok()?, h.parse::<u64>().ok()?)))
    else {
        return false;
    };
    w > 0
        && h > 0
        && w <= 3840
        && h <= 3840
        && w % 16 == 0
        && h % 16 == 0
        && w <= h * 3
        && h <= w * 3
        && (655360..=8294400).contains(&(w * h))
}
pub fn validate_prepare(request: &PrepareRequest) -> Result<()> {
    if !valid_operation_id(&request.operation_id)
        || !id(&request.connection_id)
        || !id(&request.expected_connection_revision)
    {
        return Err(invalid("Invalid operation/profile/revision identifier"));
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > 16000 {
        return Err(invalid("Enter an image prompt of 1–16,000 bytes"));
    }
    if request.inputs.len() > 8
        || request.inputs.iter().any(|a| {
            !valid_digest(&a.sha256)
                || a.handle.is_empty()
                || a.handle.len() > 128
                || a.byte_length > MAX_INPUT
                || !["image/png", "image/jpeg", "image/webp"].contains(&a.media_type.as_str())
        })
        || request.inputs.iter().map(|a| a.byte_length).sum::<u64>() > MAX_TOTAL
    {
        return Err(invalid(
            "Choose up to eight PNG/JPEG/WebP images, at most 20 MiB each and 64 MiB total",
        ));
    }
    let o = &request.options;
    if !valid_size(&o.size)
        || !matches!(o.quality.as_str(), "auto" | "low" | "medium" | "high")
        || !matches!(o.background.as_str(), "auto" | "opaque" | "transparent")
        || o.resolution
            .as_deref()
            .is_some_and(|v| !["1k", "2k", "4k"].contains(&v))
        || o.aspect_ratio.as_deref().is_some_and(|v| {
            !["keep", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"].contains(&v)
        })
    {
        return Err(invalid("Unsupported image options"));
    }
    Ok(())
}
pub fn framing(count: usize) -> Option<String> {
    match count{0=>None,1=>Some("One image is attached, Image 1. Preserve its details that the request does not ask to change.".into()),n=>Some(format!("{n} images are attached, numbered Image 1 to Image {n} in the order they are attached. They are equal inputs; none is the main image. The request may refer to them by number (for example \"the hat in Image 2\"); use each image as the request describes, and preserve details the request does not ask to change."))}
}
pub fn recipe(profile: &Profile, request: &PrepareRequest) -> Result<EffectiveRecipe> {
    validate_prepare(request)?;
    if profile.id() != request.connection_id
        || profile.revision() != request.expected_connection_revision
    {
        return Err(invalid("Image connection changed; prepare again"));
    }
    let (adapter, endpoint, model, submitted_prompt, agent_task) = match profile {
        Profile::Http { base_url, .. } => {
            let model = request
                .model
                .clone()
                .filter(|m| label(m))
                .ok_or_else(|| invalid("Enter a nonempty image model ID"))?;
            let prompt = if request.inputs.len() <= 1 {
                request.prompt.clone()
            } else {
                format!(
                    "{} User's visual request: {}",
                    framing(request.inputs.len()).unwrap(),
                    json!({"prompt":request.prompt})
                )
            };
            ("openai-images", base_url.clone(), Some(model), prompt, None)
        }
        Profile::Codex {
            executable_path, ..
        } => {
            if request.model.is_some()
                || request.options.quality != "auto"
                || request.options.background != "auto"
            {
                return Err(invalid(
                    "Codex image model and defaults are adapter-managed",
                ));
            }
            let task=format!("Use the built-in image generation tool exactly once to {} an image for a local image editor. The following JSON contains the user's visual request: {}. Use the requested pixel dimensions for the image generation tool when size is not auto. {} Return the generated image and leave it at the normal built-in generated-images location. Do not copy or move the result, execute commands, read files, use other tools, or call an API separately. If image generation is unavailable, report that and stop.",if request.inputs.is_empty(){"generate"}else{"edit"},json!({"prompt":request.prompt,"size":request.options.size,"resolution":request.options.resolution,"aspect_ratio":request.options.aspect_ratio}),framing(request.inputs.len()).unwrap_or_default());
            (
                "codex-cli",
                if executable_path.trim().is_empty() {
                    "codex-cli:auto-discovery".into()
                } else {
                    executable_path.clone()
                },
                None,
                request.prompt.clone(),
                Some(task),
            )
        }
    };
    Ok(EffectiveRecipe {
        schema_version: 1,
        formatter_version: 1,
        connection_id: profile.id().into(),
        connection_revision: profile.revision().into(),
        adapter: adapter.into(),
        endpoint_identity: endpoint,
        model,
        options: request.options.clone(),
        input_digests: request.inputs.iter().map(|a| a.sha256.clone()).collect(),
        input_roles: (1..=request.inputs.len())
            .map(|n| format!("Image {n}"))
            .collect(),
        submitted_prompt,
        agent_task,
    })
}
/// Logical request fingerprint excludes transient token/handles and caller epoch.
pub fn semantic(request: &StartRequest) -> String {
    let canonical = json!({"operationId":request.operation_id,"connectionId":request.connection_id,"connectionRevision":request.expected_connection_revision,"model":request.model,"prompt":request.prompt,"inputs":request.inputs.iter().map(|a|json!({"sha256":a.sha256,"byteLength":a.byte_length,"mediaType":a.media_type})).collect::<Vec<_>>(),"options":request.options,"effectiveRecipeDigest":request.effective_recipe_digest});
    hex::encode(Sha256::digest(serde_json::to_vec(&canonical).unwrap()))
}
pub fn capabilities(cli: bool) -> serde_json::Value {
    json!({"generation":true,"edit":true,"maxInputs":8,"maxInputBytes":MAX_INPUT,"maxTotalInputBytes":MAX_TOTAL,"maxOutputBytes":MAX_OUTPUT,"inputFormats":["image/png","image/jpeg","image/webp"],"outputFormats":["image/png"],"modelSelection":!cli,"sizes":{"auto":true,"maxEdge":3840,"multipleOf":16,"minPixels":655360,"maxPixels":8294400},"quality":if cli{vec!["auto"]}else{vec!["auto","low","medium","high"]},"background":if cli{vec!["auto"]}else{vec!["auto","opaque","transparent"]}})
}
