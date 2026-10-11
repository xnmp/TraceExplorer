//! HTTP image backends. A backend is one module here plus one arm in each of
//! `descriptor` and `generate`; everything shared lives in this file so a module
//! only builds its request and parses its response.
//!
//! Outcome rule, applied to every backend through [`outcome`]:
//! - transport failure, interrupted response, 5xx or 408: the provider may have
//!   generated (and charged), so the result is `remote_outcome_unknown`;
//! - any other non-2xx status: definitive `provider_rejected` (fixed wording and
//!   the status number; provider prose is never copied into receipts);
//! - a 200 that explicitly refuses (safety/moderation): definitive
//!   `provider_refused`, worded from a fixed table keyed by a structured reason;
//! - a 200 that is unparseable or lacks the image: `invalid_response`, unknown.
//!
//! `service.rs` maps only an explicit list of codes to `Unknown`; every other
//! code, including `provider_rejected` and `provider_refused`, is `Failed`.
use super::{metadata, validate_image, Input, Output, StageSink};
use crate::{
    domain::{ApiKind, ApiProfile, MAX_OUTPUT},
    error::{error, Result},
};
use futures_util::StreamExt;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use te_image_generation_contract::{EffectiveRecipe, SafeError};
#[cfg(feature = "test-hooks")]
mod fixture;
pub mod gemini;
pub mod openai_images;

/// How a backend authenticates; the key itself is applied by [`send`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Auth {
    Bearer,
    Header(&'static str),
}
/// Image options a backend honours; they drive the published capabilities.
pub struct Options {
    pub quality: &'static [&'static str],
    pub background: &'static [&'static str],
    pub resolution: bool,
    pub aspect_ratio: bool,
    pub sizes: bool,
}
pub struct ApiDescriptor {
    /// Serialized `transport` tag; also the recipe adapter. `^[a-z][a-z0-9-]{0,63}$`.
    pub transport: &'static str,
    pub default_base_url: &'static str,
    /// Environment variable suggested as the credential source.
    pub credential_env: &'static str,
    pub auth: Auth,
    pub options: Options,
    pub max_inputs: usize,
    /// Backend-specific rule on a base URL that already passed the generic checks.
    pub validate_base_url: fn(&url::Url) -> Result<()>,
}
pub struct ApiCall<'a> {
    pub profile: &'a ApiProfile,
    pub recipe: &'a EffectiveRecipe,
    pub inputs: Vec<Input>,
    pub key: Option<String>,
    pub cancel: Arc<AtomicBool>,
    pub stage: StageSink,
}
pub fn descriptor(kind: ApiKind) -> &'static ApiDescriptor {
    match kind {
        ApiKind::OpenAiImages => &openai_images::DESCRIPTOR,
        ApiKind::Gemini => &gemini::DESCRIPTOR,
        #[cfg(feature = "test-hooks")]
        ApiKind::Fixture => &fixture::DESCRIPTOR,
    }
}
pub async fn generate(kind: ApiKind, call: ApiCall<'_>) -> Result<Output> {
    match kind {
        ApiKind::OpenAiImages => openai_images::generate(call).await,
        ApiKind::Gemini => gemini::generate(call).await,
        #[cfg(feature = "test-hooks")]
        ApiKind::Fixture => fixture::generate(call).await,
    }
}

const RESPONSE_LIMIT: usize = 70 * 1024 * 1024;

