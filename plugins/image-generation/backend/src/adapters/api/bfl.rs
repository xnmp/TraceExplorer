//! Flux (Black Forest Labs) image API: asynchronous submit, poll, download.
//!
//! Sources (BFL docs, checked 2026-10-11):
//! - index: <https://docs.bfl.ml/llms.txt> (also served at docs.bfl.ai);
//! - endpoints, regional base URLs, `polling_url`, 10 minute result expiry, rate
//!   limits: <https://docs.bfl.ml/api_integration/integration_guidelines.md>;
//! - statuses and HTTP errors (402 credits, 429 rate limit):
//!   <https://docs.bfl.ml/api_integration/errors.md>;
//! - FLUX.2 editing (`input_image`..`input_image_8`, up to 8 images):
//!   <https://docs.bfl.ml/flux_2/flux2_image_editing.md>, and the schema in
//!   <https://api.bfl.ai/openapi.json> (`prompt`, `input_image[_N]`, `width`,
//!   `height`, `seed`, `safety_tolerance`, `output_format`);
//! - FLUX 3 (preview): <https://docs.bfl.ml/flux_3/flux3_image_generate.md> and
//!   `flux3_image_layout.md` (`images` array of up to ten, `aspect_ratio` with
//!   `auto` following the first image, signed result URL valid 1 hour; unknown
//!   fields such as `output_format` are rejected with 422).
//!
//! Auth is the `x-key` header. Base URLs: `https://api.bfl.ai/v1` (global),
//! `https://api.eu.bfl.ai/v1`, `https://api.us.bfl.ai/v1`. The endpoint is
//! `{base}/{model}`. The submit answer holds `id` and `polling_url`; regional
//! endpoints require polling the returned URL.
//!
//! Models. The default is `flux-2-pro`, the documented stable FLUX.2 [pro]
//! snapshot (FLUX 3 is labelled a preview). Models whose name starts with
//! `flux-3-image` (exact; other `flux-3-*` ids, such as the paid video task, are
//! refused before any request) send images in `images` and never `output_format`;
//! other models send `input_image`, `input_image_2`, ... and `output_format: "png"`.
//! Reference-image caps follow the model family (pro, max, flex 8; klein 4; Kontext
//! 4; flux-3-image 10, capped to 8 by the descriptor; unknown families 0, since
//! their schemas would silently drop extras); exceeding one fails as
//! `invalid_request` before any request. A shared aspect
//! ratio maps natively to `aspect_ratio` for `flux-3-image` and `flux-kontext*`, and to
//! a fixed ~1 MP `width`/`height` pair for FLUX.2, which has no ratio field.
//! `keep` (or no ratio) sends nothing, so the model follows the inputs. There is
//! no size or quality control exposed in v1. Private connection-test recipes
//! use exact schema minima: FLUX.2 64x64, FLUX1.1/dev 256x256, and FLUX3
//! `768sq`; unknown models and Kontext use their adapter defaults.
//!
//! Polling happens inside the adapter. The delay starts at 0.5 s and grows 1.5x to
//! 2 s. Cancellation ends the wait as `cancelled_after_dispatch`: the service sets
//! the flag on a user cancel and when the operation's 900 s budget (which includes
//! queue time and the submit) expires. An internal 840 s cap, measured from the
//! start of polling, ends it as Unknown; it rarely fires first, and both outcomes
//! are Unknown. Statuses:
//!
//! | `status` | Result |
//! |---|---|
//! | `Pending`, `Reasoning`, `Generating` | keep polling |
//! | `Ready` | download `result.sample` |
//! | `Request Moderated` | `provider_refused` (content policy), Failed |
//! | `Content Moderated` | `provider_refused` (safety), Failed |
//! | `Error`, `Failed` | `provider_failed`, Failed |
//! | `Task not found`, anything else | `remote_outcome_unknown`, Unknown |
//!
//! A non-2xx poll answer is read (bounded) first: FLUX 3 can report a failed task
//! as a 503 with a normal JSON body, so a terminal `status` in it is classified by
//! the table above, but only when the body names this task's `id` (a gateway's
//! own error JSON must not turn a live task into a retryable failure). Otherwise
//! 429, 408 and 5xx, and transport failures, are
//! transient (three in a row end as Unknown) and any other 4xx is Unknown.
//!
//! Submission 4xx (including 402 credits and 429 rate limit) is `provider_rejected`
//! with the status number; 5xx, 408 and transport failures are Unknown. After a
//! successful submission the task may be paid for, so only the statuses above are
//! definitive; a failed sample download is always Unknown.
//!
//! Security. The key is sent only to the base URL's exact origin (scheme, host,
//! port) and to a `polling_url` that is https on the default port with host
//! `api.bfl.ai` or `api.<region>.bfl.ai` (never other `bfl.ai` hosts such as the
//! delivery CDN). Any other polling host fails as `invalid_response` without a
//! request. The result sample is fetched with a plain GET with no key, over https
//! (or http only on the http base's host), bounded to the 50 MiB output limit; when
//! the base host is under `bfl.ai` the sample host must be too, and loopback,
//! private and link-local IP literals are refused unless they are the base host.
//! Redirects are never followed (shared client).
//!
//! Durability: polling state is memory only. A crash or restart while polling
//! leaves the operation Unknown (the shared recovery rule); polling is not resumed
//! in v1, so a finished image is not recovered.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::net::IpAddr;

pub const DESCRIPTOR: ApiDescriptor = ApiDescriptor {
    transport: "bfl",
    default_base_url: "https://api.bfl.ai/v1",
    credential_env: "BFL_API_KEY",
    auth: Auth::Header("x-key"),
    options: Options {
        test_size: "auto",
        quality: &["auto"],
        background: &["auto"],
        resolution: false,
        aspect_ratio: true,
        sizes: false,
    },
    max_inputs: 8,
};
const STATUS_TABLE: &[(&str, Refusal)] = &[
    ("Request Moderated", Refusal::Policy),
    ("Content Moderated", Refusal::Safety),
];
const POLL_BODY_LIMIT: usize = 1024 * 1024;
const MAX_TRANSIENT_POLL_FAILURES: u32 = 3;

