//! Nano Banana (Google Gemini image models) through the Interactions API:
//! `POST {base}/interactions`, `x-goog-api-key` auth, image from
//! `steps[].content[]`.
//!
//! Endpoint choice. Google documents the Interactions API as generally
//! available and "recommended for all new projects"
//! (<https://ai.google.dev/gemini-api/docs/interactions>), and every image
//! example on the image-generation page, for generation and for editing with up
//! to 14 reference images, uses it
//! (<https://ai.google.dev/gemini-api/docs/image-generation>). The same page
//! documents the image options this adapter sends and the REST reference lists
//! their values (<https://ai.google.dev/api/interactions-api>):
//! `response_format: {type:"image", aspect_ratio, image_size}` with `image_size`
//! `512|1K|2K|4K` (case sensitive) and ratios
//! `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9 1:8 8:1 1:4 4:1`.
//! `generateContent` "remains fully supported" but is described as legacy, and
//! its `imageConfig` is not documented on the image page, so it is not used.
//!
//! Request: `{model, input:[{type:text,text}, {type:image,mime_type,data}...],
//! response_format, store:false}`. Images follow the text in attachment order.
//! `store:false` keeps the user's images from being retained server side.
//! "keep" omits `aspect_ratio` (the field is optional, so the model follows the
//! inputs); no quality or background control exists, so those stay `auto`.
//!
//! Limits: up to 14 reference images per request for the Nano Banana models
//! (10 objects + 4 characters on 2.1), so `max_inputs` is our own limit of 8.
//!
//! Outcome mapping (<https://ai.google.dev/gemini-api/docs/api-errors>):
//! - non-2xx: the shared rule (`provider_rejected` / `remote_outcome_unknown`);
//! - a 200 whose body carries one of the documented "generation blocked" codes
//!   (`safety`, `image_safety`, `prohibited_content`, `blocklist`,
//!   `recitation`, ...) in `error.code` or `errors[].code`, or `no_image`, is a
//!   definite `provider_refused`, worded from [`REFUSALS`] only;
//! - a `completed` or `incomplete` interaction with no image part is a
//!   definite refusal with no reason; any other status or shape is
//!   `invalid_response` (Unknown), as is unparseable JSON.
//!
//! The docs do not say which of those carriers a blocked generation uses (nor
//! whether it is a 200), so all are accepted; a blocked code delivered with a
//! 4xx status is reported by the shared rule as `provider_rejected`.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub const DESCRIPTOR: ApiDescriptor = ApiDescriptor {
    transport: "gemini",
    default_base_url: "https://generativelanguage.googleapis.com/v1beta",
    credential_env: "GEMINI_API_KEY",
    auth: Auth::Header("x-goog-api-key"),
    options: Options {
        quality: &["auto"],
        background: &["auto"],
        resolution: true,
        aspect_ratio: true,
        sizes: false,
    },
    max_inputs: 8,
    validate_base_url,
};
/// Recommended Nano Banana model (documented as the one for new projects).
pub const DEFAULT_MODEL: &str = "gemini-nano-banana-2.1";

/// Documented aspect ratios (`ImageResponseFormat.aspect_ratio`). Our shared
/// list is a subset, so every non-"keep" ratio we offer is accepted.
const API_RATIOS: [&str; 14] = [
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1", "1:4",
    "4:1",
];
/// Documented generation-blocked codes (api-errors page) plus `no_image`.
pub const REFUSALS: [(&str, Refusal); 12] = [
    ("safety", Refusal::Safety),
    ("image_safety", Refusal::Safety),
    ("prohibited_content", Refusal::Policy),
    ("image_prohibited_content", Refusal::Policy),
    ("blocklist", Refusal::Policy),
    ("recitation", Refusal::Policy),
    ("image_recitation", Refusal::Policy),
    ("spii", Refusal::Policy),
    ("language", Refusal::Other),
    ("image_other", Refusal::Other),
    ("content_blocked", Refusal::Other),
    ("no_image", Refusal::Other),
];

/// The root is the API version root; the adapter appends `/interactions`.
fn validate_base_url(url: &url::Url) -> Result<()> {
    let path = url.path();
    if path.contains(':')
        || path
            .split('/')
            .any(|segment| ["models", "interactions"].contains(&segment))
    {
        return Err(crate::error::invalid(
            "Enter the API version root, without models, interactions or :generateContent",
        ));
    }
    Ok(())
}
fn image_size(resolution: Option<&str>) -> Option<String> {
    resolution.map(str::to_ascii_uppercase)
}
fn aspect_ratio(value: Option<&str>) -> Option<&str> {
    value.filter(|v| API_RATIOS.contains(v))
}
fn request_body(recipe: &EffectiveRecipe, inputs: &[Input]) -> Value {
    let mut input = vec![json!({"type":"text","text":recipe.submitted_prompt})];
    input.extend(inputs.iter().map(
        |image| json!({"type":"image","mime_type":image.mime,"data":STANDARD.encode(&image.bytes)}),
    ));
    let mut format = json!({"type":"image"});
    if let Some(ratio) = aspect_ratio(recipe.options.aspect_ratio.as_deref()) {
        format["aspect_ratio"] = json!(ratio);
    }
    if let Some(size) = image_size(recipe.options.resolution.as_deref()) {
        format["image_size"] = json!(size);
    }
    json!({"model":recipe.model,"input":input,"response_format":format,"store":false})
}
/// Documented blocked/error codes reported by the response, lower-cased.
fn error_codes(value: &Value) -> Vec<String> {
    let single = value["error"]["code"].as_str();
    let many = value["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["code"].as_str());
    single
        .into_iter()
        .chain(many)
        .map(str::to_ascii_lowercase)
        .collect()
}
/// The first image block of the first `model_output` step carrying one.
fn first_image(value: &Value) -> Option<&str> {
    value["steps"]
        .as_array()?
        .iter()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .find(|block| block["type"] == "image" && block["data"].is_string())
        .and_then(|block| block["data"].as_str())
}
fn safe_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .map(str::to_owned)
}
pub(super) async fn generate(call: ApiCall<'_>) -> Result<Output> {
    let ApiCall {
        profile,
        recipe,
        inputs,
        key,
        cancel,
        stage,
    } = call;
    let request = client()?
        .post(format!(
            "{}/interactions",
            profile.base_url.trim_end_matches('/')
        ))
        .json(&request_body(recipe, &inputs));
    let reply = send(&DESCRIPTOR, key.as_deref(), &cancel, &stage, request).await?;
    let value: Value = serde_json::from_slice(&reply.body)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned unreadable JSON")))?;
    // An explicit, documented block wins over everything else in the body.
    if let Some(code) = error_codes(&value)
        .into_iter()
        .find(|code| REFUSALS.iter().any(|(known, _)| known == code))
    {
        return Err(outcome(refused(&code, &REFUSALS)));
    }
    let Some(encoded) = first_image(&value) else {
        return Err(outcome(
            if matches!(value["status"].as_str(), Some("completed" | "incomplete")) {
                refused("no_image", &REFUSALS)
            } else {
                Failure::Invalid("Image provider returned no image")
            },
        ));
    };
    if encoded.len() > MAX_OUTPUT * 4 / 3 + 4 {
        return Err(error("invalid_response", "Image output exceeds 50 MiB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned invalid base64")))?;
    output(
        recipe,
        &stage,
        &bytes,
        reply.request_id.or_else(|| safe_id(&value["id"])),
        value["model"].as_str(),
    )
}