/// Inherited native configuration (plan §18.3): proxies come only from the
/// HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY environment (curl semantics,
/// loopback is not bypassed); OS proxy settings are not read. TLS trust is the
/// platform verifier's OS store. Redirects and retries are never taken.
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|_| error("unavailable", "Could not prepare the image HTTP client"))
}
pub async fn interrupted<T>(
    future: impl std::future::Future<Output = Result<T>>,
    cancel: &AtomicBool,
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
/// Applies the credential as a header marked sensitive, so it is redacted from
/// any debug output of the request.
pub fn apply_auth(
    request: reqwest::RequestBuilder,
    auth: Auth,
    key: Option<&str>,
) -> Result<reqwest::RequestBuilder> {
    let Some(key) = key else {
        return Ok(request);
    };
    let (name, text) = match auth {
        Auth::Bearer => ("authorization", format!("Bearer {key}")),
        Auth::Header(name) => (name, key.to_owned()),
    };
    let mut value = reqwest::header::HeaderValue::from_str(&text)
        .map_err(|_| error("unavailable", "Image credential cannot be sent as a header"))?;
    value.set_sensitive(true);
    Ok(request.header(name, value))
}

/// Everything that can go wrong with a provider exchange.
pub enum Failure {
    /// The request could not be sent or its answer never arrived.
    Transport,
    /// The response body ended or errored mid-stream.
    Interrupted,
    /// A non-success HTTP status.
    Status { code: u16 },
    /// A definitive 200 that says the provider refused, as a structured reason.
    Refused(Refusal),
    /// A 200 that is unparseable or lacks the image.
    Invalid(&'static str),
}
/// The single rule mapping a provider failure to the journal's error.
pub fn outcome(failure: Failure) -> SafeError {
    match failure {
        Failure::Transport => error(
            "remote_outcome_unknown",
            "Image provider request failed; remote outcome is unknown",
        ),
        Failure::Interrupted => error(
            "remote_outcome_unknown",
            "Image provider response was interrupted",
        ),
        Failure::Status { code } if code >= 500 || code == 408 => error(
            "remote_outcome_unknown",
            "Image provider did not confirm an outcome; generation may have occurred",
        ),
        Failure::Status { code } if (200..300).contains(&code) => error(
            "invalid_response",
            "Image provider returned an unexpected status",
        ),
        Failure::Status { code } => error(
            "provider_rejected",
            &format!(
                "Image provider rejected the request (HTTP {code}); check endpoint, model and credentials"
            ),
        ),
        Failure::Refused(reason) => error(
            "provider_refused",
            &format!("The provider refused this request ({})", reason.wording()),
        ),
        Failure::Invalid(message) => error("invalid_response", message),
    }
}
/// Why a provider refused a request. Adapters map the provider's structured
/// field (Gemini `finishReason`, BFL `status`, ...) to one of these; response
/// prose is never used, so receipts hold only our own wording.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Safety,
    Policy,
    Other,
}
impl Refusal {
    fn wording(self) -> &'static str {
        match self {
            Refusal::Safety => "safety",
            Refusal::Policy => "content policy",
            Refusal::Other => "no reason given",
        }
    }
}
/// Builds the refusal failure from a provider's structured reason code, using
/// the adapter's table of known codes; unknown codes become `Refusal::Other`.
pub fn refused(reason_code: &str, table: &[(&str, Refusal)]) -> Failure {
    Failure::Refused(
        table
            .iter()
            .find(|(code, _)| *code == reason_code)
            .map_or(Refusal::Other, |(_, r)| *r),
    )
}

