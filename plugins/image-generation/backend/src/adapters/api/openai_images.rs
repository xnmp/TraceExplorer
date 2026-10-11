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
        quality: &["auto", "low", "medium", "high"],
        background: &["auto", "opaque", "transparent"],
        resolution: false,
        aspect_ratio: false,
        sizes: true,
    },
    max_inputs: 8,
    validate_base_url,
};
/// The root is the images resource, not one of its operations.
fn validate_base_url(url: &url::Url) -> Result<()> {
    let last = url
        .path()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("");
    if ["generations", "edits"].contains(&last) {
        return Err(crate::error::invalid(
            "Enter the images resource root, without generations or edits",
        ));
    }
    Ok(())
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
    let client = client()?;
    let fields = json!({"model":recipe.model,"prompt":recipe.submitted_prompt,"size":recipe.options.size,"quality":recipe.options.quality,"background":recipe.options.background,"output_format":"png","n":1});
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
    output(
        recipe,
        &stage,
        &bytes,
        reply.request_id,
        value["model"].as_str(),
    )
}
