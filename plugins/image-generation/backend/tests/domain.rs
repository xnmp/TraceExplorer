use image_generation_backend::domain::*;
use te_image_generation_contract::*;
fn profile() -> Profile {
    Profile::Http {
        id: "custom".into(),
        name: "Custom".into(),
        recipe_revision: "revision-1".into(),
        base_url: "https://gateway.test/vendor/v1/images".into(),
        default_model: "free-model-id".into(),
        allow_insecure_http: false,
        credential: Credential::None,
    }
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
    if let Profile::Http {
        name, credential, ..
    } = &mut renamed
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
