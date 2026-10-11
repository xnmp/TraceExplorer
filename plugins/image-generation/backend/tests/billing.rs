//! No network: public billing receipts, durable replacement, and legacy gates.
use image_generation_backend::{domain, host::wire_value, journal::Journal};
use serde_json::json;
use te_image_generation_contract::*;
fn recipe() -> EffectiveRecipe {
    serde_json::from_value(json!({"schemaVersion":1,"formatterVersion":1,"connectionId":"api","connectionRevision":"r1","adapter":"bfl","endpointIdentity":"https://api.bfl.ai/v1","model":"flux-2-pro","options":{"size":"auto","resolution":null,"aspectRatio":null,"quality":"auto","background":"auto"},"inputDigests":[],"inputRoles":[],"submittedPrompt":"a blue square","agentTask":null})).unwrap()
}
// The pre-billing contract rejects unknown fields on startup.
#[derive(Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyOperationStatus {
    version: u32,
    operation_id: String,
    request_fingerprint: String,
    provider: ProviderIdentity,
    revision: u64,
    execution: Execution,
    delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostics: Option<OperationDiagnostics>,
}

#[test]
fn cancelling_billed_running_and_terminal_receipts_preserves_old_journal_contract() {
    for terminal in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.activate().unwrap();
        let caller = Caller {
            package_id: "consumer".into(),
            package_digest: "a".repeat(64),
            incarnation: 1,
        };
        journal
            .accept(&caller, "operation", &"b".repeat(64), &recipe(), false)
            .unwrap();
        journal.claim(&caller.package_id, "operation").unwrap();
        let billing = domain::billing::bfl(&json!({"cost":8}), None).unwrap();
        journal
            .record_billing(&caller.package_id, "operation", billing.clone())
            .unwrap();
        if terminal {
            journal
                .finish(
                    &caller.package_id,
                    "operation",
                    download_failed(),
                    Delivery::None {},
                    None,
                )
                .unwrap();
        }
        let cancelled = journal.cancel(&caller.package_id, "operation").unwrap();
        journal.checkpoint().unwrap();
        drop(journal);
        let db = rusqlite::Connection::open(dir.path().join("operations.sqlite")).unwrap();
        let raw: String = db
            .query_row("SELECT status FROM operations", [], |r| r.get(0))
            .unwrap();
        let legacy: LegacyOperationStatus = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            receipt_value(&cancelled, false)
        );
        drop(db);
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(
            journal
                .get(&caller.package_id, "operation", None)
                .unwrap()
                .unwrap()
                .billing,
            Some(billing)
        );
    }
}

