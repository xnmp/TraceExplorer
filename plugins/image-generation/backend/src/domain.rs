//! Pure profile/recipe policy; never opens files or contacts a provider.
pub mod backend_rules;
pub mod codex_evidence;
pub mod credential_rules;
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
    Command { argv: Vec<String> },
    CliSavedLogin,
}
/// One HTTP image-API connection. Every API backend shares this exact shape;
/// the backend is chosen by the owning `Profile` variant's `transport` tag.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    pub recipe_revision: String,
    pub base_url: String,
    pub default_model: String,
    pub allow_insecure_http: bool,
    pub credential: Credential,
}
/// The HTTP image backends. Each kind has a descriptor and adapter module in
/// `adapters::api`; see the provider README for the add-a-backend checklist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiKind {
    OpenAiImages,
    Gemini,
    Bfl,
    /// Test-only extra backend proving a new kind needs no consumer changes.
    #[cfg(feature = "test-hooks")]
    Fixture,
}
impl ApiKind {
    /// Every kind, for registry consistency tests.
    pub const ALL: &'static [ApiKind] = &[
        ApiKind::OpenAiImages,
        ApiKind::Gemini,
        ApiKind::Bfl,
        #[cfg(feature = "test-hooks")]
        ApiKind::Fixture,
    ];
    pub fn transport(&self) -> &'static str {
        crate::adapters::api::descriptor(*self).transport
    }
}
/// What a connection is: the Codex CLI or an HTTP API of some kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Codex,
    Api(ApiKind),
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
    OpenAiImages(ApiProfile),
    #[serde(rename = "gemini")]
    Gemini(ApiProfile),
    #[serde(rename = "bfl")]
    Bfl(ApiProfile),
    #[cfg(feature = "test-hooks")]
    #[serde(rename = "fixture-images")]
    Fixture(ApiProfile),
}
impl Profile {
    pub fn api(&self) -> Option<(ApiKind, &ApiProfile)> {
        match self {
            Self::Codex { .. } => None,
            Self::OpenAiImages(p) => Some((ApiKind::OpenAiImages, p)),
            Self::Gemini(p) => Some((ApiKind::Gemini, p)),
            Self::Bfl(p) => Some((ApiKind::Bfl, p)),
            #[cfg(feature = "test-hooks")]
            Self::Fixture(p) => Some((ApiKind::Fixture, p)),
        }
    }
    pub fn api_mut(&mut self) -> Option<(ApiKind, &mut ApiProfile)> {
        match self {
            Self::Codex { .. } => None,
            Self::OpenAiImages(p) => Some((ApiKind::OpenAiImages, p)),
            Self::Gemini(p) => Some((ApiKind::Gemini, p)),
            Self::Bfl(p) => Some((ApiKind::Bfl, p)),
            #[cfg(feature = "test-hooks")]
            Self::Fixture(p) => Some((ApiKind::Fixture, p)),
        }
    }
    pub fn kind(&self) -> Kind {
        self.api().map_or(Kind::Codex, |(kind, _)| Kind::Api(kind))
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Codex { id, .. } => id,
            _ => self.api().map_or("", |(_, p)| &p.id),
        }
    }
    pub fn revision(&self) -> &str {
        match self {
            Self::Codex {
                recipe_revision, ..
            } => recipe_revision,
            _ => self.api().map_or("", |(_, p)| &p.recipe_revision),
        }
    }
    pub fn set_revision(&mut self, value: String) {
        match self {
            Self::Codex {
                recipe_revision, ..
            } => *recipe_revision = value,
            _ => {
                if let Some((_, p)) = self.api_mut() {
                    p.recipe_revision = value
                }
            }
        }
    }
    pub fn credential(&self) -> &Credential {
        match self {
            Self::Codex { credential, .. } => credential,
            _ => self.api().map_or(&Credential::None, |(_, p)| &p.credential),
        }
    }
    pub fn credential_mut(&mut self) -> &mut Credential {
        match self {
            Self::Codex { credential, .. } => credential,
            // Every non-Codex variant is an API variant, so `api_mut` is Some.
            other => {
                &mut other
                    .api_mut()
                    .expect("non-Codex profile is an API profile")
                    .1
                    .credential
            }
        }
    }
    pub fn execution_identity(&self) -> serde_json::Value {
        match self {
            Self::Codex {
                executable_path,
                credential,
                ..
            } => json!(["codex-cli", executable_path, credential]),
            _ => self.api().map_or(json!(null), |(kind, p)| {
                json!([
                    kind.transport(),
                    p.base_url,
                    p.default_model,
                    p.allow_insecure_http,
                    p.credential
                ])
            }),
        }
    }
}
/// Transport and adapter names: `^[a-z][a-z0-9-]{0,63}$`, the same rule the host
/// applies to receipts.
pub fn transport_id(value: &str) -> bool {
    value.len() <= 64
        && value.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
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
/// Normalises an API base URL: the generic rules, then the backend's data rules
/// from `backends.json`.
pub fn root(value: &str, allow_http: bool) -> Result<String> {
    base_url(ApiKind::OpenAiImages, value, allow_http)
}
pub fn base_url(kind: ApiKind, value: &str, allow_http: bool) -> Result<String> {
    if value.len() > 2048 {
        return Err(invalid("API URL exceeds 2048 bytes"));
    }
    let url = url::Url::parse(value).map_err(|_| invalid("Enter an absolute API URL"))?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(invalid(
            "API URL cannot contain credentials, queries or fragments",
        ));
    }
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && (allow_http || local)) {
        return Err(invalid("Use HTTPS or explicitly allow insecure HTTP"));
    }
    if let Some(problem) = backend_rules::for_transport(kind.transport())
        .and_then(|rules| rules.base_url_problem(&url))
    {
        return Err(invalid(&problem));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
/// Why `model` cannot be used with this backend, from its `backends.json` rules.
pub fn model_problem(kind: ApiKind, model: &str) -> Option<&'static str> {
    backend_rules::for_transport(kind.transport()).and_then(|rules| rules.model_problem(model))
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
            api => {
                let Some((kind, api)) = api.api_mut() else {
                    continue;
                };
                if !label(&api.name) || !label(&api.default_model) {
                    return Err(invalid("Enter bounded profile name and model ID"));
                }
                if let Some(problem) = model_problem(kind, &api.default_model) {
                    return Err(invalid(&problem));
                }
                api.base_url = base_url(kind, &api.base_url, api.allow_insecure_http)?;
                match &api.credential {
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
                    Credential::Command { argv } => credential_rules::validate_argv(argv)?,
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
            .is_some_and(|v| !RESOLUTIONS.contains(&v))
        || o.aspect_ratio
            .as_deref()
            .is_some_and(|v| !ASPECT_RATIOS.contains(&v))
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
        api => {
            let (kind, api) = api
                .api()
                .ok_or_else(|| invalid("Unsupported image connection"))?;
            let descriptor = crate::adapters::api::descriptor(kind);
            if request.inputs.len() > descriptor.max_inputs {
                return Err(invalid("Too many input images for this image provider"));
            }
            if let Some(problem) = options_problem(descriptor, &request.options) {
                return Err(invalid(&problem));
            }
            let model = request
                .model
                .clone()
                .filter(|m| label(m))
                .ok_or_else(|| invalid("Enter a nonempty image model ID"))?;
            if let Some(problem) = model_problem(kind, &model) {
                return Err(invalid(&problem));
            }
            let prompt = if request.inputs.len() <= 1 {
                request.prompt.clone()
            } else {
                format!(
                    "{} User's visual request: {}",
                    framing(request.inputs.len()).unwrap(),
                    json!({"prompt":request.prompt})
                )
            };
            (
                descriptor.transport,
                api.base_url.clone(),
                Some(model),
                prompt,
                None,
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
/// Why a backend cannot honour these options, using the same descriptor tables
/// `capabilities()` publishes. Resolution and aspect ratio are also what a client
/// derives pixel sizes from, so a backend with `sizes` accepts them as well.
pub fn options_problem(
    d: &crate::adapters::api::ApiDescriptor,
    o: &te_image_generation_contract::ImageOptions,
) -> Option<&'static str> {
    let o_ = &d.options;
    if !o_.quality.contains(&o.quality.as_str()) || !o_.background.contains(&o.background.as_str())
    {
        Some("This image provider does not support that quality or background")
    } else if !o_.sizes && o.size != "auto" {
        Some("This image provider chooses its own image size")
    } else if o.resolution.is_some() && !(o_.sizes || o_.resolution) {
        Some("This image provider does not support a resolution")
    } else if o.aspect_ratio.is_some() && !(o_.sizes || o_.aspect_ratio) {
        Some("This image provider does not support an aspect ratio")
    } else {
        None
    }
}
/// Per-connection capabilities, built from the backend's descriptor for API kinds.
/// `sizes` is part of the published contract and is omitted only for a backend
/// that sets `options.sizes = false`; `resolution` / `aspectRatio` are additive.
pub fn capabilities(kind: Kind) -> serde_json::Value {
    let mut value = json!({"generation":true,"edit":true,"maxInputs":8,"maxInputBytes":MAX_INPUT,"maxTotalInputBytes":MAX_TOTAL,"maxOutputBytes":MAX_OUTPUT,"inputFormats":["image/png","image/jpeg","image/webp"],"outputFormats":["image/png"],"modelSelection":kind != Kind::Codex,"sizes":{"auto":true,"maxEdge":3840,"multipleOf":16,"minPixels":655360,"maxPixels":8294400},"quality":["auto"],"background":["auto"]});
    if let Kind::Api(kind) = kind {
        let d = crate::adapters::api::descriptor(kind);
        value["maxInputs"] = json!(d.max_inputs);
        value["quality"] = json!(d.options.quality);
        value["background"] = json!(d.options.background);
        if !d.options.sizes {
            value.as_object_mut().map(|o| o.remove("sizes"));
        }
        if d.options.resolution {
            value["resolution"] = json!(RESOLUTIONS);
        }
        if d.options.aspect_ratio {
            value["aspectRatio"] = json!(ASPECT_RATIOS);
        }
    }
    value
}
pub const RESOLUTIONS: [&str; 3] = ["1k", "2k", "4k"];
pub const ASPECT_RATIOS: [&str; 8] = ["keep", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];
