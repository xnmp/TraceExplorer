//! Nano Banana (Gemini Interactions API) adapter, against a local HTTP server.
//! No real provider is ever contacted.
use base64::{engine::general_purpose::STANDARD, Engine};
use image_generation_backend::{
    adapters::{
        api::{descriptor, generate, ApiCall},
        Input,
    },
    domain::{base_url, capabilities, ApiKind, ApiProfile, Credential, Kind},
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{atomic::AtomicBool, Arc},
};
use te_image_generation_contract::{EffectiveRecipe, ImageOptions};

fn encoded(format: image::ImageFormat, color: u8) -> Vec<u8> {
    let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        8,
        4,
        image::Rgb([color, 0, 0]),
    ));
    let mut out = std::io::Cursor::new(vec![]);
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}
fn success(bytes: &[u8]) -> Value {
    json!({"id":"v1_abc-123","model":"gemini-nano-banana-2.1-actual","status":"completed",
      "steps":[{"type":"thought","summary":[]},
               {"type":"model_output","content":[{"type":"text","text":"Here"},{"type":"image","mime_type":"image/png","data":STANDARD.encode(bytes)}]}]})
}
/// One request in, one canned response out. Returns the base URL and a handle
/// yielding the raw request (headers + body).
fn serve(status: &'static str, body: Value) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!("http://{}/v1beta", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = vec![];
        loop {
            let mut chunk = [0; 8192];
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: ")?.trim().parse().ok())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let body = body.to_string();
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8_lossy(&bytes).to_string()
    });
    (root, handle)
}
fn recipe(resolution: Option<&str>, aspect: Option<&str>) -> EffectiveRecipe {
    EffectiveRecipe {
        schema_version: 1,
        formatter_version: 1,
        connection_id: "g".into(),
        connection_revision: "r".into(),
        adapter: "gemini".into(),
        endpoint_identity: "e".into(),
        model: Some("gemini-nano-banana-2.1".into()),
        options: ImageOptions {
            size: "auto".into(),
            resolution: resolution.map(Into::into),
            aspect_ratio: aspect.map(Into::into),
            quality: "auto".into(),
            background: "auto".into(),
        },
        input_digests: vec![],
        input_roles: vec![],
        submitted_prompt: "Combine Image 1 and Image 2".into(),
        agent_task: None,
    }
}
async fn run(
    root: &str,
    recipe: &EffectiveRecipe,
    inputs: Vec<Input>,
    key: Option<&str>,
) -> image_generation_backend::error::Result<image_generation_backend::adapters::Output> {
    let profile = ApiProfile {
        id: "g".into(),
        name: "G".into(),
        recipe_revision: "r".into(),
        base_url: root.into(),
        default_model: "gemini-nano-banana-2.1".into(),
        allow_insecure_http: false,
        credential: Credential::None,
    };
    generate(
        ApiKind::Gemini,
        ApiCall {
            profile: &profile,
            recipe,
            inputs,
            key: key.map(Into::into),
            cancel: Arc::new(AtomicBool::new(false)),
            evidence: Arc::new(|_| Ok(())),
            stage: Arc::new(|_| {}),
        },
    )
    .await
}
fn input(mime: &str, bytes: Vec<u8>) -> Input {
    Input {
        bytes,
        mime: mime.into(),
    }
}
fn body_of(request: &str) -> Value {
    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

#[tokio::test]
async fn request_is_an_interactions_post_with_header_auth_and_ordered_images() {
    let (root, wire) = serve("200 OK", success(&encoded(image::ImageFormat::Png, 9)));
    let first = encoded(image::ImageFormat::Png, 1);
    let second = encoded(image::ImageFormat::Jpeg, 2);
    let out = run(
        &root,
        &recipe(Some("2k"), Some("16:9")),
        vec![
            input("image/png", first.clone()),
            input("image/jpeg", second.clone()),
        ],
        Some("secret-key"),
    )
    .await
    .unwrap();
    let request = wire.join().unwrap();
    let lower = request.to_ascii_lowercase();
    assert!(request.starts_with("POST /v1beta/interactions HTTP/1.1"));
    assert!(lower.contains("x-goog-api-key: secret-key"));
    assert!(!lower.contains("authorization:"));
    assert_eq!(
        body_of(&request),
        json!({"model":"gemini-nano-banana-2.1","store":false,
          "input":[{"type":"text","text":"Combine Image 1 and Image 2"},
                   {"type":"image","mime_type":"image/png","data":STANDARD.encode(&first)},
                   {"type":"image","mime_type":"image/jpeg","data":STANDARD.encode(&second)}],
          "response_format":{"type":"image","aspect_ratio":"16:9","image_size":"2K"}})
    );
    assert_eq!(
        out.metadata.actual_model.as_deref(),
        Some("gemini-nano-banana-2.1-actual")
    );
    assert_eq!(
        out.metadata.external_request_id.as_deref(),
        Some("v1_abc-123")
    );
}
#[tokio::test]
async fn keep_and_unset_options_omit_the_fields_so_the_model_follows_the_inputs() {
    for aspect in [Some("keep"), None] {
        let (root, wire) = serve("200 OK", success(&encoded(image::ImageFormat::Png, 9)));
        run(&root, &recipe(None, aspect), vec![], None)
            .await
            .unwrap();
        let request = wire.join().unwrap();
        assert!(!request.to_ascii_lowercase().contains("x-goog-api-key"));
        assert_eq!(
            body_of(&request)["response_format"],
            json!({"type":"image"})
        );
        assert_eq!(body_of(&request)["input"].as_array().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn resolutions_map_to_uppercase_api_sizes() {
    for (ours, theirs) in [("1k", "1K"), ("2k", "2K"), ("4k", "4K")] {
        let (root, wire) = serve("200 OK", success(&encoded(image::ImageFormat::Png, 9)));
        run(&root, &recipe(Some(ours), None), vec![], None)
            .await
            .unwrap();
        assert_eq!(
            body_of(&wire.join().unwrap())["response_format"]["image_size"],
            theirs
        );
    }
}
#[tokio::test]
async fn png_and_jpeg_outputs_are_returned_as_png() {
    for format in [image::ImageFormat::Png, image::ImageFormat::Jpeg] {
        let (root, wire) = serve("200 OK", success(&encoded(format, 50)));
        let out = run(&root, &recipe(None, None), vec![], None).await.unwrap();
        wire.join().unwrap();
        assert_eq!(
            image::guess_format(&out.bytes).unwrap(),
            image::ImageFormat::Png
        );
    }
}
#[tokio::test]
async fn the_last_image_block_is_the_result_as_in_the_sdk() {
    let mut body = success(&encoded(image::ImageFormat::Png, 10));
    let second = encoded(image::ImageFormat::Png, 200);
    body["steps"][1]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"image","mime_type":"image/png","data":STANDARD.encode(&second)}));
    let (root, wire) = serve("200 OK", body);
    let out = run(&root, &recipe(None, None), vec![], None).await.unwrap();
    wire.join().unwrap();
    let pixel = image::load_from_memory(&out.bytes).unwrap().to_rgb8()[(0, 0)];
    assert_eq!(pixel.0[0], 200);
}
#[tokio::test]
async fn a_draft_image_in_a_thought_step_is_not_the_result() {
    let mut body = success(&encoded(image::ImageFormat::Png, 10));
    let draft = encoded(image::ImageFormat::Png, 99);
    body["steps"][0]["summary"] =
        json!([{"type":"image","mime_type":"image/png","data":STANDARD.encode(&draft)}]);
    body["steps"][0]["content"] =
        json!([{"type":"image","mime_type":"image/png","data":STANDARD.encode(&draft)}]);
    let (root, wire) = serve("200 OK", body);
    let out = run(&root, &recipe(None, None), vec![], None).await.unwrap();
    wire.join().unwrap();
    let pixel = image::load_from_memory(&out.bytes).unwrap().to_rgb8()[(0, 0)];
    assert_eq!(pixel.0[0], 10);
}
#[tokio::test]
async fn a_delivered_image_wins_over_diagnostic_block_codes() {
    // A billed image must never be reported as a retryable refusal.
    let mut body = success(&encoded(image::ImageFormat::Png, 10));
    body["errors"] = json!([{"code":"image_other","message":"PRIVATE"}]);
    body["error"] = json!({"code":"safety"});
    let (root, wire) = serve("200 OK", body);
    let out = run(&root, &recipe(None, None), vec![], None).await.unwrap();
    wire.join().unwrap();
    assert_eq!(
        image::guess_format(&out.bytes).unwrap(),
        image::ImageFormat::Png
    );
}
#[tokio::test]
async fn an_image_without_inline_data_is_unknown_not_a_refusal() {
    // URI delivery (or any non-inline shape) still means an image was produced.
    let body = json!({"status":"completed","steps":[{"type":"model_output","content":[
        {"type":"image","mime_type":"image/png","uri":"https://example.invalid/i.png"}]}]});
    assert_eq!(failure("200 OK", body).await.0, "invalid_response");
}
async fn failure(status: &'static str, body: Value) -> (String, String) {
    let (root, wire) = serve(status, body);
    let err = run(&root, &recipe(None, None), vec![], None)
        .await
        .err()
        .expect("expected a failure");
    wire.join().unwrap();
    (err.code, err.message)
}
#[tokio::test]
async fn every_documented_block_code_is_a_definite_refusal_with_fixed_wording() {
    let codes = [
        ("safety", "safety"),
        ("image_safety", "safety"),
        ("prohibited_content", "content policy"),
        ("image_prohibited_content", "content policy"),
        ("blocklist", "content policy"),
        ("recitation", "content policy"),
        ("image_recitation", "content policy"),
        ("spii", "content policy"),
        ("language", "no reason given"),
        ("image_other", "no reason given"),
        ("content_blocked", "no reason given"),
        ("no_image", "no reason given"),
    ];
    for (code, wording) in codes {
        // Carried either as a single error or in an errors array, in any case.
        for body in [
            json!({"status":"failed","error":{"code":code,"message":"PRIVATE PROSE sk-secret"}}),
            json!({"status":"failed","errors":[{"code":code.to_uppercase(),"message":"PRIVATE PROSE sk-secret"}]}),
        ] {
            let (c, message) = failure("200 OK", body).await;
            assert_eq!(c, "provider_refused", "{code}");
            assert_eq!(
                message,
                format!("The provider refused this request ({wording})")
            );
            assert!(!message.contains("PRIVATE"));
        }
    }
}
#[tokio::test]
async fn a_finished_interaction_without_an_image_is_a_definite_refusal() {
    for status in ["completed", "incomplete"] {
        let (c, m) = failure(
            "200 OK",
            json!({"status":status,"steps":[{"type":"model_output","content":[{"type":"text","text":"I cannot do that, PRIVATE"}]}]}),
        )
        .await;
        assert_eq!(c, "provider_refused");
        assert!(!m.contains("PRIVATE"));
    }
}
#[tokio::test]
async fn unfinished_malformed_or_corrupt_200s_are_invalid_responses() {
    for body in [
        json!({"status":"in_progress","steps":[]}),
        json!({"status":"failed","steps":[]}),
        json!({"status":"failed","error":{"code":"api_error"}}),
        json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"image","data":"not base64!"}]}]}),
        json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"image","data":STANDARD.encode(b"not an image")}]}]}),
        json!([]),
    ] {
        assert_eq!(failure("200 OK", body).await.0, "invalid_response");
    }
}
#[tokio::test]
async fn status_codes_follow_the_shared_rule_without_provider_prose() {
    for status in [
        "400 Bad Request",
        "401 Unauthorized",
        "403 Forbidden",
        "404 Not Found",
        "429 Too Many Requests",
    ] {
        let (c, m) = failure(
            status,
            json!({"error":{"code":"safety","message":"PRIVATE"}}),
        )
        .await;
        assert_eq!(c, "provider_rejected", "{status}");
        assert!(!m.contains("PRIVATE"));
    }
    for status in [
        "500 Internal Server Error",
        "503 Service Unavailable",
        "504 Gateway Timeout",
        "408 Request Timeout",
    ] {
        assert_eq!(
            failure(status, json!({})).await.0,
            "remote_outcome_unknown",
            "{status}"
        );
    }
}
#[tokio::test]
async fn a_connection_failure_is_unknown() {
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!("http://{}/v1beta", closed.local_addr().unwrap());
    drop(closed);
    let err = run(&root, &recipe(None, None), vec![], None)
        .await
        .err()
        .unwrap();
    assert_eq!(err.code, "remote_outcome_unknown");
}
#[tokio::test]
async fn a_stalled_response_is_unknown_when_cancelled() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let root = format!("http://{}/v1beta", listener.local_addr().unwrap());
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    std::thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        flag.store(true, std::sync::atomic::Ordering::Release);
        std::thread::sleep(std::time::Duration::from_millis(500));
    });
    let profile = ApiProfile {
        id: "g".into(),
        name: "G".into(),
        recipe_revision: "r".into(),
        base_url: root,
        default_model: "m".into(),
        allow_insecure_http: false,
        credential: Credential::None,
    };
    let recipe = recipe(None, None);
    let err = generate(
        ApiKind::Gemini,
        ApiCall {
            profile: &profile,
            recipe: &recipe,
            inputs: vec![],
            key: None,
            cancel,
            evidence: Arc::new(|_| Ok(())),
            stage: Arc::new(|_| {}),
        },
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err.code, "cancelled_after_dispatch");
}
#[test]
fn capabilities_list_resolution_and_aspect_ratios_but_no_sizes() {
    let caps = capabilities(Kind::Api(ApiKind::Gemini));
    assert!(caps.get("sizes").is_none());
    assert_eq!(caps["resolution"], json!(["1k", "2k", "4k"]));
    let ratios = caps["aspectRatio"].as_array().unwrap();
    assert!(ratios.contains(&json!("keep")) && ratios.contains(&json!("16:9")));
    assert_eq!(caps["quality"], json!(["auto"]));
    assert_eq!(caps["background"], json!(["auto"]));
    assert_eq!(caps["maxInputs"], 8);
}
#[test]
fn descriptor_values_and_base_url_rule() {
    let d = descriptor(ApiKind::Gemini);
    assert_eq!(d.transport, "gemini");
    assert_eq!(d.credential_env, "GEMINI_API_KEY");
    for bad in [
        "https://generativelanguage.googleapis.com/v1beta/models",
        "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent/",
        "http://generativelanguage.googleapis.com/v1beta",
    ] {
        assert!(base_url(ApiKind::Gemini, bad, false).is_err(), "{bad}");
    }
    for good in [
        "https://generativelanguage.googleapis.com/v1beta/",
        "https://gateway.test/gemini/v1",
        "https://gateway.test",
    ] {
        assert!(base_url(ApiKind::Gemini, good, false).is_ok(), "{good}");
    }
}
#[test]
fn prepare_accepts_only_the_options_the_backend_honours() {
    let d = descriptor(ApiKind::Gemini);
    let check = |size: &str, quality: &str, resolution: Option<&str>, aspect: Option<&str>| {
        let mut r = recipe(resolution, aspect).options;
        r.size = size.into();
        r.quality = quality.into();
        image_generation_backend::domain::options_problem(d, &r)
    };
    assert!(check("auto", "auto", Some("4k"), Some("keep")).is_none());
    assert!(check("1024x1024", "auto", None, None).is_some());
    assert!(check("auto", "high", None, None).is_some());
}
