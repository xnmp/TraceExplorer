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
//! (10 objects + 5 characters on 2.1), so `max_inputs` is our own limit of 8.
//!
//! Outcome mapping (<https://ai.google.dev/gemini-api/docs/api-errors>):
//! - non-2xx: the shared rule (`provider_rejected` / `remote_outcome_unknown`);
//! - an image block in a `model_output` step means an image was produced (and
//!   billed): the last one is the result, as the SDK's `output_image` does, and
//!   any diagnostic `errors` beside it are ignored. An image block without
//!   inline `data` (e.g. URI delivery) is `invalid_response` (Unknown), never a
//!   refusal;
//! - with no image block at all, one of the documented "generation blocked"
//!   codes (`safety`, `image_safety`, `prohibited_content`, `blocklist`,
//!   `recitation`, ...) in `error.code` or `errors[].code` is a definite
//!   `provider_refused`, worded from [`REFUSALS`] only, and so is a
//!   `completed` or `incomplete` interaction (no reason given); any other
//!   status or shape is `invalid_response` (Unknown), as is unparseable JSON.
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
        test_size: "auto",
        quality: &["auto"],
        background: &["auto"],
        resolution: true,
        aspect_ratio: true,
        sizes: false,
    },
    max_inputs: 8,
};
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

fn image_size(resolution: Option<&str>) -> Option<String> {
    resolution.map(str::to_ascii_uppercase)
}
fn aspect_ratio(value: Option<&str>) -> Option<&str> {
    value.filter(|v| API_RATIOS.contains(v))
}
pub(super) fn request_body(recipe: &EffectiveRecipe, inputs: &[Input]) -> Result<Value> {
    if let Some(problem) = crate::domain::model_options_problem(
        ApiKind::Gemini,
        recipe.model.as_deref(),
        &recipe.options,
    ) {
        return Err(error("invalid_request", problem));
    }
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
    Ok(json!({"model":recipe.model,"input":input,"response_format":format,"store":false}))
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
/// The last image block of the `model_output` steps, whatever its delivery.
/// Thought steps carry draft images and are skipped.
fn last_image_block(value: &Value) -> Option<&Value> {
    value["steps"]
        .as_array()?
        .iter()
        .filter(|step| step["type"] == "model_output")
        .flat_map(|step| step["content"].as_array().into_iter().flatten())
        .filter(|block| block["type"] == "image")
        .last()
}
/// Why a response holding no image block produced nothing: a documented block
/// code, or a finished interaction. Anything else is not a definite outcome.
fn no_image_failure(value: &Value) -> Failure {
    if let Some(code) = error_codes(value)
        .into_iter()
        .find(|code| REFUSALS.iter().any(|(known, _)| known == code))
    {
        return refused(&code, &REFUSALS);
    }
    if matches!(value["status"].as_str(), Some("completed" | "incomplete")) {
        refused("no_image", &REFUSALS)
    } else {
        Failure::Invalid("Image provider returned no image")
    }
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
        evidence,
    } = call;
    let request = client()?
        .post(format!(
            "{}/interactions",
            profile.base_url.trim_end_matches('/')
        ))
        .json(&request_body(recipe, &inputs)?);
    let reply = send(&DESCRIPTOR, key.as_deref(), &cancel, &stage, request).await?;
    let value: Value = serde_json::from_slice(&reply.body)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned unreadable JSON")))?;
    response_output(&value, recipe, profile, &stage, &evidence, reply.request_id)
}
fn response_output(
    value: &Value,
    recipe: &EffectiveRecipe,
    profile: &ApiProfile,
    stage: &StageSink,
    evidence: &EvidenceSink,
    request_id: Option<String>,
) -> Result<Output> {
    if let Some(billing) = crate::domain::billing::gemini(
        &value,
        value["model"]
            .as_str()
            .unwrap_or(recipe.model.as_deref().unwrap_or("")),
        &profile.base_url,
    ) {
        evidence(Evidence::Billing(billing))?;
    }
    let Some(block) = last_image_block(&value) else {
        return Err(outcome(no_image_failure(&value)));
    };
    let Some(encoded) = block["data"].as_str() else {
        return Err(outcome(Failure::Invalid(
            "Image provider returned an image without inline data",
        )));
    };
    if encoded.len() > MAX_OUTPUT * 4 / 3 + 4 {
        return Err(error("invalid_response", "Image output exceeds 50 MiB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned invalid base64")))?;
    output(
        recipe,
        stage,
        &bytes,
        request_id.or_else(|| safe_id(&value["id"])),
        value["model"].as_str(),
    )
}

#[cfg(test)]
mod billing_tests {
    use super::*;
    #[test]
    fn recorded_usage_is_emitted_before_invalid_image_decode() {
        let mut recipe: EffectiveRecipe =
            serde_json::from_str(include_str!("../../../tests/fixtures/recipe-v1.json")).unwrap();
        recipe.adapter = "gemini".into();
        recipe.model = Some("gemini-3-pro-image".into());
        let mut profile = ApiProfile {
            id: "api".into(),
            name: "API".into(),
            recipe_revision: "r".into(),
            base_url: DESCRIPTOR.default_base_url.into(),
            default_model: recipe.model.clone().unwrap(),
            allow_insecure_http: false,
            credential: crate::domain::Credential::None,
        };
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let events_for_assertion = captured.clone();
        let events = captured.clone();
        let evidence: EvidenceSink = Arc::new(move |event| {
            if let Evidence::Billing(billing) = event {
                events.lock().unwrap().push(billing);
            }
            Ok(())
        });
        let stage: StageSink = Arc::new(|_| {});
        let value = json!({"usage":{"total_input_tokens":1000,"total_output_tokens":2000,"total_thought_tokens":100,"output_tokens_by_modality":[{"modality":"image","tokens":2000}]},"steps":[{"type":"model_output","content":[{"type":"image","data":"bad base64"}]}]});
        let failure = response_output(&value, &recipe, &profile, &stage, &evidence, None)
            .err()
            .unwrap();
        assert_eq!(failure.code, "invalid_response");
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].cost.as_ref().unwrap().amount, "0.2432");
        assert!(captured[0].evidence.is_some());
        drop(captured);
        profile.base_url = "https://gateway.example/v1beta".into();
        assert!(response_output(&value, &recipe, &profile, &stage, &evidence, None).is_err());
        let captured = events_for_assertion.lock().unwrap();
        assert_eq!(captured.len(), 2);
        assert!(captured[1].cost.is_none());
        assert_eq!(captured[1].evidence, captured[0].evidence);
    }
}
