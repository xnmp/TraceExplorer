use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
async fn interrupted<T>(
    future: impl std::future::Future<Output = Result<T>>,
    cancel: Arc<AtomicBool>,
) -> Result<T> {
    tokio::pin!(future);
    let watch = async {
        loop {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await
        }
    };
    tokio::select! {value=&mut future=>value,_=watch=>Err(error("cancelled_after_dispatch","Remote image request was cancelled locally; its remote outcome is unknown"))}
}
pub(super) async fn generate(
    root: &str,
    recipe: &EffectiveRecipe,
    inputs: Vec<Input>,
    key: Option<String>,
    cancel: Arc<AtomicBool>,
) -> Result<Output> {
    // Inherited native configuration (plan §18.3): proxies come only from the
    // HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY environment (curl semantics,
    // loopback is not bypassed); OS proxy settings are not read. TLS trust is
    // the platform verifier's OS store. Redirects and retries are never taken.
    let client = reqwest::Client::builder()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| error("unavailable", "Could not prepare the image HTTP client"))?;
    let fields = json!({"model":recipe.model,"prompt":recipe.submitted_prompt,"size":recipe.options.size,"quality":recipe.options.quality,"background":recipe.options.background,"output_format":"png","n":1});
    let mut request = client.post(format!(
        "{}/{}",
        root.trim_end_matches('/'),
        if inputs.is_empty() {
            "generations"
        } else {
            "edits"
        }
    ));
    if let Some(key) = key {
        request = request.bearer_auth(key)
    }
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
    interrupted(
        async {
            let response = request.send().await.map_err(|_| {
                error(
                    "remote_outcome_unknown",
                    "Image provider request failed; remote outcome is unknown",
                )
            })?;
            if response.status().is_server_error()
                || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
            {
                return Err(error(
                    "remote_outcome_unknown",
                    "Image provider did not confirm an outcome; generation may have occurred",
                ));
            }
            if !response.status().is_success() {
                return Err(error(
                    "provider_rejected",
                    "Image provider rejected the request; check endpoint, model and credentials",
                ));
            }
            let request_id = response
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok())
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                })
                .map(str::to_owned);
            let mut stream = response.bytes_stream();
            let mut bytes = vec![];
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    error(
                        "remote_outcome_unknown",
                        "Image provider response was interrupted",
                    )
                })?;
                if bytes.len().saturating_add(chunk.len()) > 70 * 1024 * 1024 {
                    return Err(error(
                        "invalid_response",
                        "Image response exceeds the 70 MiB limit",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    "invalid_response",
                    "Image provider returned unreadable JSON",
                )
            })?;
            let encoded = value["data"]
                .as_array()
                .filter(|data| data.len() == 1)
                .and_then(|data| data[0]["b64_json"].as_str())
                .ok_or_else(|| {
                    error(
                        "invalid_response",
                        "Image provider must return one base64 PNG result",
                    )
                })?;
            if encoded.len() > MAX_OUTPUT * 4 / 3 + 4 {
                return Err(error("invalid_response", "Image output exceeds 50 MiB"));
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| error("invalid_response", "Image provider returned invalid base64"))?;
            if bytes.len() > MAX_OUTPUT
                || image::guess_format(&bytes).ok() != Some(image::ImageFormat::Png)
            {
                return Err(error(
                    "invalid_response",
                    "Image provider returned an invalid PNG",
                ));
            }
            validate_image(&bytes, image::ImageFormat::Png)?;
            let mut metadata = metadata(recipe);
            metadata.external_request_id = request_id;
            metadata.actual_model = value["model"]
                .as_str()
                .filter(|s| {
                    !s.trim().is_empty()
                        && s.chars().count() <= 256
                        && !s.chars().any(char::is_control)
                })
                .map(str::to_owned);
            Ok(Output { bytes, metadata })
        },
        cancel,
    )
    .await
}