pub struct Reply {
    pub body: Vec<u8>,
    pub request_id: Option<String>,
}
/// Sends a backend-built request: applies auth, enforces the outcome rule for
/// the HTTP status, and reads a bounded body. Cancellation maps to an unknown
/// remote outcome.
pub async fn send(
    descriptor: &ApiDescriptor,
    key: Option<&str>,
    cancel: &AtomicBool,
    stage: &StageSink,
    request: reqwest::RequestBuilder,
) -> Result<Reply> {
    let request = apply_auth(request, descriptor.auth, key)?;
    interrupted(
        async {
            stage("process_started");
            let response = request
                .send()
                .await
                .map_err(|_| outcome(Failure::Transport))?;
            let status = response.status();
            if !status.is_success() {
                return Err(outcome(Failure::Status {
                    code: status.as_u16(),
                }));
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
            let body = read_body(response, RESPONSE_LIMIT).await?;
            stage("process_finished");
            Ok(Reply { body, request_id })
        },
        cancel,
    )
    .await
}
/// Reads at most `limit` bytes; more is an invalid response, a broken stream an
/// unknown outcome.
pub async fn read_body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| outcome(Failure::Interrupted))?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(error(
                "invalid_response",
                &format!(
                    "Image response exceeds the {} MiB limit",
                    limit / (1024 * 1024)
                ),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
/// Accepts PNG, JPEG or WebP provider output, validates it and returns PNG,
/// the only output format the service contract advertises.
pub fn image_output(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() > MAX_OUTPUT {
        return Err(error("invalid_response", "Image output exceeds 50 MiB"));
    }
    let format = match image::guess_format(bytes) {
        Ok(f @ (image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::WebP)) => {
            f
        }
        _ => {
            return Err(error(
                "invalid_response",
                "Image provider returned an unsupported image format",
            ))
        }
    };
    validate_image(bytes, format)?;
    if format == image::ImageFormat::Png {
        return Ok(bytes.to_vec());
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| error("invalid_response", "Invalid image data"))?;
    let mut png = std::io::Cursor::new(vec![]);
    decoded
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|_| error("invalid_response", "Could not normalise the image to PNG"))?;
    let png = png.into_inner();
    if png.len() > MAX_OUTPUT {
        return Err(error("invalid_response", "Image output exceeds 50 MiB"));
    }
    Ok(png)
}
/// Finishes a successful exchange: normalises the image and records metadata.
pub fn output(
    call_recipe: &EffectiveRecipe,
    stage: &StageSink,
    image: &[u8],
    request_id: Option<String>,
    actual_model: Option<&str>,
) -> Result<Output> {
    let bytes = image_output(image)?;
    stage("output_found");
    let mut metadata = metadata(call_recipe);
    metadata.external_request_id = request_id;
    metadata.actual_model = actual_model
        .filter(|s| {
            !s.trim().is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control)
        })
        .map(str::to_owned);
    Ok(Output { bytes, metadata })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(failure: Failure) -> String {
        outcome(failure).code
    }
    #[test]
    fn credentials_are_sent_as_sensitive_headers() {
        let client = reqwest::Client::new();
        for (auth, header, expected) in [
            (Auth::Bearer, "authorization", "Bearer k-123"),
            (Auth::Header("x-goog-api-key"), "x-goog-api-key", "k-123"),
        ] {
            let request = apply_auth(client.post("https://x.test/"), auth, Some("k-123"))
                .unwrap()
                .build()
                .unwrap();
            let value = request.headers().get(header).unwrap();
            assert!(value.is_sensitive(), "{header}");
            assert_eq!(value.to_str().unwrap(), expected);
            assert!(!format!("{:?}", request.headers()).contains("k-123"));
        }
        let none = apply_auth(client.post("https://x.test/"), Auth::Bearer, None)
            .unwrap()
            .build()
            .unwrap();
        assert!(none.headers().is_empty());
        assert!(apply_auth(
            client.post("https://x.test/"),
            Auth::Header("x-k"),
            Some("bad\nkey")
        )
        .is_err());
    }
    #[test]
    fn uncertain_provider_outcomes_are_remote_outcome_unknown() {
        assert_eq!(code(Failure::Transport), "remote_outcome_unknown");
        assert_eq!(code(Failure::Interrupted), "remote_outcome_unknown");
        for status in [408, 500, 502, 503, 504, 599] {
            assert_eq!(
                code(Failure::Status { code: status }),
                "remote_outcome_unknown",
                "{status}"
            );
        }
    }
    #[test]
    fn other_client_errors_are_definite_rejections_with_fixed_wording() {
        for status in [400, 401, 403, 404, 409, 422, 429] {
            let err = outcome(Failure::Status { code: status });
            assert_eq!(err.code, "provider_rejected", "{status}");
            assert_eq!(
                err.message,
                format!("Image provider rejected the request (HTTP {status}); check endpoint, model and credentials")
            );
        }
    }
    #[test]
    fn a_refusal_is_definite_and_uses_only_our_wording() {
        let table = [("SAFETY", Refusal::Safety), ("PROHIBITED", Refusal::Policy)];
        let err = outcome(refused("SAFETY", &table));
        assert_eq!(err.code, "provider_refused");
        assert_eq!(err.message, "The provider refused this request (safety)");
        // Unknown codes, including hostile prose, never reach the message.
        let hostile = outcome(refused("sk-abc***xyz you are blocked", &table));
        assert_eq!(
            hostile.message,
            "The provider refused this request (no reason given)"
        );
        assert_eq!(code(Failure::Invalid("no image")), "invalid_response");
        assert_eq!(code(Failure::Status { code: 200 }), "invalid_response");
    }
    fn encoded(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            8,
            4,
            image::Rgb([200, 30, 30]),
        ));
        let mut out = std::io::Cursor::new(vec![]);
        image.write_to(&mut out, format).unwrap();
        out.into_inner()
    }
    #[test]
    fn png_jpeg_and_webp_outputs_normalise_to_png() {
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::WebP,
        ] {
            let png = image_output(&encoded(format)).unwrap();
            assert_eq!(
                image::guess_format(&png).unwrap(),
                image::ImageFormat::Png,
                "{format:?}"
            );
            assert_eq!(image::load_from_memory(&png).unwrap().width(), 8);
        }
    }
    #[test]
    fn garbage_truncated_and_unsupported_outputs_are_invalid_responses() {
        let truncated = encoded(image::ImageFormat::Png);
        let gif = {
            let mut out = std::io::Cursor::new(vec![]);
            image::DynamicImage::ImageRgb8(image::RgbImage::new(2, 2))
                .write_to(&mut out, image::ImageFormat::Gif)
                .ok();
            out.into_inner()
        };
        for bytes in [
            &b""[..],
            b"not an image",
            &truncated[..truncated.len() / 2],
            &gif[..],
        ] {
            let err = image_output(bytes).unwrap_err();
            assert_eq!(err.code, "invalid_response");
        }
    }
    #[test]
    fn the_fixture_backend_generates_through_the_registry() {
        let recipe = EffectiveRecipe {
            schema_version: 1,
            formatter_version: 1,
            connection_id: "api".into(),
            connection_revision: "r".into(),
            adapter: "fixture-images".into(),
            endpoint_identity: "https://fixture.test/v1".into(),
            model: Some("m".into()),
            options: te_image_generation_contract::ImageOptions {
                size: "1024x1024".into(),
                resolution: None,
                aspect_ratio: None,
                quality: "auto".into(),
                background: "auto".into(),
            },
            input_digests: vec![],
            input_roles: vec![],
            submitted_prompt: "p".into(),
            agent_task: None,
        };
        let profile = ApiProfile {
            id: "api".into(),
            name: "Api".into(),
            recipe_revision: "r".into(),
            base_url: "https://fixture.test/v1".into(),
            default_model: "m".into(),
            allow_insecure_http: false,
            credential: crate::domain::Credential::None,
        };
        let call = ApiCall {
            profile: &profile,
            recipe: &recipe,
            inputs: vec![],
            key: None,
            cancel: Arc::new(AtomicBool::new(false)),
            stage: Arc::new(|_| {}),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let output = runtime.block_on(generate(ApiKind::Fixture, call)).unwrap();
        assert_eq!(
            image::guess_format(&output.bytes).unwrap(),
            image::ImageFormat::Png
        );
        assert_eq!(output.metadata.adapter, "fixture-images");
    }
}