#[derive(Clone, Copy)]
struct Schedule {
    first: Duration,
    max: Duration,
    cap: Duration,
}
const SCHEDULE: Schedule = Schedule {
    first: Duration::from_millis(500),
    max: Duration::from_secs(2),
    cap: Duration::from_secs(840),
};

pub(super) async fn generate(call: ApiCall<'_>) -> Result<Output> {
    run(call, SCHEDULE).await
}

/// How a model takes its request, and how many reference images it accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    /// `flux-3-image`: `images` array, native `aspect_ratio`, no `output_format`.
    Flux3,
    /// `flux-kontext-*`: `input_image`..`input_image_4`, native `aspect_ratio`.
    Kontext,
    /// FLUX.2: `input_image`..`input_image_N`, `width`/`height` instead of a ratio.
    Flux2 { cap: usize },
    /// Other documented models take no reference images.
    TextOnly,
}
impl Family {
    fn cap(self) -> usize {
        match self {
            Family::Flux3 => 10,
            Family::Kontext => 4,
            Family::Flux2 { cap } => cap,
            Family::TextOnly => 0,
        }
    }
}
fn family(model: &str) -> Result<Family> {
    let is =
        |base: &str| model == base || model.strip_prefix(base).is_some_and(|r| r.starts_with('-'));
    Ok(if model == "flux-3-image" {
        Family::Flux3
    } else if model.starts_with("flux-3") {
        return Err(error(
            "invalid_request",
            "Only the flux-3-image model of the FLUX 3 family can be used here",
        ));
    } else if model.starts_with("flux-kontext") {
        Family::Kontext
    } else if is("flux-2-klein") {
        Family::Flux2 { cap: 4 }
    } else if is("flux-2-pro") || is("flux-2-max") || is("flux-2-flex") {
        Family::Flux2 { cap: 8 }
    } else {
        Family::TextOnly
    })
}
fn model_name(recipe: &EffectiveRecipe, profile: &ApiProfile) -> Result<String> {
    let model = recipe
        .model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| profile.default_model.clone());
    if !crate::domain::backend_rules::path_safe_model_id(&model) {
        return Err(error(
            "invalid_request",
            "Enter a Flux model ID such as flux-2-pro",
        ));
    }
    Ok(model)
}
/// FLUX.2 has no ratio field; these are the ~1 MP, multiple-of-16 sizes.
fn flux2_size(ratio: &str) -> Option<(u32, u32)> {
    Some(match ratio {
        "1:1" => (1024, 1024),
        "4:3" => (1152, 864),
        "3:4" => (864, 1152),
        "3:2" => (1248, 832),
        "2:3" => (832, 1248),
        "16:9" => (1280, 720),
        "9:16" => (720, 1280),
        _ => return None,
    })
}
fn request_body(family: Family, recipe: &EffectiveRecipe, inputs: &[Input]) -> Value {
    let images: Vec<String> = inputs.iter().map(|i| STANDARD.encode(&i.bytes)).collect();
    let ratio = recipe
        .options
        .aspect_ratio
        .as_deref()
        .filter(|r| *r != "keep");
    let mut body = json!({"prompt": recipe.submitted_prompt});
    let fields = body.as_object_mut().unwrap();
    if family == Family::Flux3 {
        if !images.is_empty() {
            fields.insert("images".into(), json!(images));
        }
        if let Some(r) = ratio {
            fields.insert("aspect_ratio".into(), json!(r));
        }
        if let Some(resolution) = &recipe.options.resolution {
            fields.insert("resolution".into(), json!(resolution));
        }
        return body;
    }
    if let Some((width, height)) = recipe.options.size.split_once('x') {
        fields.insert("width".into(), json!(width.parse::<u32>().unwrap()));
        fields.insert("height".into(), json!(height.parse::<u32>().unwrap()));
    }
    for (index, image) in images.into_iter().enumerate() {
        let name = if index == 0 {
            "input_image".to_owned()
        } else {
            format!("input_image_{}", index + 1)
        };
        fields.insert(name, json!(image));
    }
    fields.insert("output_format".into(), json!("png"));
    if let Some(r) = ratio {
        if family == Family::Kontext {
            fields.insert("aspect_ratio".into(), json!(r));
        } else if let Some((width, height)) = flux2_size(r) {
            fields.insert("width".into(), json!(width));
            fields.insert("height".into(), json!(height));
        }
    }
    body
}

pub(super) fn validated_request_body(
    recipe: &EffectiveRecipe,
    profile: &ApiProfile,
    inputs: &[Input],
) -> Result<Value> {
    let model = model_name(recipe, profile)?;
    if let Some(problem) =
        crate::domain::model_options_problem(ApiKind::Bfl, Some(&model), &recipe.options)
    {
        return Err(error("invalid_request", problem));
    }
    let family = family(&model)?;
    if inputs.len() > family.cap() {
        return Err(error(
            "invalid_request",
            &if family.cap() == 0 {
                "This Flux model does not accept reference images".to_owned()
            } else {
                format!(
                    "This Flux model accepts at most {} reference images",
                    family.cap()
                )
            },
        ));
    }
    Ok(request_body(family, recipe, inputs))
}

