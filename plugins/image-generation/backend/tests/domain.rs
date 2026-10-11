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
    req.options.quality = "auto".into();
    req.options.size = "auto".into();
    let recipe = recipe(&parsed.profiles[0], &req).unwrap();
    assert_eq!(recipe.adapter, "fixture-images");
    assert_eq!(recipe.endpoint_identity, "https://gateway.test/v1/images");
    req.model = None;
    assert!(self::recipe(&parsed.profiles[0], &req).is_err());
    // Descriptor limits apply: the fixture accepts at most two inputs.
    let mut many = request();
    many.connection_id = "api".into();
    many.expected_connection_revision = "r1".into();
    many.options.quality = "auto".into();
    many.options.size = "auto".into();
    assert!(self::recipe(&parsed.profiles[0], &{
        let mut one = many.clone();
        one.inputs.truncate(2);
        one
    })
    .is_ok());
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
    // A ratio-based backend publishes no pixel sizes.
    assert!(fixture.get("sizes").is_none());
    assert!(openai.get("sizes").is_some());
}
#[test]
fn a_connection_without_pixel_sizes_accepts_the_request_its_form_sends() {
    let configuration = serde_json::json!({"schemaVersion":1,"documentRevision":0,"defaultConnectionId":null,"profiles":[api_json("fixture-images")]});
    let mut parsed: Configuration = serde_json::from_value(configuration).unwrap();
    validate_configuration(&mut parsed).unwrap();
    let mut req = request();
    req.connection_id = "api".into();
    req.expected_connection_revision = "r1".into();
    req.options.size = "auto".into();
    req.options.quality = "auto".into();
    req.options.background = "auto".into();
    req.options.resolution = Some("2k".into());
    req.options.aspect_ratio = Some("16:9".into());
    let recipe = recipe(&parsed.profiles[0], &req).unwrap();
    assert_eq!(recipe.options.size, "auto");
    assert_eq!(recipe.options.resolution.as_deref(), Some("2k"));
    assert_eq!(recipe.options.aspect_ratio.as_deref(), Some("16:9"));
    // Hidden controls are omitted (null) and still valid.
    req.options.resolution = None;
    req.options.aspect_ratio = None;
    assert!(self::recipe(&parsed.profiles[0], &req).is_ok());
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
fn generic_url_rules_apply_to_every_backend_and_a_backend_without_rules_adds_none() {
    assert!(base_url(ApiKind::Fixture, "https://x.test/v1/images/edits", false).is_ok());
    assert!(base_url(ApiKind::Fixture, "https://u:p@x.test/v1", false).is_err());
    assert!(base_url(ApiKind::Fixture, "http://private.test/v1", false).is_err());
    let err = base_url(ApiKind::Bfl, "https://x.test/v1?k=1", false).unwrap_err();
    assert!(
        !err.message.to_lowercase().contains("images"),
        "{}",
        err.message
    );
}
fn url_ok(kind: ApiKind, url: &str) -> bool {
    base_url(kind, url, false).is_ok()
}
#[test]
fn openai_rejects_operation_segments_anywhere_in_the_path() {
    let k = ApiKind::OpenAiImages;
    for ok in [
        "https://g.test/v1/images",
        "https://g.test/v1/images/",
        "https://g.test/vendor/generation/v1",
        "https://g.test/models/v1/images",
    ] {
        assert!(url_ok(k, ok), "{ok}");
    }
    for bad in [
        "https://g.test/v1/images/edits",
        "https://g.test/v1/images/edits/",
        "https://g.test/v1/images/GENERATIONS",
        "https://g.test/v1/edits/images",
    ] {
        assert!(!url_ok(k, bad), "{bad}");
    }
}
#[test]
fn gemini_rejects_model_and_interaction_segments_anywhere_in_the_path() {
    let k = ApiKind::Gemini;
    assert!(url_ok(k, "https://g.test/v1beta"));
    assert!(url_ok(k, "https://g.test/v1beta/"));
    assert!(url_ok(k, "https://g.test/modelsx/v1beta"));
    for bad in [
        "https://g.test/v1beta/models",
        "https://g.test/v1beta/Models/",
        "https://g.test/v1beta/models/gemini-x:generateContent",
        "https://g.test/v1beta/interactions",
        "https://g.test/models/v1beta",
    ] {
        assert!(!url_ok(k, bad), "{bad}");
    }
    let err = base_url(ApiKind::Gemini, "https://g.test/v1beta/models", false).unwrap_err();
    assert!(
        err.message.contains("/models") && err.message.contains("Gemini API root URL"),
        "{}",
        err.message
    );
}
#[test]
fn bfl_rejects_any_flux_prefixed_segment_case_insensitively() {
    let k = ApiKind::Bfl;
    for ok in [
        "https://api.bfl.ai/v1",
        "https://api.bfl.ai/v1/",
        "https://api.eu.bfl.ai",
        "https://api.bfl.ai/proxy/fl/v1",
    ] {
        assert!(url_ok(k, ok), "{ok}");
    }
    for bad in [
        "https://api.bfl.ai/v1/flux-2-pro",
        "https://api.bfl.ai/V1/FLUX-2-PRO",
        "https://api.bfl.ai/v1/flux-3-image/",
        "https://api.bfl.ai/fluxproxy/v1",
        "https://api.bfl.ai/flux/v1/x",
    ] {
        assert!(!url_ok(k, bad), "{bad}");
    }
}
fn bfl_profile(model: &str) -> Profile {
    let mut json = api_json("bfl");
    json["baseUrl"] = "https://api.bfl.ai/v1".into();
    json["defaultModel"] = model.into();
    serde_json::from_value(json).unwrap()
}
fn validates(profile: Profile) -> bool {
    let mut c = Configuration {
        profiles: vec![profile],
        ..Configuration::default()
    };
    validate_configuration(&mut c).is_ok()
}
#[test]
fn bfl_default_models_must_be_safe_path_segments() {
    let long = "a".repeat(129);
    for bad in ["flux 2 pro", ".", "..", "-x", "a/b", "m?x=1", long.as_str()] {
        assert!(!validates(bfl_profile(bad)), "{bad:?}");
    }
    for ok in ["flux-2-pro", "flux.2_pro", "A", &"a".repeat(128)] {
        assert!(validates(bfl_profile(ok)), "{ok:?}");
    }
}
#[test]
fn gateway_style_model_ids_stay_valid_for_backends_without_path_models() {
    for transport in ["openai-images", "gemini"] {
        for model in ["vendor/model", "gpt image", "..", "-x"] {
            let mut json = api_json(transport);
            json["defaultModel"] = model.into();
            json["baseUrl"] = "https://g.test/v1".into();
            assert!(
                validates(serde_json::from_value(json).unwrap()),
                "{transport} {model}"
            );
        }
    }
}
#[test]
fn prepare_rejects_a_per_job_bfl_model_that_is_not_a_path_segment() {
    let profile = bfl_profile("flux-2-pro");
    let mut req = request();
    req.connection_id = "api".into();
    req.expected_connection_revision = "r1".into();
    req.inputs.clear();
    req.options.size = "auto".into();
    req.options.quality = "auto".into();
    req.options.background = "auto".into();
    req.model = Some("flux-2-pro".into());
    assert!(recipe(&profile, &req).is_ok());
    for bad in ["flux 2 pro", "..", "a/b", "-x"] {
        req.model = Some(bad.into());
        assert!(recipe(&profile, &req).is_err(), "{bad}");
    }
    // A gateway-style id is still fine where the model is not part of the path.
    let mut open_ai = serde_json::from_value::<Profile>(api_json("openai-images")).unwrap();
    open_ai.set_revision("r1".into());
    req.model = Some("vendor/model x".into());
    assert!(recipe(&open_ai, &req).is_ok());
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
        base_url_label: String,
        rejected_path_segments: Vec<String>,
        model_id_in_path: bool,
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
        // Every entry declares its rules, and the backend resolves the same ones.
        assert!(!entry.base_url_label.is_empty());
        let rules = backend_rules::for_transport(d.transport)
            .unwrap_or_else(|| panic!("no rules for {}", d.transport));
        assert_eq!(rules.rejected_path_segments, entry.rejected_path_segments);
        assert_eq!(rules.model_id_in_path, entry.model_id_in_path);
        assert!(entry.rejected_path_segments.iter().all(|p| !p.is_empty()));
    }
}
#[test]
fn every_backend_transport_has_rules_and_a_malformed_rules_file_is_rejected() {
    for kind in ApiKind::ALL
        .iter()
        .filter(|k| k.transport() != "fixture-images")
    {
        assert!(
            backend_rules::for_transport(kind.transport()).is_some(),
            "{}",
            kind.transport()
        );
    }
    // A registry entry missing a rules field cannot be parsed as rules.
    let missing = r#"[{"transport":"x","baseUrlLabel":"X","rejectedPathSegments":[]}]"#;
    assert!(serde_json::from_str::<Vec<backend_rules::BackendRules>>(missing).is_err());
}
fn stored(adapter: &str) -> image_generation_backend::domain::stored_receipt::StoredReceipt {
    let recipe = EffectiveRecipe {
        schema_version: 1,
        formatter_version: 1,
        connection_id: "api".into(),
        connection_revision: "r1".into(),
        adapter: adapter.into(),
        endpoint_identity: "https://gateway.test/v1/images".into(),
        model: Some("model-x".into()),
        options: ImageOptions {
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
    let status = OperationStatus {
        version: 1,
        operation_id: "12345678-1234-1234-1234-123456789abc".into(),
        request_fingerprint: recipe.digest(),
        provider: ProviderIdentity {
            package_id: "xnmp.image-generation".into(),
            service_id: "image-generation".into(),
            major: 1,
        },
        revision: 1,
        execution: Execution::Failed {
            error: SafeError {
                code: "provider_rejected".into(),
                message: "Image provider rejected the request (HTTP 400)".into(),
                correlation_id: None,
            },
        },
        delivery: Delivery::None {},
        diagnostics: None,
        billing: None,
    };
    image_generation_backend::domain::stored_receipt::StoredReceipt {
        caller: "consumer.pkg".into(),
        operation: status.operation_id.clone(),
        semantic: "b".repeat(64),
        context: Caller {
            package_id: "consumer.pkg".into(),
            package_digest: "c".repeat(64),
            incarnation: 1,
        },
        recipe: Some(recipe),
        status,
        output_sha: None,
        output: None,
        cancelled: false,
        test: false,
        admitted: 0,
        deadline: 0,
    }
}
#[test]
fn stored_receipts_accept_any_valid_api_adapter_id_and_reject_invalid_ones() {
    assert!(stored("openai-images").valid());
    assert!(stored("future-images").valid());
    for bad in [
        "",
        "Future",
        "1abc",
        "has_underscore",
        "a b",
        &"a".repeat(65),
    ] {
        assert!(!stored(bad).valid(), "{bad}");
    }
    // API receipts still need a model and no agent task.
    let mut no_model = stored("future-images");
    no_model.recipe.as_mut().unwrap().model = None;
    assert!(!no_model.valid());
}
fn api_request(id: &str, rev: &str) -> PrepareRequest {
    let mut req = request();
    req.connection_id = id.into();
    req.expected_connection_revision = rev.into();
    req.inputs.truncate(1);
    req.options.quality = "auto".into();
    req.options.background = "auto".into();
    req
}
fn loaded(transport: &str) -> Profile {
    let mut parsed: Configuration = serde_json::from_value(serde_json::json!({"schemaVersion":1,"documentRevision":0,"defaultConnectionId":null,"profiles":[api_json(transport)]})).unwrap();
    validate_configuration(&mut parsed).unwrap();
    parsed.profiles.remove(0)
}
#[test]
fn recipes_enforce_the_descriptors_option_tables() {
    // openai-images: all qualities/backgrounds; sizes, so resolution/aspect are accepted as size inputs.
    let openai = loaded("openai-images");
    let mut req = api_request("api", "r1");
    req.options.quality = "high".into();
    req.options.background = "transparent".into();
    req.options.resolution = Some("2k".into());
    req.options.aspect_ratio = Some("keep".into());
    assert!(recipe(&openai, &req).is_ok());
    // fixture-images: auto only, no pixel sizes.
    let fixture = loaded("fixture-images");
    let mut req = api_request("api", "r1");
    req.options.size = "auto".into();
    req.options.resolution = Some("2k".into());
    req.options.aspect_ratio = Some("16:9".into());
    assert!(recipe(&fixture, &req).is_ok());
    for mutate in [
        (|r: &mut PrepareRequest| r.options.quality = "high".into()) as fn(&mut PrepareRequest),
        |r| r.options.background = "transparent".into(),
        |r| r.options.size = "1024x1024".into(),
    ] {
        let mut bad = req.clone();
        mutate(&mut bad);
        assert!(recipe(&fixture, &bad).is_err());
    }
    let mut bad = api_request("api", "r1");
    bad.options.quality = "ultra".into();
    assert!(recipe(&openai, &bad).is_err());
}
#[test]
fn options_problem_rejects_unsupported_resolution_and_aspect_ratio() {
    use image_generation_backend::adapters::api::{ApiDescriptor, Auth, Options};
    const BARE: ApiDescriptor = ApiDescriptor {
        transport: "bare-images",
        default_base_url: "https://bare.test",
        credential_env: "BARE_KEY",
        auth: Auth::Bearer,
        options: Options {
            test_size: "auto",
            quality: &["auto"],
            background: &["auto"],
            resolution: false,
            aspect_ratio: false,
            sizes: false,
        },
        max_inputs: 1,
    };
    let mut options = request().options;
    options.size = "auto".into();
    options.quality = "auto".into();
    options.background = "auto".into();
    assert_eq!(options_problem(&BARE, &options), None);
    options.resolution = Some("2k".into());
    assert!(options_problem(&BARE, &options).is_some());
    options.resolution = None;
    options.aspect_ratio = Some("1:1".into());
    assert!(options_problem(&BARE, &options).is_some());
}

#[test]
fn the_bfl_backend_is_ratio_based_and_rejects_model_paths_in_its_root() {
    let caps = capabilities(Kind::Api(ApiKind::Bfl));
    assert!(caps.get("sizes").is_none());
    assert!(caps.get("resolution").is_none());
    assert_eq!(caps["maxInputs"], 8);
    assert_eq!(caps["quality"], serde_json::json!(["auto"]));
    assert_eq!(caps["aspectRatio"][0], "keep");
    assert_eq!(ApiKind::Bfl.transport(), "bfl");
    assert!(base_url(ApiKind::Bfl, "https://api.eu.bfl.ai/v1", false).is_ok());
    assert!(base_url(ApiKind::Bfl, "https://api.bfl.ai/v1/flux-2-pro", false).is_err());
    let json = serde_json::json!({"schemaVersion":1,"documentRevision":0,"defaultConnectionId":null,"profiles":[api_json("bfl")]});
    let mut parsed: Configuration = serde_json::from_value(json).unwrap();
    validate_configuration(&mut parsed).unwrap();
    assert_eq!(parsed.profiles[0].kind(), Kind::Api(ApiKind::Bfl));
    // The form's request (ratio, no resolution or pixel size) is accepted; a resolution is not.
    let mut req = request();
    req.connection_id = "api".into();
    req.expected_connection_revision = "r1".into();
    req.options.size = "auto".into();
    req.options.quality = "auto".into();
    req.options.background = "auto".into();
    req.options.aspect_ratio = Some("16:9".into());
    assert!(recipe(&parsed.profiles[0], &req).is_ok());
    req.options.resolution = Some("2k".into());
    assert!(recipe(&parsed.profiles[0], &req).is_err());
}

#[test]
fn command_credentials_validate_argv_and_serialize_as_metadata() {
    for argv in [
        vec![],
        vec!["relative/helper".into()],
        vec!["C:helper.exe".into()],
        vec![".".into()],
        vec!["..".into()],
        vec!["relative\\helper".into()],
        vec!["helper".into(), "bad\nargument".into()],
        vec!["helper".into(); 33],
        vec!["helper".into(), "".into()],
        vec!["helper".into(), "é".repeat(2049)],
    ] {
        let mut p = profile();
        *p.credential_mut() = Credential::Command { argv };
        let mut config = Configuration {
            profiles: vec![p],
            ..Configuration::default()
        };
        assert!(validate_configuration(&mut config).is_err());
    }
    for argv in [
        vec![
            "secret-tool".into(),
            "lookup".into(),
            "service".into(),
            "gemini".into(),
        ],
        vec![std::env::current_exe().unwrap().to_str().unwrap().into()],
        vec!["helper".into(); 32],
        vec!["helper".into(), "é".repeat(2048)],
    ] {
        let credential = Credential::Command { argv: argv.clone() };
        assert_eq!(
            serde_json::to_value(&credential).unwrap(),
            serde_json::json!({"kind":"command","argv":argv})
        );
        let mut p = profile();
        *p.credential_mut() = credential;
        let mut config = Configuration {
            profiles: vec![p],
            ..Configuration::default()
        };
        validate_configuration(&mut config).unwrap();
    }
    let mut config = Configuration {
        profiles: vec![Profile::Codex {
            id: "cli".into(),
            name: "CLI".into(),
            recipe_revision: "r1".into(),
            executable_path: "".into(),
            model_selection: false,
            credential: Credential::Command {
                argv: vec!["helper".into()],
            },
        }],
        ..Configuration::default()
    };
    assert!(validate_configuration(&mut config).is_err());
}

#[test]
fn windows_batch_targets_require_an_explicit_interpreter() {
    use credential_rules::implicit_windows_shell;
    for program in [
        "helper.bat",
        "helper.CMD",
        "C:\\Tools\\helper.cmd",
        "helper.cmd .",
    ] {
        assert!(implicit_windows_shell(program));
    }
    for program in [
        "pwsh",
        "helper.exe",
        "C:\\Tools\\helper.com",
        "/usr/bin/secret-tool",
    ] {
        assert!(!implicit_windows_shell(program));
    }
}

#[test]
fn test_recipes_choose_minimal_options_for_every_catalogued_model() {
    for (kind, model, size, resolution, quality) in [
        (
            Kind::Api(ApiKind::OpenAiImages),
            Some("gpt-image-2"),
            "1024x1024",
            None,
            "low",
        ),
        (
            Kind::Api(ApiKind::OpenAiImages),
            Some("gpt-image-2.5-sunburst"),
            "1024x1024",
            None,
            "low",
        ),
        (
            Kind::Api(ApiKind::OpenAiImages),
            Some("gpt-image-2.5-flare"),
            "1024x1024",
            None,
            "low",
        ),
        (
            Kind::Api(ApiKind::OpenAiImages),
            Some("custom-model"),
            "1024x1024",
            None,
            "low",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("gemini-nano-banana-2.1"),
            "auto",
            Some("1k"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("gemini-3.1-flash-image"),
            "auto",
            Some("512"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("gemini-3.1-flash-lite-image"),
            "auto",
            Some("1k"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("gemini-3-pro-image"),
            "auto",
            Some("1k"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("gemini-2.5-flash-image"),
            "auto",
            Some("1k"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Gemini),
            Some("custom-model"),
            "auto",
            Some("1k"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-pro"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-pro-preview"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-max"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-flex"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-klein-9b"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-klein-9b-preview"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-klein-4b"),
            "64x64",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-kontext-pro"),
            "auto",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-kontext-max"),
            "auto",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-3-image"),
            "auto",
            Some("768sq"),
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-pro-1.1"),
            "256x256",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-dev"),
            "256x256",
            None,
            "auto",
        ),
        (
            Kind::Api(ApiKind::Bfl),
            Some("flux-2-unheard-of"),
            "auto",
            None,
            "auto",
        ),
        (Kind::Codex, None, "1024x1024", None, "auto"),
    ] {
        let options = test_recipe_options(kind, model);
        assert_eq!(options.size, size, "{model:?}");
        assert_eq!(options.resolution.as_deref(), resolution, "{model:?}");
        assert_eq!(options.quality, quality);
        assert_eq!(options.background, "auto");
        assert_eq!(options.aspect_ratio, None);
        if let Kind::Api(kind) = kind {
            assert!(recipe_options_valid(kind.transport(), model, &options));
            assert_eq!(model_options_problem(kind, model, &options), None);
        } else {
            assert!(options.valid());
        }
    }
}

#[test]
fn private_test_minima_are_confined_to_the_exact_supported_models() {
    let small_gemini =
        test_recipe_options(Kind::Api(ApiKind::Gemini), Some("gemini-3.1-flash-image"));
    for model in [
        "gemini-nano-banana-2.1",
        "gemini-3.1-flash-lite-image",
        "custom",
        "gemini-3.1-flash-image-future",
    ] {
        assert!(model_options_problem(ApiKind::Gemini, Some(model), &small_gemini).is_some());
    }
    let small_flux = test_recipe_options(Kind::Api(ApiKind::Bfl), Some("flux-2-pro"));
    for model in [
        "flux-kontext-pro",
        "flux-3-image",
        "flux-dev",
        "custom",
        "flux-2-pro-future",
    ] {
        assert!(model_options_problem(ApiKind::Bfl, Some(model), &small_flux).is_some());
    }
    let small_flux3 = test_recipe_options(Kind::Api(ApiKind::Bfl), Some("flux-3-image"));
    assert!(model_options_problem(ApiKind::Bfl, Some("flux-2-pro"), &small_flux3).is_some());
    assert!(model_options_problem(ApiKind::OpenAiImages, Some("custom"), &small_flux).is_some());
    for (adapter, model, options) in [
        ("gemini", "custom", &small_gemini),
        ("bfl", "custom", &small_flux),
        ("codex-cli", "custom", &small_flux3),
    ] {
        assert!(!recipe_options_valid(adapter, Some(model), options));
    }
}

#[test]
fn minimal_test_options_survive_stored_receipt_validation() {
    for (kind, model) in [
        (ApiKind::Gemini, "gemini-3.1-flash-image"),
        (ApiKind::Bfl, "flux-2-pro"),
        (ApiKind::Bfl, "flux-dev"),
        (ApiKind::Bfl, "flux-3-image"),
    ] {
        let mut receipt = stored(kind.transport());
        let recipe = receipt.recipe.as_mut().unwrap();
        recipe.model = Some(model.into());
        recipe.options = test_recipe_options(Kind::Api(kind), Some(model));
        receipt.status.request_fingerprint = recipe.digest();
        receipt.test = true;
        assert!(receipt.valid(), "{model}");
        receipt.recipe.as_mut().unwrap().model = Some("incompatible-custom-model".into());
        receipt.status.request_fingerprint = receipt.recipe.as_ref().unwrap().digest();
        assert!(!receipt.valid(), "{model}");
    }
}
