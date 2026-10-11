use image_generation_backend::domain::ApiProfile;
use image_generation_backend::domain::*;
use te_image_generation_contract::*;
fn profile() -> Profile {
    Profile::OpenAiImages(ApiProfile {
        id: "custom".into(),
        name: "Custom".into(),
        recipe_revision: "revision-1".into(),
        base_url: "https://gateway.test/vendor/v1/images".into(),
        default_model: "free-model-id".into(),
        allow_insecure_http: false,
        credential: Credential::None,
    })
}
fn request() -> PrepareRequest {
    PrepareRequest {
        operation_id: "12345678-1234-1234-1234-123456789abc".into(),
        connection_id: "custom".into(),
        expected_connection_revision: "revision-1".into(),
        model: Some("free-model-id".into()),
        prompt: "Draw 日本鳥".into(),
        inputs: vec![ArtifactDescriptor {
            handle: "transient-handle".into(),
            sha256: "a".repeat(64),
            byte_length: 100,
            media_type: "image/png".into(),
        }],
        options: ImageOptions {
            size: "1024x1024".into(),
            resolution: None,
            aspect_ratio: None,
            quality: "low".into(),
            background: "auto".into(),
        },
    }
}
#[test]
fn deadline_clock_rollback_never_extends_the_original_monotonic_budget() {
    use std::time::Duration;
    let budget = Duration::from_secs(900);
    assert_eq!(remaining_budget(1_900_000, 1_000_000, budget), budget);
    assert_eq!(remaining_budget(1_900_000, 0, budget), budget);
    assert_eq!(remaining_budget(i64::MAX, i64::MIN, budget), budget);
    assert_eq!(
        remaining_budget(1_900_000, 1_850_000, budget),
        Duration::from_secs(50)
    );
    assert_eq!(
        remaining_budget(1_900_000, 2_000_000, budget),
        Duration::ZERO
    );
    assert_eq!(
        remaining_budget(1000, 0, Duration::from_millis(25)),
        Duration::from_millis(25)
    );
}
#[test]
fn canonical_recipe_matches_independent_unicode_fixture() {
    let recipe = recipe(&profile(), &request()).unwrap();
    assert_eq!(
        serde_json::to_string(&recipe).unwrap(),
        include_str!("fixtures/recipe-v1.json").trim_end()
    );
    assert_eq!(
        recipe.digest(),
        include_str!("fixtures/recipe-v1.sha256").trim()
    );
}
#[test]
fn recipes_exclude_transient_handles_secrets_labels_and_caller_epochs() {
    let mut changed = request();
    changed.inputs[0].handle = "different-handle".into();
    let mut renamed = profile();
    if let Profile::OpenAiImages(ApiProfile {
        name, credential, ..
    }) = &mut renamed
    {
        *name = "Other name".into();
        *credential = Credential::Secret {
            id: "secret-metadata-reference".into(),
        };
    }
    assert_eq!(
        recipe(&profile(), &request()).unwrap().digest(),
        recipe(&renamed, &changed).unwrap().digest()
    );
    let first = recipe(&profile(), &request()).unwrap();
    let mut swapped = request();
    swapped.inputs.push(ArtifactDescriptor {
        handle: "handle-2".into(),
        sha256: "b".repeat(64),
        byte_length: 100,
        media_type: "image/png".into(),
    });
    let ordered = recipe(&profile(), &swapped).unwrap();
    swapped.inputs.reverse();
    assert_ne!(
        ordered.digest(),
        recipe(&profile(), &swapped).unwrap().digest()
    );
    assert_ne!(first.digest(), ordered.digest());
}
#[test]
fn malformed_large_and_control_inputs_are_rejected_before_io() {
    for prompt in ["".into(), " ".into(), "x".repeat(16001)] {
        let mut bad = request();
        bad.prompt = prompt;
        assert!(validate_prepare(&bad).is_err());
    }
    for size in [
        "0x1024",
        "18446744073709551615x18446744073709551615",
        "1x1",
        "1025x1024",
        "3840x16",
    ] {
        let mut bad = request();
        bad.options.size = size.into();
        assert!(validate_prepare(&bad).is_err());
    }
    let mut bad = request();
    bad.inputs[0].byte_length = MAX_INPUT + 1;
    assert!(validate_prepare(&bad).is_err());
    let mut bad = request();
    bad.inputs = vec![request().inputs[0].clone(); 9];
    assert!(validate_prepare(&bad).is_err());
    let mut bad = request();
    bad.inputs[0].media_type = "image/svg+xml".into();
    assert!(validate_prepare(&bad).is_err());
    let mut bad = request();
    bad.inputs[0].sha256 = "invalid".into();
    assert!(validate_prepare(&bad).is_err());
}
#[test]
fn custom_roots_models_and_credential_sources_are_validated_without_brand_enums() {
    assert_eq!(
        root("https://gateway.test/nested/images///", false).unwrap(),
        "https://gateway.test/nested/images"
    );
    assert!(root("http://127.0.0.1:1/images", false).is_ok());
    assert!(root("http://private.test/images", false).is_err());
    assert!(root("http://private.test/images", true).is_ok());
    for source in [
        Credential::Environment {
            name: "BAD-NAME".into(),
        },
        Credential::Environment {
            name: "1KEY".into(),
        },
        Credential::Secret {
            id: "owner/secret".into(),
        },
        Credential::CliSavedLogin,
    ] {
        let mut profile = profile();
        *profile.credential_mut() = source;
        let mut configuration = Configuration {
            schema_version: 1,
            document_revision: 0,
            default_connection_id: Some("custom".into()),
            profiles: vec![profile],
        };
        assert!(validate_configuration(&mut configuration).is_err());
    }
    let mut bad = request();
    bad.model = Some("model\nsecret".into());
    assert!(recipe(&profile(), &bad).is_err());
}
#[test]
fn cli_image_model_is_adapter_managed_and_framing_preserves_equal_inputs() {
    let profile = Profile::Codex {
        id: "custom".into(),
        name: "Codex".into(),
        recipe_revision: "revision-1".into(),
        executable_path: "".into(),
        model_selection: false,
        credential: Credential::CliSavedLogin,
    };
    let mut request = request();
    assert!(recipe(&profile, &request).is_err());
    request.model = None;
    request.options.quality = "auto".into();
    assert!(recipe(&profile, &request)
        .unwrap()
        .agent_task
        .unwrap()
        .contains("built-in image generation tool exactly once"));
    assert_eq!(recipe(&profile, &request).unwrap().model, None);
    request.options.background = "transparent".into();
    assert!(recipe(&profile, &request).is_err());
    assert!(framing(2)
        .unwrap()
        .contains("equal inputs; none is the main image"));
}