/// May the key be sent to this polling URL? Only the base's exact origin, or the
/// BFL API hosts (`api.bfl.ai`, `api.<region>.bfl.ai`) over https on port 443.
fn polling_url_allowed(poll: &url::Url, base: &url::Url) -> bool {
    if !poll.username().is_empty() || poll.password().is_some() {
        return false;
    }
    let same_origin = poll.scheme() == base.scheme()
        && poll.host_str().is_some()
        && poll.host_str() == base.host_str()
        && poll.port_or_known_default() == base.port_or_known_default();
    let bfl_api = poll.scheme() == "https"
        && poll.port().is_none()
        && poll.host_str().is_some_and(|h| {
            let labels: Vec<&str> = h.split('.').collect();
            h == "api.bfl.ai"
                || (labels.len() == 4
                    && labels[0] == "api"
                    && labels[2] == "bfl"
                    && labels[3] == "ai"
                    && !labels[1].is_empty()
                    && labels[1]
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        });
    same_origin || bfl_api
}
fn internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || seg[0] & 0xfe00 == 0xfc00
                || seg[0] & 0xffc0 == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| internal_ip(IpAddr::V4(v4)))
        }
    }
}
fn under_bfl(host: &str) -> bool {
    host == "bfl.ai" || host.ends_with(".bfl.ai")
}
fn sample_url_allowed(sample: &url::Url, base: &url::Url) -> bool {
    if !sample.username().is_empty() || sample.password().is_some() {
        return false;
    }
    let Some(host) = sample.host_str() else {
        return false;
    };
    let same_host = Some(host) == base.host_str();
    let scheme_ok = sample.scheme() == "https"
        || (sample.scheme() == "http" && base.scheme() == "http" && same_host);
    let literal: Option<IpAddr> = match sample.host() {
        Some(url::Host::Ipv4(v4)) => Some(IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => Some(IpAddr::V6(v6)),
        _ => None,
    };
    let ip_ok = literal.is_none_or(|ip| same_host || !internal_ip(ip));
    let bfl_ok = !base.host_str().is_some_and(under_bfl) || under_bfl(host);
    scheme_ok && ip_ok && bfl_ok
}
fn unknown(message: &str) -> SafeError {
    error("remote_outcome_unknown", message)
}
fn bounded_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
/// One GET/POST exchange: the status and a bounded body, whatever the status.
async fn exchange(request: reqwest::RequestBuilder, limit: usize) -> Result<(u16, Vec<u8>)> {
    let response = request
        .send()
        .await
        .map_err(|_| outcome(Failure::Transport))?;
    let status = response.status().as_u16();
    let body = read_body(response, limit).await;
    match body {
        Ok(body) => Ok((status, body)),
        // An oversize error body is just not usable; an oversize success is invalid.
        Err(e) if !(200..300).contains(&status) && e.code == "invalid_response" => {
            Ok((status, vec![]))
        }
        Err(e) => Err(e),
    }
}
async fn download(request: reqwest::RequestBuilder, limit: usize) -> Result<Vec<u8>> {
    let (status, body) = exchange(request, limit).await?;
    if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(outcome(Failure::Status { code: status }))
    }
}

async fn run(call: ApiCall<'_>, schedule: Schedule) -> Result<Output> {
    let ApiCall {
        profile,
        recipe,
        inputs,
        key,
        cancel,
        stage,
    } = call;
    let model = model_name(recipe, profile)?;
    let body = validated_request_body(recipe, profile, &inputs)?;
    let base = url::Url::parse(&profile.base_url)
        .map_err(|_| error("invalid_request", "Enter an absolute Flux API root"))?;
    let client = client()?;
    drop(inputs);
    let submit = client
        .post(format!(
            "{}/{}",
            profile.base_url.trim_end_matches('/'),
            model
        ))
        .header("accept", "application/json")
        .json(&body);
    let quiet: StageSink = Arc::new(|_| {});
    stage("process_started");
    let reply = send(&DESCRIPTOR, key.as_deref(), &cancel, &quiet, submit).await?;
    let submitted: Value = serde_json::from_slice(&reply.body)
        .map_err(|_| outcome(Failure::Invalid("Image provider returned unreadable JSON")))?;
    let task = submitted["id"]
        .as_str()
        .filter(|id| bounded_id(id))
        .ok_or_else(|| outcome(Failure::Invalid("Image provider returned no task id")))?
        .to_owned();
    let poll_url = submitted["polling_url"]
        .as_str()
        .and_then(|u| url::Url::parse(u).ok())
        .ok_or_else(|| outcome(Failure::Invalid("Image provider returned no polling URL")))?;
    if !polling_url_allowed(&poll_url, &base) {
        return Err(outcome(Failure::Invalid(
            "Image provider returned an untrusted polling URL; the key was not sent",
        )));
    }
    let sample = interrupted(
        poll(
            &client,
            &DESCRIPTOR,
            key.as_deref(),
            &poll_url,
            &task,
            schedule,
        ),
        &cancel,
    )
    .await?;
    let sample = url::Url::parse(&sample)
        .ok()
        .filter(|u| sample_url_allowed(u, &base))
        .ok_or_else(|| {
            outcome(Failure::Invalid(
                "Image provider returned an unusable result URL",
            ))
        })?;
    // Plain GET: the result host is not the API and never receives the key. The
    // task exists and may be paid for, so a failed download is never definitive.
    let image = interrupted(
        async {
            download(client.get(sample), MAX_OUTPUT).await.map_err(|e| {
                if e.code == "invalid_response" {
                    e
                } else {
                    unknown("Could not download the generated image; generation may have occurred")
                }
            })
        },
        &cancel,
    )
    .await?;
    stage("process_finished");
    output(recipe, &stage, &image, Some(task), None)
}

enum Step {
    Continue,
    Ready(String),
    Done(SafeError),
}
fn classify(value: &Value) -> Step {
    match value["status"].as_str() {
        Some("Pending" | "Reasoning" | "Generating") => Step::Continue,
        Some("Ready") => match value["result"]["sample"].as_str() {
            Some(sample) => Step::Ready(sample.to_owned()),
            None => Step::Done(outcome(Failure::Invalid(
                "Image provider returned no image",
            ))),
        },
        Some(status @ ("Request Moderated" | "Content Moderated")) => {
            Step::Done(outcome(refused(status, STATUS_TABLE)))
        }
        Some("Error" | "Failed") => Step::Done(outcome(Failure::ProviderFailed)),
        _ => Step::Done(unknown(
            "Image provider returned an unrecognised status; generation may have occurred",
        )),
    }
}

