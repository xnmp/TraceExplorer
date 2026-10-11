//! Pure timing-cohort identity, independent of prompt, credentials and artifacts.
use serde_json::Value;
use sha2::{Digest, Sha256};
use te_image_generation_contract::EffectiveRecipe;

pub(super) fn estimate_key(recipe: &EffectiveRecipe) -> String {
    // A fixed tuple gives unambiguous encoding even for delimiters or Unicode.
    // Keep both requested size and resolution: some adapters consume only one.
    let cohort = (
        crate::host_image::PACKAGE,
        &recipe.adapter,
        &recipe.model,
        &recipe.options.size,
        &recipe.options.resolution,
        !recipe.input_digests.is_empty(),
    );
    format!(
        "image-v1:{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&cohort).expect("estimate tuple serialization")
        ))
    )
}

pub(super) fn with_estimate_key(
    mut status: Value,
    recipe: &EffectiveRecipe,
    supported: bool,
) -> Value {
    if supported {
        status["estimateKey"] = estimate_key(recipe).into();
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recipe() -> EffectiveRecipe {
        serde_json::from_value(json!({
            "schemaVersion":1,"formatterVersion":1,"connectionId":"profile","connectionRevision":"rev",
            "adapter":"codex-cli","endpointIdentity":"local","model":null,
            "options":{"size":"1024x1024","resolution":"1k","aspectRatio":"1:1","quality":"auto","background":"auto"},
            "inputDigests":[],"inputRoles":[],"submittedPrompt":"Draw a cat","agentTask":null
        })).unwrap()
    }

    #[test]
    fn deterministic_bounded_and_independent_of_secrets_prompt_and_input_identity() {
        let original = recipe();
        let key = estimate_key(&original);
        assert_eq!(key, estimate_key(&original.clone()));
        assert!(key.len() <= 128 && key.bytes().all(|b| b.is_ascii_graphic()));
        let mut different = original.clone();
        different.connection_id = "other".into();
        different.connection_revision = "other".into();
        different.endpoint_identity = "https://private".into();
        different.submitted_prompt = "雪".repeat(1_000_000);
        different.agent_task = Some("private task".into());
        assert_eq!(key, estimate_key(&different));
        different.adapter = "雪|:".repeat(100_000);
        different.model = Some("large".repeat(100_000));
        assert_eq!(estimate_key(&different).len(), key.len());
        different.adapter = String::new();
        different.model = Some(String::new());
        assert_eq!(estimate_key(&different).len(), key.len());
    }

    #[test]
    fn adapter_model_size_resolution_and_presence_of_inputs_define_the_cohort() {
        let original = recipe();
        let key = estimate_key(&original);
        for changed in [
            EffectiveRecipe {
                adapter: "gemini-images".into(),
                ..original.clone()
            },
            EffectiveRecipe {
                model: Some("model-a".into()),
                ..original.clone()
            },
            EffectiveRecipe {
                input_digests: vec!["a".into()],
                ..original.clone()
            },
            EffectiveRecipe {
                options: te_image_generation_contract::ImageOptions {
                    size: "2048x2048".into(),
                    ..original.options.clone()
                },
                ..original.clone()
            },
            EffectiveRecipe {
                options: te_image_generation_contract::ImageOptions {
                    resolution: Some("2k".into()),
                    ..original.options.clone()
                },
                ..original.clone()
            },
        ] {
            assert_ne!(key, estimate_key(&changed));
        }
        let one = EffectiveRecipe {
            input_digests: vec!["a".into()],
            ..original.clone()
        };
        let many = EffectiveRecipe {
            input_digests: vec!["b".into(); 100_000],
            ..original
        };
        assert_eq!(estimate_key(&one), estimate_key(&many));
    }

    #[test]
    fn capability_gate_omits_the_extension_on_older_hosts() {
        let status = json!({"jobId":7});
        assert_eq!(with_estimate_key(status.clone(), &recipe(), false), status);
        let supported = with_estimate_key(status, &recipe(), true);
        assert_eq!(supported["jobId"], 7);
        assert_eq!(supported["estimateKey"], estimate_key(&recipe()));
    }
}