#[test]
fn blank_codex_path_has_a_stable_nonempty_adapter_managed_identity() {
    let profile = Profile::Codex {
        id: "custom".into(),
        name: "Codex".into(),
        recipe_revision: "revision-1".into(),
        executable_path: String::new(),
        model_selection: false,
        credential: Credential::CliSavedLogin,
    };
    let mut request = request();
    request.model = None;
    request.options.quality = "auto".into();
    let recipe = recipe(&profile, &request).unwrap();
    assert_eq!(recipe.endpoint_identity, "codex-cli:auto-discovery");
    assert_eq!(recipe.model, None);
    assert!(recipe
        .agent_task
        .unwrap()
        .contains("built-in image generation tool exactly once"));
}
#[test]
fn turn_facts_bound_usage_and_failures_without_retaining_successful_transcripts() {
    use image_generation_backend::domain::codex_evidence;
    let receipt = codex_evidence::turn(
        "12345678-1234-1234-1234-123456789abc".into(),
        CodexTurnState::Completed,
        &serde_json::json!({"input_tokens":3,"cached_input_tokens":u64::MAX,"output_tokens":"secret","untrusted":"ignored"}),
    );
    assert!(receipt.valid(true));
    assert!(!serde_json::to_string(&receipt).unwrap().contains("secret"));
    let failed = codex_evidence::failure(
        receipt.clone(),
        Some(&format!("\u{1b}{}", "鳥".repeat(5000))),
        None,
    );
    assert!(failed.valid(false));
    assert!(!failed.valid(true));
    let OperationDiagnostics::CodexImageTurn {
        explanation: Some(explanation),
        ..
    } = &failed
    else {
        panic!("No failure explanation");
    };
    assert_eq!(explanation.kind, ExplanationKind::Reply);
    assert!(explanation.truncated);
    assert!(explanation.text.len() <= 4096);
    assert!(!explanation.text.contains('\u{1b}'));
    let error = codex_evidence::error_message(
        image_generation_backend::error::error("remote_outcome_unknown", "Image not proven."),
        &failed,
    );
    assert!(error.message.len() < 1024);
    assert!(error.message.contains("鳥"));
    assert!(codex_evidence::same_turn(&receipt, &failed));
    let error = codex_evidence::failure(receipt, Some("reply"), Some("Reported refusal"));
    let OperationDiagnostics::CodexImageTurn {
        explanation: Some(explanation),
        ..
    } = error
    else {
        panic!("No refusal");
    };
    assert_eq!(explanation.kind, ExplanationKind::Error);
    assert_eq!(explanation.text, "Reported refusal");
}

// ---- API connection registry ----