/// Polls until a terminal status; returns the result sample URL.
async fn poll(
    client: &reqwest::Client,
    descriptor: &ApiDescriptor,
    key: Option<&str>,
    url: &url::Url,
    task: &str,
    schedule: Schedule,
) -> Result<String> {
    let started = std::time::Instant::now();
    let mut delay = schedule.first;
    let mut transient = 0;
    loop {
        if started.elapsed() >= schedule.cap {
            return Err(unknown(
                "Image generation did not finish in time; its outcome is unknown",
            ));
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 3 / 2).min(schedule.max);
        let request = apply_auth(
            client.get(url.clone()).header("accept", "application/json"),
            descriptor.auth,
            key,
        )
        .map_err(|_| unknown("Image credential cannot be sent; generation may have occurred"))?;
        let exchange = exchange(request, POLL_BODY_LIMIT).await;
        let (status, body) = match exchange {
            Ok(pair) => pair,
            Err(e) if e.code == "remote_outcome_unknown" => {
                transient += 1;
                if transient >= MAX_TRANSIENT_POLL_FAILURES {
                    return Err(e);
                }
                continue;
            }
            Err(e) => return Err(e),
        };
        let parsed: Option<Value> = serde_json::from_slice(&body).ok();
        if (200..300).contains(&status) {
            transient = 0;
            let value = parsed.ok_or_else(|| {
                outcome(Failure::Invalid("Image provider returned unreadable JSON"))
            })?;
            match classify(&value) {
                Step::Continue => continue,
                Step::Ready(sample) => return Ok(sample),
                Step::Done(e) => return Err(e),
            }
        }
        // A failed task can arrive as a non-2xx with a normal JSON body; only a
        // body about this task is evidence of its outcome.
        if let Some(value) =
            parsed.filter(|v| v["status"].is_string() && v["id"].as_str() == Some(task))
        {
            if let Step::Done(e) = classify(&value) {
                if e.code != "invalid_response" {
                    return Err(e);
                }
            }
        }
        if status == 429 || status == 408 || status >= 500 {
            transient += 1;
            if transient >= MAX_TRANSIENT_POLL_FAILURES {
                return Err(unknown(
                    "Image provider could not report the result; generation may have occurred",
                ));
            }
            continue;
        }
        return Err(unknown(
            "Image provider could not report the result; generation may have occurred",
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{atomic::AtomicBool, Mutex};

    #[derive(Clone, Debug)]
    struct Req {
        method: String,
        path: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    }
    impl Req {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.as_str())
        }
    }
    type Handler = dyn Fn(&Req, usize) -> Vec<u8> + Send + Sync;
    struct Fake {
        addr: std::net::SocketAddr,
        log: Arc<Mutex<Vec<Req>>>,
        stop: Arc<AtomicBool>,
    }
    impl Fake {
        fn start(handler: impl Fn(&Req, usize) -> Vec<u8> + Send + Sync + 'static) -> Fake {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let log: Arc<Mutex<Vec<Req>>> = Default::default();
            let stop = Arc::new(AtomicBool::new(false));
            let handler: Arc<Handler> = Arc::new(handler);
            let (l, s) = (log.clone(), stop.clone());
            std::thread::spawn(move || {
                while !s.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    let (l, handler) = (l.clone(), handler.clone());
                    std::thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(5)))
                            .unwrap();
                        let mut bytes = vec![];
                        let mut chunk = [0; 8192];
                        let end = loop {
                            match stream.read(&mut chunk) {
                                Ok(n) if n > 0 => bytes.extend_from_slice(&chunk[..n]),
                                _ => return,
                            }
                            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                break i + 4;
                            }
                        };
                        let head = String::from_utf8_lossy(&bytes[..end]).to_string();
                        let mut lines = head.lines();
                        let mut first = lines.next().unwrap().split(' ');
                        let (method, path) = (
                            first.next().unwrap().to_owned(),
                            first.next().unwrap().to_owned(),
                        );
                        let headers: Vec<(String, String)> = lines
                            .filter_map(|l| l.split_once(": "))
                            .map(|(n, v)| (n.to_ascii_lowercase(), v.to_owned()))
                            .collect();
                        let length = headers
                            .iter()
                            .find(|(n, _)| n == "content-length")
                            .and_then(|(_, v)| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        while bytes.len() - end < length {
                            match stream.read(&mut chunk) {
                                Ok(n) if n > 0 => bytes.extend_from_slice(&chunk[..n]),
                                _ => return,
                            }
                        }
                        let req = Req {
                            method,
                            path,
                            headers,
                            body: bytes[end..].to_vec(),
                        };
                        let index = {
                            let mut log = l.lock().unwrap();
                            log.push(req.clone());
                            log.len() - 1
                        };
                        let _ = stream.write_all(&handler(&req, index));
                    });
                }
            });
            Fake { addr, log, stop }
        }
        fn url(&self) -> String {
            format!("http://{}", self.addr)
        }
        fn requests(&self) -> Vec<Req> {
            self.log.lock().unwrap().clone()
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }
    fn http(status: &str, ctype: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }
    fn json_reply(v: Value) -> Vec<u8> {
        http("200 OK", "application/json", v.to_string().as_bytes())
    }
    fn encoded(format: image::ImageFormat, shade: u8) -> Vec<u8> {
        let mut out = std::io::Cursor::new(vec![]);
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            6,
            3,
            image::Rgb([shade, 9, 9]),
        ))
        .write_to(&mut out, format)
        .unwrap();
        out.into_inner()
    }
    fn fast() -> Schedule {
        Schedule {
            first: Duration::from_millis(3),
            max: Duration::from_millis(8),
            cap: Duration::from_secs(5),
        }
    }
    fn recipe(model: &str, ratio: Option<&str>) -> EffectiveRecipe {
        EffectiveRecipe {
            schema_version: 1,
            formatter_version: 1,
            connection_id: "bfl".into(),
            connection_revision: "r".into(),
            adapter: "bfl".into(),
            endpoint_identity: "http://fake".into(),
            model: Some(model.into()),
            options: te_image_generation_contract::ImageOptions {
                size: "auto".into(),
                resolution: None,
                aspect_ratio: ratio.map(str::to_owned),
                quality: "auto".into(),
                background: "auto".into(),
            },
            input_digests: vec![],
            input_roles: vec![],
            submitted_prompt: "make it blue".into(),
            agent_task: None,
        }
    }
    fn profile(base: &str) -> ApiProfile {
        ApiProfile {
            id: "bfl".into(),
            name: "Flux".into(),
            recipe_revision: "r".into(),
            base_url: base.into(),
            default_model: "flux-2-pro".into(),
            allow_insecure_http: true,
            credential: crate::domain::Credential::None,
        }
    }
    fn input(shade: u8) -> Input {
        Input {
            bytes: encoded(image::ImageFormat::Png, shade),
            mime: "image/png".into(),
        }
    }
    fn go(
        base: &str,
        model: &str,
        ratio: Option<&str>,
        inputs: Vec<Input>,
        cancel: Arc<AtomicBool>,
    ) -> Result<Output> {
        let profile = profile(base);
        let recipe = recipe(model, ratio);
        let call = ApiCall {
            profile: &profile,
            recipe: &recipe,
            inputs,
            key: Some("secret-key".into()),
            cancel,
            stage: Arc::new(|_| {}),
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run(call, fast()))
    }
    fn run_ok(base: &str) -> Result<Output> {
        go(
            base,
            "flux-2-pro",
            None,
            vec![],
            Arc::new(AtomicBool::new(false)),
        )
    }
    /// A server that accepts the submit, then answers each poll from `statuses`.
    fn flow(statuses: Vec<Value>, sample: Vec<u8>) -> (Fake, Fake) {
        let files = Fake::start(move |_, _| http("200 OK", "image/jpeg", &sample));
        let file_url = format!("{}/sample.jpg", files.url());
        let api = Arc::new(Mutex::new(String::new()));
        let api2 = api.clone();
        let polls_seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let fake = Fake::start(move |req, _| {
            let base = api2.lock().unwrap().clone();
            if req.method == "POST" {
                return json_reply(
                    json!({"id":"task-1","polling_url":format!("{base}/v1/get_result?id=task-1")}),
                );
            }
            let n = polls_seen
                .fetch_add(1, Ordering::SeqCst)
                .min(statuses.len().saturating_sub(1));
            let mut v = statuses.get(n).cloned().unwrap_or_else(|| json!({}));
            if v["status"] == "Ready" && v["result"]["sample"].is_null() {
                v["result"] = json!({"sample": file_url});
            }
            json_reply(v)
        });
        *api.lock().unwrap() = fake.url();
        (fake, files)
    }
    fn st(s: &str) -> Value {
        json!({"status": s})
    }
    fn ready() -> Value {
        json!({"status":"Ready","result":{}})
    }

    #[test]
    fn submission_shape_and_polling_to_a_keyless_sample_download() {
        let jpeg = encoded(image::ImageFormat::Jpeg, 120);
        let (api, files) = flow(vec![st("Pending"), st("Generating"), ready()], jpeg);
        let inputs = vec![input(10), input(200), input(90)];
        let sent: Vec<String> = inputs.iter().map(|i| STANDARD.encode(&i.bytes)).collect();
        let out = go(
            &format!("{}/v1", api.url()),
            "flux-2-pro",
            None,
            inputs,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        // JPEG sample is normalised to PNG; the task id is the external request id.
        assert_eq!(
            image::guess_format(&out.bytes).unwrap(),
            image::ImageFormat::Png
        );
        assert_eq!(out.metadata.external_request_id.as_deref(), Some("task-1"));
        let reqs = api.requests();
        assert_eq!(reqs.len(), 4, "submit + three polls");
        let submit = &reqs[0];
        assert_eq!(
            (submit.method.as_str(), submit.path.as_str()),
            ("POST", "/v1/flux-2-pro")
        );
        assert_eq!(submit.header("x-key"), Some("secret-key"));
        assert_eq!(submit.header("authorization"), None);
        let body: Value = serde_json::from_slice(&submit.body).unwrap();
        assert_eq!(body["prompt"], "make it blue");
        assert_eq!(body["output_format"], "png");
        assert_eq!(body["input_image"], sent[0]);
        assert_eq!(body["input_image_2"], sent[1]);
        assert_eq!(body["input_image_3"], sent[2]);
        assert!(body.get("aspect_ratio").is_none() && body.get("width").is_none());
        for poll in &reqs[1..] {
            assert_eq!(
                (poll.method.as_str(), poll.path.as_str()),
                ("GET", "/v1/get_result?id=task-1")
            );
            assert_eq!(poll.header("x-key"), Some("secret-key"));
        }
        let samples = files.requests();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].path, "/sample.jpg");
        assert_eq!(samples[0].header("x-key"), None);
        assert_eq!(samples[0].header("authorization"), None);
    }

    #[test]
    fn request_bodies_follow_each_model_family() {
        let one = [input(1), input(2)];
        let r = |m, ratio| request_body(family(m).unwrap(), &recipe(m, ratio), &one);
        let f2 = r("flux-2-pro", Some("16:9"));
        assert_eq!(
            (f2["width"].as_u64(), f2["height"].as_u64()),
            (Some(1280), Some(720))
        );
        assert!(f2.get("aspect_ratio").is_none() && f2.get("images").is_none());
        let keep = r("flux-2-pro", Some("keep"));
        assert!(keep.get("width").is_none() && keep.get("aspect_ratio").is_none());
        let f3 = r("flux-3-image", Some("3:4"));
        assert_eq!(f3["aspect_ratio"], "3:4");
        assert_eq!(f3["images"].as_array().unwrap().len(), 2);
        assert!(f3.get("output_format").is_none() && f3.get("input_image").is_none());
        let kontext = r("flux-kontext-pro", Some("1:1"));
        assert_eq!(kontext["aspect_ratio"], "1:1");
        assert!(kontext.get("width").is_none());
        let text_only = request_body(Family::Flux3, &recipe("flux-3-image", None), &[]);
        assert_eq!(text_only, json!({"prompt":"make it blue"}));
    }

    #[test]
    fn every_shared_ratio_but_keep_has_a_valid_flux2_size() {
        for ratio in crate::domain::ASPECT_RATIOS
            .iter()
            .filter(|r| **r != "keep")
        {
            let (w, h) = flux2_size(ratio).unwrap_or_else(|| panic!("{ratio}"));
            assert!(w % 16 == 0 && h % 16 == 0 && w * h <= 4_000_000, "{ratio}");
            let (a, b) = ratio.split_once(':').unwrap();
            let want = a.parse::<f64>().unwrap() / b.parse::<f64>().unwrap();
            assert!(
                ((w as f64 / h as f64) - want).abs() / want < 0.01,
                "{ratio}"
            );
        }
    }

    #[test]
    fn moderation_statuses_are_definite_refusals() {
        for (status, wording) in [
            ("Request Moderated", "content policy"),
            ("Content Moderated", "safety"),
        ] {
            let (api, files) = flow(vec![st("Pending"), st(status)], vec![]);
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, "provider_refused", "{status}");
            assert!(err.message.contains(wording), "{status}: {}", err.message);
            assert!(files.requests().is_empty());
        }
    }

    #[test]
    fn error_and_failed_are_definite_provider_failures() {
        for status in ["Error", "Failed"] {
            let (api, _files) = flow(vec![st(status)], vec![]);
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, "provider_failed", "{status}");
        }
    }

    #[test]
    fn unknown_and_missing_statuses_leave_the_outcome_unknown() {
        for v in [
            st("Task not found"),
            st("No Card Generated"),
            st("Whatever"),
            json!({}),
        ] {
            let (api, _files) = flow(vec![v.clone()], vec![]);
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, "remote_outcome_unknown", "{v}");
        }
        // Ready without a sample is an invalid (Unknown) response.
        let (api, _f) = flow(
            vec![json!({"status":"Ready","result":{"sample":null}})],
            vec![],
        );
        assert_eq!(run_ok(&api.url()).err().unwrap().code, "invalid_response");
    }

    #[test]
    fn submission_statuses_map_through_the_shared_rule() {
        for (status, code) in [
            ("402 Payment Required", "provider_rejected"),
            ("429 Too Many Requests", "provider_rejected"),
            ("422 Unprocessable Entity", "provider_rejected"),
            ("503 Service Unavailable", "remote_outcome_unknown"),
        ] {
            let fake = Fake::start(move |_, _| {
                http(status, "application/json", b"{\"detail\":\"sk-leak\"}")
            });
            let err = run_ok(&fake.url()).err().unwrap();
            assert_eq!(err.code, code, "{status}");
            assert!(!err.message.contains("sk-leak"));
            if code == "provider_rejected" {
                assert!(err.message.contains(&status[..3]), "{}", err.message);
            }
            assert_eq!(fake.requests().len(), 1, "never retried");
        }
    }

    #[test]
    fn a_foreign_polling_host_never_receives_the_key() {
        let foreign = Fake::start(|_, _| json_reply(json!({"status":"Pending"})));
        let foreign_url = format!("http://localhost:{}/poll", foreign.addr.port());
        for target in [
            foreign_url,
            "https://evil.example/poll".to_owned(),
            "http://api.bfl.ai/poll".to_owned(),
        ] {
            let t = target.clone();
            let api = Fake::start(move |_, _| json_reply(json!({"id":"task-1","polling_url":t})));
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, "invalid_response", "{target}");
            assert_eq!(api.requests().len(), 1, "only the submit was sent");
        }
        assert!(foreign.requests().is_empty());
    }

    #[test]
    fn polling_url_rule_accepts_only_the_base_origin_and_bfl_api_hosts() {
        let base = url::Url::parse("https://api.eu.bfl.ai/v1").unwrap();
        let ok = |u: &str| polling_url_allowed(&url::Url::parse(u).unwrap(), &base);
        assert!(ok("https://api.eu.bfl.ai/v1/get_result?id=1"));
        assert!(ok("https://api.us.bfl.ai/v1/get_result?id=1"));
        assert!(ok("https://api.bfl.ai/v1/get_result?id=1"));
        // Other bfl.ai hosts (the delivery CDN, anything else) never get the key.
        assert!(!ok("https://delivery-eu.bfl.ai/x"));
        assert!(!ok("https://delivery.eu.bfl.ai/x"));
        assert!(!ok("https://bfl.ai/x"));
        assert!(!ok("https://api.a.b.bfl.ai/x"));
        assert!(!ok("https://api..bfl.ai/x"));
        // Scheme, port, userinfo, lookalikes, backslash and IDNA tricks.
        assert!(!ok("http://api.eu.bfl.ai/v1/get_result"));
        assert!(!ok("https://api.us.bfl.ai:8443/x"));
        assert!(!ok("https://api.eu.bfl.ai:8443/x"));
        assert!(!ok("https://bfl.ai.evil.example/x"));
        assert!(!ok("https://api.bfl.ai.evil.example/x"));
        assert!(!ok("https://evilbfl.ai/x"));
        assert!(!ok("https://user:pw@api.bfl.ai/x"));
        assert!(!ok("https://evil.com\\@api.bfl.ai/x"));
        assert!(!ok("https://evil.com#@api.bfl.ai/x"));
        assert!(!ok("https://\u{0430}pi.bfl.ai/x"));
        assert!(!ok("https://api.bfl.ai%2eevil.example/x"));
        let gateway = url::Url::parse("https://gateway.example/flux").unwrap();
        let g = |u: &str| polling_url_allowed(&url::Url::parse(u).unwrap(), &gateway);
        assert!(g("https://gateway.example/p"));
        assert!(!g("https://gateway.example:444/p"));
        assert!(!g("http://gateway.example/p"));
        assert!(!g("https://other.example/p"));
    }

    #[test]
    fn sample_url_rule_confines_hosts_and_refuses_internal_literals() {
        let allowed = |base: &str, sample: &str| {
            sample_url_allowed(
                &url::Url::parse(sample).unwrap(),
                &url::Url::parse(base).unwrap(),
            )
        };
        let bfl = "https://api.bfl.ai/v1";
        assert!(allowed(bfl, "https://delivery-us.bfl.ai/s.png"));
        assert!(!allowed(bfl, "https://cdn.evil.example/s.png"));
        assert!(!allowed(bfl, "http://delivery.bfl.ai/s.png"));
        assert!(allowed(
            "https://gateway.example/v1",
            "https://cdn.example/s.png"
        ));
        for literal in [
            "https://127.0.0.1/s",
            "https://10.1.2.3/s",
            "https://192.168.0.5/s",
            "https://169.254.169.254/s",
            "https://0.0.0.0/s",
            "https://[::1]/s",
            "https://[fd00::1]/s",
            "https://[fe80::1]/s",
            "https://[::ffff:10.0.0.1]/s",
        ] {
            assert!(!allowed("https://gateway.example/v1", literal), "{literal}");
        }
        assert!(allowed("https://gateway.example/v1", "https://8.8.8.8/s"));
        // A loopback base may fetch from itself (local gateways and tests).
        assert!(allowed("http://127.0.0.1:9/v1", "http://127.0.0.1:10/s"));
        assert!(!allowed("http://127.0.0.1:9/v1", "http://127.0.0.2:10/s"));
        assert!(!allowed(bfl, "https://user:pw@delivery.bfl.ai/s"));
    }

    #[test]
    fn cancellation_while_polling_is_unknown() {
        let api = Arc::new(Mutex::new(String::new()));
        let a = api.clone();
        let fake = Fake::start(move |req, _| {
            if req.method == "POST" {
                json_reply(json!({"id":"t","polling_url":format!("{}/p", a.lock().unwrap())}))
            } else {
                json_reply(json!({"status":"Pending"}))
            }
        });
        *api.lock().unwrap() = fake.url();
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            c.store(true, Ordering::Release);
        });
        let err = go(&fake.url(), "flux-2-pro", None, vec![], cancel)
            .err()
            .unwrap();
        assert_eq!(err.code, "cancelled_after_dispatch");
    }

    #[test]
    fn oversize_and_invalid_samples_are_unknown_responses() {
        let (api, _f) = flow(vec![ready()], vec![0u8; MAX_OUTPUT + 1]);
        assert_eq!(run_ok(&api.url()).err().unwrap().code, "invalid_response");
        let (api, _f) = flow(vec![ready()], b"not an image".to_vec());
        assert_eq!(run_ok(&api.url()).err().unwrap().code, "invalid_response");
    }

    #[test]
    fn a_sample_over_plain_http_on_a_foreign_host_is_refused_before_any_request() {
        let foreign = Fake::start(|_, _| http("200 OK", "image/png", b""));
        let sample = format!("http://localhost:{}/s.png", foreign.addr.port());
        let (api, _f) = flow(
            vec![json!({"status":"Ready","result":{"sample":sample}})],
            vec![],
        );
        assert_eq!(run_ok(&api.url()).err().unwrap().code, "invalid_response");
        assert!(foreign.requests().is_empty());
    }

    #[test]
    fn repeated_poll_failures_are_unknown_but_one_blip_is_tolerated() {
        let jpeg = encoded(image::ImageFormat::Jpeg, 50);
        let files = Fake::start(move |_, _| http("200 OK", "image/jpeg", &jpeg));
        let sample = format!("{}/s.jpg", files.url());
        let api = Arc::new(Mutex::new(String::new()));
        let a = api.clone();
        let blips = std::sync::atomic::AtomicUsize::new(0);
        let fake = Fake::start(move |req, _| {
            if req.method == "POST" {
                return json_reply(
                    json!({"id":"t","polling_url":format!("{}/p", a.lock().unwrap())}),
                );
            }
            if blips.fetch_add(1, Ordering::SeqCst) == 0 {
                http("503 Service Unavailable", "text/plain", b"x")
            } else {
                json_reply(json!({"status":"Ready","result":{"sample":sample}}))
            }
        });
        *api.lock().unwrap() = fake.url();
        assert!(run_ok(&fake.url()).is_ok());
        let always = Fake::start({
            let a = api.clone();
            move |req, _| {
                if req.method == "POST" {
                    json_reply(json!({"id":"t","polling_url":format!("{}/p", a.lock().unwrap())}))
                } else {
                    http("503 Service Unavailable", "text/plain", b"x")
                }
            }
        });
        *api.lock().unwrap() = always.url();
        assert_eq!(
            run_ok(&always.url()).err().unwrap().code,
            "remote_outcome_unknown"
        );
    }

    #[test]
    fn model_ids_cannot_inject_path_or_query() {
        let profile = profile("https://api.bfl.ai/v1");
        for bad in ["../x", "..", ".", ".hidden", "a/b", "m?x=1", "a b", ""] {
            let mut r = recipe(bad, None);
            if bad.is_empty() {
                r.model = None;
            }
            let result = model_name(
                &r,
                &ApiProfile {
                    default_model: String::new(),
                    ..profile.clone()
                },
            );
            assert!(result.is_err(), "{bad:?}");
        }
        assert_eq!(
            model_name(&recipe("flux-3-image", None), &profile).unwrap(),
            "flux-3-image"
        );
    }

    /// An API that accepts the submit and answers every poll with `poll`.
    fn api_with(poll: impl Fn(&Req, usize) -> Vec<u8> + Send + Sync + 'static) -> Fake {
        Fake::start(move |req, n| {
            if req.method == "POST" {
                let host = req.header("host").unwrap_or("127.0.0.1");
                json_reply(json!({"id":"task-1","polling_url":format!("http://{host}/poll")}))
            } else {
                poll(req, n)
            }
        })
    }
    fn ready_at(sample: String) -> impl Fn(&Req, usize) -> Vec<u8> + Send + Sync + 'static {
        move |_, _| json_reply(json!({"status":"Ready","result":{"sample":sample}}))
    }

    #[test]
    fn a_failed_sample_download_is_always_unknown_never_failed() {
        let cases: Vec<(&str, Box<dyn Fn(&Req, usize) -> Vec<u8> + Send + Sync>)> = vec![
            (
                "403 expired",
                Box::new(|_, _| http("403 Forbidden", "text/plain", b"expired")),
            ),
            (
                "404",
                Box::new(|_, _| http("404 Not Found", "text/plain", b"")),
            ),
            ("410", Box::new(|_, _| http("410 Gone", "text/plain", b""))),
            (
                "429",
                Box::new(|_, _| http("429 Too Many Requests", "text/plain", b"")),
            ),
            (
                "503",
                Box::new(|_, _| http("503 Service Unavailable", "text/plain", b"")),
            ),
            ("dropped connection", Box::new(|_, _| vec![])),
            (
                "truncated body",
                Box::new(|_, _| {
                    let mut r = http("200 OK", "image/png", &[0u8; 64]);
                    r.truncate(r.len() - 32);
                    r
                }),
            ),
        ];
        for (name, handler) in cases {
            let files = Fake::start(move |r, n| handler(r, n));
            let api = api_with(ready_at(format!("{}/s.png", files.url())));
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, "remote_outcome_unknown", "{name}");
            assert_eq!(files.requests().len(), 1, "{name}: never retried");
        }
    }

    #[test]
    fn cancellation_during_the_sample_download_is_unknown() {
        let files = Fake::start(|_, _| {
            std::thread::sleep(Duration::from_secs(3));
            http("200 OK", "image/png", b"")
        });
        let api = api_with(ready_at(format!("{}/s.png", files.url())));
        let cancel = Arc::new(AtomicBool::new(false));
        let c = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            c.store(true, Ordering::Release);
        });
        let started = std::time::Instant::now();
        let err = go(&api.url(), "flux-2-pro", None, vec![], cancel)
            .err()
            .unwrap();
        assert_eq!(err.code, "cancelled_after_dispatch");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn rate_limited_polls_back_off_but_other_client_errors_are_unknown() {
        let jpeg = encoded(image::ImageFormat::Jpeg, 70);
        let files = Fake::start(move |_, _| http("200 OK", "image/jpeg", &jpeg));
        let sample = format!("{}/s.jpg", files.url());
        let ok = api_with(move |_, n| {
            if n < 3 {
                http("429 Too Many Requests", "application/json", b"{}")
            } else {
                json_reply(json!({"status":"Ready","result":{"sample":sample}}))
            }
        });
        // submit is request 0, then two 429s, then Ready.
        assert!(run_ok(&ok.url()).is_ok());
        let always = api_with(|_, _| http("429 Too Many Requests", "application/json", b"{}"));
        assert_eq!(
            run_ok(&always.url()).err().unwrap().code,
            "remote_outcome_unknown"
        );
        assert_eq!(
            always.requests().len(),
            1 + MAX_TRANSIENT_POLL_FAILURES as usize
        );
        for status in [
            "400 Bad Request",
            "401 Unauthorized",
            "403 Forbidden",
            "404 Not Found",
        ] {
            let api = api_with(move |_, _| http(status, "application/json", b"{}"));
            assert_eq!(
                run_ok(&api.url()).err().unwrap().code,
                "remote_outcome_unknown",
                "{status}"
            );
            assert_eq!(
                api.requests().len(),
                2,
                "{status}: no retry of a definite 4xx"
            );
        }
    }

    #[test]
    fn a_non_2xx_poll_with_a_terminal_json_status_is_classified_by_status() {
        let cases = [
            (r#"{"id":"task-1","status":"Error"}"#, "provider_failed"),
            (r#"{"id":"task-1","status":"Failed"}"#, "provider_failed"),
            (
                r#"{"id":"task-1","status":"Content Moderated"}"#,
                "provider_refused",
            ),
            (
                r#"{"id":"task-1","status":"Request Moderated"}"#,
                "provider_refused",
            ),
            (
                r#"{"id":"task-1","status":"Task not found"}"#,
                "remote_outcome_unknown",
            ),
            // Not about this task: a gateway's own error JSON is no evidence.
            (r#"{"status":"Error"}"#, "remote_outcome_unknown"),
            (
                r#"{"id":"other","status":"Error"}"#,
                "remote_outcome_unknown",
            ),
            (r#"{"detail":"overloaded"}"#, "remote_outcome_unknown"),
            ("not json", "remote_outcome_unknown"),
        ];
        for (body, code) in cases {
            let api = api_with(move |_, _| {
                http(
                    "503 Service Unavailable",
                    "application/json",
                    body.as_bytes(),
                )
            });
            let err = run_ok(&api.url()).err().unwrap();
            assert_eq!(err.code, code, "{body}");
        }
    }

    #[test]
    fn an_oversize_poll_body_is_an_unknown_invalid_response() {
        let api = api_with(|_, _| {
            http(
                "200 OK",
                "application/json",
                &vec![b' '; POLL_BODY_LIMIT + 1],
            )
        });
        assert_eq!(run_ok(&api.url()).err().unwrap().code, "invalid_response");
        // An oversize error body is simply unusable, like any other transient failure.
        let big_error = api_with(|_, _| {
            http(
                "503 Service Unavailable",
                "application/json",
                &vec![b' '; POLL_BODY_LIMIT + 1],
            )
        });
        assert_eq!(
            run_ok(&big_error.url()).err().unwrap().code,
            "remote_outcome_unknown"
        );
    }

    #[test]
    fn reference_caps_follow_the_model_family_and_fail_before_any_request() {
        let table = [
            ("flux-2-pro", 8),
            ("flux-2-pro-preview", 8),
            ("flux-2-max", 8),
            ("flux-2-flex", 8),
            ("flux-2-klein-9b", 4),
            ("flux-2-klein-4b", 4),
            ("flux-kontext-pro", 4),
            ("flux-kontext-max", 4),
            ("flux-3-image", 10),
            ("flux-pro-1.1", 0),
            ("flux-dev", 0),
            ("flux-2-unheard-of", 0),
        ];
        for (model, cap) in table {
            assert_eq!(family(model).unwrap().cap(), cap, "{model}");
            let server = Fake::start(|_, _| http("400 Bad Request", "text/plain", b""));
            let inputs = (0..=cap).map(|i| input(i as u8)).collect();
            let err = go(
                &server.url(),
                model,
                None,
                inputs,
                Arc::new(AtomicBool::new(false)),
            )
            .err()
            .unwrap();
            assert_eq!(err.code, "invalid_request", "{model}");
            assert!(server.requests().is_empty(), "{model}: nothing may be sent");
            // At the cap the request is dispatched (the fake then rejects it).
            if cap > 0 {
                let inputs = (0..cap).map(|i| input(i as u8)).collect();
                let err = go(
                    &server.url(),
                    model,
                    None,
                    inputs,
                    Arc::new(AtomicBool::new(false)),
                )
                .err()
                .unwrap();
                assert_eq!(err.code, "provider_rejected", "{model}");
                assert_eq!(server.requests().len(), 1, "{model}");
            }
        }
    }

    #[test]
    fn only_flux_3_image_is_accepted_from_the_flux_3_family() {
        assert_eq!(family("flux-3-image").unwrap(), Family::Flux3);
        for bad in ["flux-3-video", "flux-3-image-v2", "flux-3", "flux-3-"] {
            assert_eq!(family(bad).unwrap_err().code, "invalid_request", "{bad}");
            let server = Fake::start(|_, _| http("400 Bad Request", "text/plain", b""));
            let err = go(
                &server.url(),
                bad,
                None,
                vec![],
                Arc::new(AtomicBool::new(false)),
            )
            .err()
            .unwrap();
            assert_eq!(err.code, "invalid_request", "{bad}");
            assert!(server.requests().is_empty(), "{bad}");
        }
    }
}
