//! OpenAI Images API: `/generations` JSON or `/edits` multipart, bearer auth,
//! `data[0].b64_json` image.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub const DESCRIPTOR: ApiDescriptor = ApiDescriptor {
    transport: "openai-images",
    default_base_url: "https://api.openai.com/v1/images",
    credential_env: "OPENAI_API_KEY",
    auth: Auth::Bearer,
    options: Options {
        test_size: "1024x1024",
        quality: &["auto", "low", "medium", "high"],
        background: &["auto", "opaque", "transparent"],
        resolution: false,
        aspect_ratio: false,
        sizes: true,
    },
    max_inputs: 8,
};
pub(super) fn request_body(recipe: &EffectiveRecipe) -> Result<Value> {
    if let Some(problem) = crate::domain::model_options_problem(
        ApiKind::OpenAiImages,
        recipe.model.as_deref(),
        &recipe.options,
    ) {
        return Err(error("invalid_request", problem));
    }
    Ok(
        json!({"model":recipe.model,"prompt":recipe.submitted_prompt,"size":recipe.options.size,"quality":recipe.options.quality,"background":recipe.options.background,"output_format":"png","n":1}),
    )
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
    let client = client()?;
    let fields = request_body(recipe)?;
    let mut request = client.post(format!(
        "{}/{}",
        profile.base_url.trim_end_matches('/'),
        if inputs.is_empty() {
            "generations"
        } else {
            "edits"
        }
    ));
    if inputs.is_empty() {
        request = request.json(&fields)
    } else {
        let mut form = reqwest::multipart::Form::new();
        for (name, value) in fields.as_object().unwrap() {
            form = form.text(
                name.clone(),
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
        for (index, input) in inputs.into_iter().enumerate() {
            let extension = match input.mime.as_str() {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let part = reqwest::multipart::Part::bytes(input.bytes)
                .file_name(format!("source-{}.{extension}", index + 1))
                .mime_str(&input.mime)
                .map_err(|_| error("invalid_request", "Invalid image input media type"))?;
            form = form.part("image[]", part);
        }
        request = request.multipart(form)
    }
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
    if let Some(billing) = crate::domain::billing::openai(
        &value,
        value["model"]
            .as_str()
            .unwrap_or(recipe.model.as_deref().unwrap_or("")),
        &profile.base_url,
    ) {
        evidence(Evidence::Billing(billing))?;
    }
    let encoded = value["data"]
        .as_array()
        .filter(|data| data.len() == 1)
        .and_then(|data| data[0]["b64_json"].as_str())
        .ok_or_else(|| {
            outcome(Failure::Invalid(
                "Image provider must return one base64 PNG result",
            ))
        })?;
    if encoded.len() > MAX_OUTPUT * 4 / 3 + 4 {
        return Err(error("invalid_response", "Image output exceeds 50 MiB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned invalid base64")))?;
    output(recipe, stage, &bytes, request_id, value["model"].as_str())
}

#[cfg(test)]
mod billing_tests {
    use super::*;
    #[test]
    fn recorded_usage_is_emitted_before_invalid_image_decode() {
        let mut recipe: EffectiveRecipe =
            serde_json::from_str(include_str!("../../../tests/fixtures/recipe-v1.json")).unwrap();
        recipe.adapter = "openai-images".into();
        recipe.model = Some("gpt-image-1".into());
        let profile = ApiProfile {
            id: "api".into(),
            name: "API".into(),
            recipe_revision: "r".into(),
            base_url: DESCRIPTOR.default_base_url.into(),
            default_model: recipe.model.clone().unwrap(),
            allow_insecure_http: false,
            credential: crate::domain::Credential::None,
        };
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let events = captured.clone();
        let evidence: EvidenceSink = Arc::new(move |event| {
            if let Evidence::Billing(billing) = event {
                events.lock().unwrap().push(billing);
            }
            Ok(())
        });
        let stage: StageSink = Arc::new(|_| {});
        let value = json!({"usage":{"input_tokens":1000,"output_tokens":2000,"total_tokens":3000,"input_tokens_details":{"image_tokens":800,"text_tokens":200}},"data":[{"b64_json":"bad base64"}]});
        let failure = response_output(&value, &recipe, &profile, &stage, &evidence, None)
            .err()
            .unwrap();
        assert_eq!(failure.code, "invalid_response");
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].cost.as_ref().unwrap().amount, "0.089");
        assert!(captured[0].evidence.is_some());
    }
}