fn download_failed() -> Execution {
    Execution::Unknown {
        error: SafeError {
            code: "remote_outcome_unknown".into(),
            message: "Download failed".into(),
            correlation_id: None,
        },
    }
}
#[test]
fn billing_replaces_repeated_poll_evidence_and_survives_failed_download_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let caller = Caller {
        package_id: "consumer".into(),
        package_digest: "a".repeat(64),
        incarnation: 1,
    };
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    journal
        .accept(&caller, "operation", &"b".repeat(64), &recipe(), false)
        .unwrap();
    journal.claim(&caller.package_id, "operation").unwrap();
    let submit =
        domain::billing::bfl(&json!({"cost":4.5,"input_mp":1,"output_mp":2}), None).unwrap();
    journal
        .record_billing(&caller.package_id, "operation", submit.clone())
        .unwrap();
    let settled = domain::billing::bfl(&json!({"cost":8}), Some(&submit)).unwrap();
    journal
        .record_billing(&caller.package_id, "operation", settled.clone())
        .unwrap();
    let running = journal
        .get(&caller.package_id, "operation", None)
        .unwrap()
        .unwrap();
    assert_eq!(running.revision, 2);
    assert_eq!(running.billing, Some(settled.clone()));
    journal
        .record_billing(&caller.package_id, "operation", settled.clone())
        .unwrap();
    assert_eq!(
        journal
            .get(&caller.package_id, "operation", None)
            .unwrap()
            .unwrap()
            .revision,
        running.revision
    );
    journal
        .finish(
            &caller.package_id,
            "operation",
            download_failed(),
            Delivery::None {},
            None,
        )
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    // An older provider reads exactly the old status shape.
    let db = rusqlite::Connection::open(dir.path().join("operations.sqlite")).unwrap();
    let raw: String = db
        .query_row("SELECT status FROM operations", [], |r| r.get(0))
        .unwrap();
    assert!(serde_json::from_str::<serde_json::Value>(&raw)
        .unwrap()
        .get("billing")
        .is_none());
    drop(db);
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    let status = journal
        .get(&caller.package_id, "operation", None)
        .unwrap()
        .unwrap();
    assert_eq!(status.billing, Some(settled));
    assert!(matches!(status.execution, Execution::Unknown { .. }));
    assert_eq!(status.delivery, Delivery::None {});
    let old = receipt_value(&status, false);
    assert!(old.get("billing").is_none());
    assert_eq!(old["version"], 1);
    let new = receipt_value(&status, true);
    assert_eq!(new["billing"]["cost"]["amount"], "0.08");
    assert_eq!(new["billing"]["evidence"]["values"]["credits"], 8);
    for payload in [
        new.clone(),
        json!({"consumerPackageId":"consumer","status":new}),
        json!({"tests":[new]}),
    ] {
        let legacy = wire_value(payload.clone(), false);
        assert_eq!(
            serde_json::to_string(&legacy).unwrap().contains("billing"),
            false
        );
        assert_eq!(wire_value(payload.clone(), true), payload);
    }
    // Compare with an independent run where billing capture is absent.
    let legacy_dir = tempfile::tempdir().unwrap();
    let legacy_journal = Journal::open(legacy_dir.path()).unwrap();
    legacy_journal.activate().unwrap();
    let (accepted, _) = legacy_journal
        .accept(&caller, "operation", &"b".repeat(64), &recipe(), false)
        .unwrap();
    assert_eq!(accepted.revision, 1);
    legacy_journal
        .claim(&caller.package_id, "operation")
        .unwrap();
    legacy_journal
        .finish(
            &caller.package_id,
            "operation",
            download_failed(),
            Delivery::None {},
            None,
        )
        .unwrap();
    let baseline = legacy_journal
        .get(&caller.package_id, "operation", None)
        .unwrap()
        .unwrap();
    assert_eq!(baseline.revision, 3);
    assert_eq!(
        serde_json::to_vec(&wire_value(receipt_value(&status, true), false)).unwrap(),
        serde_json::to_vec(&receipt_value(&baseline, false)).unwrap()
    );
}
#[test]
fn old_journals_gain_billing_idempotently_without_losing_operations() {
    let dir = tempfile::tempdir().unwrap();
    let journal = Journal::open(dir.path()).unwrap();
    journal.activate().unwrap();
    let caller = Caller {
        package_id: "consumer".into(),
        package_digest: "a".repeat(64),
        incarnation: 1,
    };
    journal
        .accept(&caller, "old", &"b".repeat(64), &recipe(), false)
        .unwrap();
    journal.checkpoint().unwrap();
    drop(journal);
    let db = rusqlite::Connection::open(dir.path().join("operations.sqlite")).unwrap();
    db.execute_batch("ALTER TABLE operations DROP COLUMN billing")
        .unwrap();
    drop(db);
    for _ in 0..2 {
        let journal = Journal::open(dir.path()).unwrap();
        journal.activate().unwrap();
        assert!(journal
            .get("consumer", "old", None)
            .unwrap()
            .unwrap()
            .billing
            .is_none());
    }
}
#[test]
fn invalid_or_oversized_durable_billing_fails_closed() {
    for raw in [
        "x".repeat(17000),
        json!({"cost":{"amount":"-1","currency":"USD","estimated":false,"source":"bfl.credits"}})
            .to_string(),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.activate().unwrap();
        let caller = Caller {
            package_id: "consumer".into(),
            package_digest: "a".repeat(64),
            incarnation: 1,
        };
        journal
            .accept(&caller, "old", &"b".repeat(64), &recipe(), false)
            .unwrap();
        journal.checkpoint().unwrap();
        drop(journal);
        let db = rusqlite::Connection::open(dir.path().join("operations.sqlite")).unwrap();
        db.execute("UPDATE operations SET billing=?", [raw])
            .unwrap();
        drop(db);
        assert!(Journal::open(dir.path()).is_err());
    }
}

#[test]
fn provider_emissions_round_trip_through_shared_billing_validation() {
    for billing in [
        domain::billing::bfl(&json!({"cost": 4.5, "input_mp": 1}), None).unwrap(),
        domain::billing::openai(
            &json!({"usage": {"input_tokens": 0, "output_tokens": 1000}}),
            "gpt-image-1",
            "https://api.openai.com/v1/images",
        )
        .unwrap(),
        domain::billing::gemini(
            &json!({"usage": {"total_input_tokens": 0, "total_output_tokens": 1000,
                "output_tokens_by_modality": [{"modality": "image", "tokens": 1000}]}}),
            "gemini-3-pro-image",
            "https://generativelanguage.googleapis.com/v1beta",
        )
        .unwrap(),
    ] {
        assert!(billing.cost.is_some());
        let wire = serde_json::to_value(&billing).unwrap();
        assert_eq!(serde_json::from_value::<Billing>(wire).unwrap(), billing);
    }
}
