//! Durable corruption fails closed, including in the actual native subprocess.
use image_generation_backend::{domain, error::error, journal::Journal};
use rusqlite::{params, Connection};
use std::process::{Command, Stdio};
use te_image_generation_contract::*;
fn fixture() -> (tempfile::TempDir, Caller, EffectiveRecipe) {
    let dir = tempfile::tempdir().unwrap();
    let caller = Caller {
        package_id: "test.consumer".into(),
        package_digest: "a".repeat(64),
        incarnation: 1,
    };
    let profile = domain::Profile::Http {
        id: "http".into(),
        name: "Fixture".into(),
        recipe_revision: "revision".into(),
        base_url: "https://unused.test/images".into(),
        default_model: "fixture".into(),
        allow_insecure_http: false,
        credential: domain::Credential::None,
    };
    let recipe = domain::recipe(
        &profile,
        &PrepareRequest {
            operation_id: "receipt".into(),
            connection_id: "http".into(),
            expected_connection_revision: "revision".into(),
            model: Some("fixture".into()),
            prompt: "Fixture prompt".into(),
            inputs: vec![],
            options: ImageOptions {
                size: "1024x1024".into(),
                resolution: None,
                aspect_ratio: None,
                quality: "auto".into(),
                background: "auto".into(),
            },
        },
    )
    .unwrap();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    journal
        .accept(&caller, "receipt", &"b".repeat(64), &recipe, false)
        .unwrap();
    assert!(journal.claim(&caller.package_id, "receipt").unwrap());
    journal
        .finish(
            &caller.package_id,
            "receipt",
            Execution::Unknown {
                error: error("interrupted", "Fixture interrupted execution"),
            },
            Delivery::None {},
            None,
        )
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    (dir, caller, recipe)
}
#[test]
fn startup_rejects_oversized_identity_and_inconsistent_receipts_without_rewriting_them() {
    for case in [
        "status",
        "context",
        "recipe",
        "output_descriptor",
        "semantic",
        "owner",
        "fingerprint",
        "recipe_identity",
        "operation",
        "output",
        "deadline",
        "boolean",
        "cancellation",
    ] {
        let (dir, _, _) = fixture();
        let path = dir.path().join("operations.sqlite");
        let db = Connection::open(&path).unwrap();
        match case {
            "status" | "context" | "recipe" | "output_descriptor" => {
                db.execute(
                    &format!("UPDATE operations SET {case}=?"),
                    params!["x".repeat(1024 * 1024 + 1)],
                )
                .unwrap();
            }
            "semantic" => {
                db.execute("UPDATE operations SET semantic='forged'", [])
                    .unwrap();
            }
            "owner" => {
                db.execute("UPDATE operations SET context=json_set(context,'$.packageId','other.consumer')",[]).unwrap();
            }
            "fingerprint" => {
                db.execute(
                    "UPDATE operations SET status=json_set(status,'$.requestFingerprint',?)",
                    params!["c".repeat(64)],
                )
                .unwrap();
            }
            "recipe_identity" => {
                db.execute("UPDATE operations SET recipe=json_set(recipe,'$.submittedPrompt','Changed task')",[]).unwrap();
            }
            "operation" => {
                db.execute(
                    "UPDATE operations SET status=json_set(status,'$.operationId','other')",
                    [],
                )
                .unwrap();
            }
            "output" => {
                db.execute(
                    "UPDATE operations SET output_sha256=?",
                    params!["c".repeat(64)],
                )
                .unwrap();
            }
            "deadline" => {
                db.execute(
                    "UPDATE operations SET deadline_at_ms=admitted_at_ms+900001",
                    [],
                )
                .unwrap();
            }
            "boolean" => {
                db.execute("UPDATE operations SET test=2", []).unwrap();
            }
            "cancellation" => {
                db.execute(
                    "INSERT INTO cancellations VALUES(?,?)",
                    params!["x".repeat(129), "receipt"],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        drop(db);
        let bytes = std::fs::read(&path).unwrap();
        assert!(Journal::open(dir.path()).is_err(), "{case}");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "{case} changed original ledger"
        );
        assert!(dir.path().join("operations.initialized").exists());
    }
}
#[test]
fn actual_native_startup_refuses_oversized_terminal_error_instead_of_dropping_a_reply() {
    let (dir, _, _) = fixture();
    let path = dir.path().join("operations.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE operations SET status=json_set(status,'$.execution.error.message',?)",
        params!["x".repeat(1024 * 1024 + 1)],
    )
    .unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_image-generation-backend"))
        .args(["--data-dir", dir.path().to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        result.stdout.is_empty(),
        "Corrupt receipts must not advertise readiness"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("initialization failed"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
#[test]
fn hot_reads_and_mutations_reject_post_activation_corruption_and_preserve_receipt() {
    let (dir, caller, _) = fixture();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    let db = Connection::open(dir.path().join("operations.sqlite")).unwrap();
    db.execute(
        "UPDATE operations SET status=json_set(status,'$.execution.error.message',?)",
        params!["x".repeat(1024 * 1024 + 1)],
    )
    .unwrap();
    assert_eq!(
        journal
            .get(&caller.package_id, "receipt", None)
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert!(journal
        .output_sha256(&caller.package_id, "receipt")
        .is_err());
    assert!(journal.cancel(&caller.package_id, "receipt").is_err());
    assert!(journal
        .finish(
            &caller.package_id,
            "receipt",
            Execution::Cancelled {},
            Delivery::None {},
            None
        )
        .is_err());
    assert!(
        db.query_row("SELECT length(status) FROM operations", [], |row| row
            .get::<_, i64>(0))
            .unwrap()
            > 1024 * 1024
    );
}
#[test]
fn rejected_malformed_local_write_rolls_back_and_large_valid_unicode_framing_recovers() {
    let (dir, caller, mut recipe) = fixture();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    assert!(journal
        .accept(&caller, "bad", "not-a-digest", &recipe, false)
        .is_err());
    assert!(journal
        .get(&caller.package_id, "bad", None)
        .unwrap()
        .is_none());
    recipe.submitted_prompt = "\0".repeat(16_000);
    recipe.input_digests = vec!["c".repeat(64), "d".repeat(64)];
    recipe.input_roles = vec!["Image 1".into(), "Image 2".into()];
    recipe.submitted_prompt = serde_json::json!({"prompt":recipe.submitted_prompt}).to_string();
    journal
        .accept(&caller, "large", &"b".repeat(64), &recipe, false)
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    let restored = Journal::open(dir.path()).unwrap();
    assert_eq!(
        restored
            .get(&caller.package_id, "large", None)
            .unwrap()
            .unwrap()
            .request_fingerprint,
        recipe.digest()
    );
}
#[test]
fn peer_errors_are_bounded_before_they_enter_a_durable_receipt() {
    let (dir, caller, recipe) = fixture();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    journal
        .accept(&caller, "peer", &"b".repeat(64), &recipe, false)
        .unwrap();
    journal.claim(&caller.package_id, "peer").unwrap();
    let failure = error("bad code", &format!("\0{}", "鳥".repeat(3000)));
    assert_eq!(failure.code, "host_unavailable");
    assert!(failure.message.len() <= 2048);
    assert!(!failure.message.contains('\0'));
    let receipt = journal
        .finish(
            &caller.package_id,
            "peer",
            Execution::Unknown { error: failure },
            Delivery::None {},
            None,
        )
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    assert_eq!(
        Journal::open(dir.path())
            .unwrap()
            .get(&caller.package_id, "peer", None)
            .unwrap()
            .unwrap(),
        receipt
    );
}
#[test]
fn impossible_live_capacity_fails_before_activation_writes_or_recovery() {
    let (dir, _, _) = fixture();
    let path = dir.path().join("operations.sqlite");
    let db = Connection::open(&path).unwrap();
    for i in 0..37 {
        let operation = format!("pending-{i}");
        db.execute("INSERT INTO operations SELECT caller,?,semantic,context,recipe,json_set(json_remove(status,'$.execution.error'),'$.operationId',?,'$.execution.state','accepted'),output_sha256,output_descriptor,cancel_requested,test,admitted_at_ms,deadline_at_ms FROM operations WHERE operation='receipt'",params![operation,operation]).unwrap();
    }
    drop(db);
    let before = std::fs::read(&path).unwrap();
    assert!(Journal::open(dir.path()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn known_success_proof_and_exact_first_candidate_are_durable_immutable_and_retryable_after_write_failure(
) {
    let (dir, caller, recipe) = fixture();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    journal
        .accept(&caller, "known-success", &"b".repeat(64), &recipe, false)
        .unwrap();
    journal.claim(&caller.package_id, "known-success").unwrap();
    let metadata = ImageMetadata {
        adapter: recipe.adapter.clone(),
        endpoint_identity: recipe.endpoint_identity.clone(),
        requested_model: recipe.model.clone(),
        actual_model: None,
        external_request_id: Some("fixture-success".into()),
        thread_id: None,
        options: recipe.options.clone(),
        remote_charge_uncertain: false,
    };
    let sha = "d".repeat(64);
    let proof = journal
        .record_success(&caller.package_id, "known-success", metadata.clone(), &sha)
        .unwrap();
    assert_eq!(proof.revision, 3);
    assert!(matches!(proof.execution, Execution::Succeeded { .. }));
    assert!(matches!(proof.delivery, Delivery::Unavailable { .. }));
    assert_eq!(
        journal
            .record_success(&caller.package_id, "known-success", metadata.clone(), &sha)
            .unwrap(),
        proof
    );
    let mut changed = metadata.clone();
    changed.actual_model = Some("forged-model".into());
    assert!(journal
        .record_success(&caller.package_id, "known-success", changed, &sha)
        .is_err());
    assert!(journal
        .record_success(
            &caller.package_id,
            "known-success",
            metadata.clone(),
            &"e".repeat(64)
        )
        .is_err());
    assert_eq!(
        journal
            .get(&caller.package_id, "known-success", None)
            .unwrap()
            .unwrap(),
        proof
    );
    let candidate = ArtifactDescriptor {
        handle: "original-stage".into(),
        sha256: sha.clone(),
        byte_length: 123,
        media_type: "image/png".into(),
    };
    let mut invalid = candidate.clone();
    invalid.sha256 = "e".repeat(64);
    assert!(journal
        .seal_candidate(
            &caller.package_id,
            "known-success",
            metadata.clone(),
            &invalid
        )
        .is_err());
    let db = Connection::open(dir.path().join("operations.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER candidate_write_failure BEFORE UPDATE ON operations BEGIN SELECT RAISE(FAIL,'fixture failure'); END;").unwrap();
    assert!(journal
        .seal_candidate(
            &caller.package_id,
            "known-success",
            metadata.clone(),
            &candidate
        )
        .is_err());
    assert_eq!(
        journal
            .get(&caller.package_id, "known-success", None)
            .unwrap()
            .unwrap(),
        proof
    );
    assert!(journal
        .output_descriptor(&caller.package_id, "known-success")
        .unwrap()
        .is_none());
    assert_eq!(
        journal
            .output_sha256(&caller.package_id, "known-success")
            .unwrap(),
        Some(sha.clone())
    );
    db.execute_batch("DROP TRIGGER candidate_write_failure;")
        .unwrap();
    drop(db);
    let attached = journal
        .seal_candidate(
            &caller.package_id,
            "known-success",
            metadata.clone(),
            &candidate,
        )
        .unwrap();
    assert_eq!(attached.execution, proof.execution);
    assert_eq!(attached.delivery, proof.delivery);
    assert_eq!(attached.revision, proof.revision + 1);
    assert_eq!(
        journal
            .seal_candidate(
                &caller.package_id,
                "known-success",
                metadata.clone(),
                &candidate
            )
            .unwrap(),
        attached
    );
    let mut substitute = candidate.clone();
    substitute.handle = "foreign-stage".into();
    assert!(journal
        .seal_candidate(
            &caller.package_id,
            "known-success",
            metadata.clone(),
            &substitute
        )
        .is_err());
    journal.checkpoint().unwrap();
    drop(journal);
    let reopened = Journal::open(dir.path()).unwrap();
    reopened.activate().unwrap();
    assert!(reopened.recover().unwrap().is_empty());
    assert_eq!(
        reopened
            .get(&caller.package_id, "known-success", None)
            .unwrap()
            .unwrap(),
        attached
    );
    assert_eq!(
        reopened
            .output_descriptor(&caller.package_id, "known-success")
            .unwrap(),
        Some(candidate.clone())
    );
    let disposed = reopened
        .acknowledge(&caller.package_id, "known-success", &sha, "discarded", None)
        .unwrap();
    assert!(reopened
        .seal_candidate(&caller.package_id, "known-success", metadata, &candidate)
        .is_err());
    assert_eq!(
        reopened
            .get(&caller.package_id, "known-success", None)
            .unwrap()
            .unwrap(),
        disposed
    );
}
