//! No network: public billing receipts, durable replacement, and legacy gates.
use image_generation_backend::{domain, host::wire_value, journal::Journal};
use serde_json::json;
use te_image_generation_contract::*;
fn recipe() -> EffectiveRecipe {
    serde_json::from_value(json!({"schemaVersion":1,"formatterVersion":1,"connectionId":"api","connectionRevision":"r1","adapter":"bfl","endpointIdentity":"https://api.bfl.ai/v1","model":"flux-2-pro","options":{"size":"auto","resolution":null,"aspectRatio":null,"quality":"auto","background":"auto"},"inputDigests":[],"inputRoles":[],"submittedPrompt":"a blue square","agentTask":null})).unwrap()
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
    let revision = journal
        .get(&caller.package_id, "operation", None)
        .unwrap()
        .unwrap()
        .revision;
    journal
        .record_billing(&caller.package_id, "operation", settled.clone())
        .unwrap();
    assert_eq!(
        journal
            .get(&caller.package_id, "operation", None)
            .unwrap()
            .unwrap()
            .revision,
        revision
    );
    journal
        .finish(
            &caller.package_id,
            "operation",
            Execution::Unknown {
                error: SafeError {
                    code: "remote_outcome_unknown".into(),
                    message: "Download failed".into(),
                    correlation_id: None,
                },
            },
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
    // On/off gating is byte-identical to serializing the same legacy receipt.
    assert_eq!(
        serde_json::to_vec(&wire_value(receipt_value(&status, true), false)).unwrap(),
        serde_json::to_vec(&old).unwrap()
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