fn api_json(transport: &str) -> serde_json::Value {
    serde_json::json!({"transport":transport,"id":"api","name":"Api","recipeRevision":"r1","baseUrl":"https://gateway.test/v1/images","defaultModel":"model-x","allowInsecureHttp":false,"credential":{"kind":"environment","name":"SOME_KEY"}})
}
#[test]
fn api_profiles_round_trip_the_exact_serialized_shape_and_reject_unknown_fields() {
    let value = api_json("openai-images");
    let parsed: Profile = serde_json::from_value(value.clone()).unwrap();
    assert!(
        matches!(parsed.api(), Some((ApiKind::OpenAiImages, p)) if p.default_model == "model-x")
    );
    assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    let mut extra = value.clone();
    extra["surprise"] = true.into();
    assert!(serde_json::from_value::<Profile>(extra).is_err());
    let mut missing = value;
    missing.as_object_mut().unwrap().remove("baseUrl");
    assert!(serde_json::from_value::<Profile>(missing).is_err());
    assert!(serde_json::from_value::<Profile>(api_json("no-such-backend")).is_err());
}
#[test]
fn a_third_api_transport_loads_validates_and_round_trips() {
    let configuration = serde_json::json!({"schemaVersion":1,"documentRevision":3,"defaultConnectionId":"api","profiles":[api_json("fixture-images")]});
    let mut parsed: Configuration = serde_json::from_value(configuration.clone()).unwrap();
    validate_configuration(&mut parsed).unwrap();
    assert_eq!(
        serde_json::to_value(&parsed).unwrap()["profiles"][0]["transport"],
        "fixture-images"
    );
    let (kind, _) = parsed.profiles[0].api().unwrap();
    assert_eq!(kind.transport(), "fixture-images");
    assert_eq!(parsed.profiles[0].id(), "api");
    assert_eq!(parsed.profiles[0].revision(), "r1");
    // The generic recipe uses the transport as adapter and requires a model.
    let mut req = request();
    req.connection_id = "api".into();
    req.expected_connection_revision = "r1".into();
    let recipe = recipe(&parsed.profiles[0], &req).unwrap();
    assert_eq!(recipe.adapter, "fixture-images");
    assert_eq!(recipe.endpoint_identity, "https://gateway.test/v1/images");
    req.model = None;
    assert!(self::recipe(&parsed.profiles[0], &req).is_err());
    // Descriptor limits apply: the fixture accepts at most two inputs.
    let mut many = request();
    many.connection_id = "api".into();
    many.expected_connection_revision = "r1".into();
    many.inputs = vec![request().inputs[0].clone(); 3];
    assert!(self::recipe(&parsed.profiles[0], &many).is_err());
}
#[test]
fn capabilities_are_built_per_connection_kind_from_the_descriptor() {
    let codex = capabilities(Kind::Codex);
    assert_eq!(codex["modelSelection"], false);
    assert_eq!(codex["quality"], serde_json::json!(["auto"]));
    let openai = capabilities(Kind::Api(ApiKind::OpenAiImages));
    assert_eq!(openai["modelSelection"], true);
    assert_eq!(openai["maxInputs"], 8);
    assert_eq!(
        openai["quality"],
        serde_json::json!(["auto", "low", "medium", "high"])
    );
    assert_eq!(
        openai["background"],
        serde_json::json!(["auto", "opaque", "transparent"])
    );
    assert!(openai.get("resolution").is_none());
    let fixture = capabilities(Kind::Api(ApiKind::Fixture));
    assert_eq!(fixture["maxInputs"], 2);
    assert_eq!(fixture["quality"], serde_json::json!(["auto"]));
    assert_eq!(fixture["resolution"], serde_json::json!(["1k", "2k", "4k"]));
}
#[test]
fn transport_names_follow_the_host_identifier_rule() {
    for ok in ["openai-images", "a", "gemini-2", &"a".repeat(64)] {
        assert!(transport_id(ok), "{ok}");
    }
    for bad in [
        "",
        "1abc",
        "-a",
        "A",
        "has_underscore",
        "a b",
        &"a".repeat(65),
    ] {
        assert!(!transport_id(bad), "{bad}");
    }
}
#[test]
fn the_base_url_hook_is_the_backends_own_rule() {
    assert!(base_url(
        ApiKind::OpenAiImages,
        "https://x.test/v1/images/edits",
        false
    )
    .is_err());
    assert!(base_url(ApiKind::Fixture, "https://x.test/v1/images/edits", false).is_ok());
    // Generic rules apply to every backend.
    assert!(base_url(ApiKind::Fixture, "https://u:p@x.test/v1", false).is_err());
    assert!(base_url(ApiKind::Fixture, "http://private.test/v1", false).is_err());
}
#[test]
fn frontend_registry_matches_the_backend_descriptors() {
    // `backends.json` is the frontend's registry; the descriptors must agree on
    // everything both sides know. The test-only fixture backend is not offered to users.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        transport: String,
        default_base_url: String,
        credential_env: String,
    }
    let entries: Vec<Entry> = serde_json::from_str(include_str!("../../backends.json")).unwrap();
    let real: Vec<_> = ApiKind::ALL
        .iter()
        .filter(|k| k.transport() != "fixture-images")
        .collect();
    assert_eq!(
        entries.len(),
        real.len(),
        "every backend needs exactly one registry entry"
    );
    for kind in real {
        let d = image_generation_backend::adapters::api::descriptor(*kind);
        let entry = entries
            .iter()
            .find(|e| e.transport == d.transport)
            .unwrap_or_else(|| panic!("no registry entry for {}", d.transport));
        assert_eq!(entry.default_base_url, d.default_base_url);
        assert_eq!(entry.credential_env, d.credential_env);
        assert!(transport_id(d.transport) && d.transport != "codex-cli");
        // The advertised default URL must be acceptable to the backend itself.
        assert!(base_url(*kind, d.default_base_url, false).is_ok());
    }
}
