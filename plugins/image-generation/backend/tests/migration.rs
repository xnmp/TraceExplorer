use image_generation_backend::{
    domain::{Configuration, Credential, Profile},
    profiles::Profiles,
};
use serde_json::{json, Value};
fn profile(id: &str) -> Profile {
    Profile::Http {
        id: id.into(),
        name: "Imported".into(),
        recipe_revision: "".into(),
        base_url: "https://custom.test/vendor/images".into(),
        default_model: "legacy-model".into(),
        allow_insecure_http: false,
        credential: Credential::Secret {
            id: format!("owned-secret-{id}"),
        },
    }
}
fn import(profiles: Vec<Profile>, expected: u64) -> Value {
    json!({"sourceId":"trace-openai-image-v1","sourceDigest":"a".repeat(64),"expectedRevision":expected,"defaultConnectionId":profiles.first().map(|p|p.id()),"profiles":profiles})
}
#[test]
fn trusted_import_commits_profiles_and_marker_together_and_survives_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let store = Profiles::new(directory.path());
    assert_eq!(
        store.import_status("trace-openai-image-v1").unwrap()["state"],
        "absent"
    );
    let params = import(vec![profile("legacy")], 0);
    let receipt = store.import(&params).unwrap();
    let saved = store.read().unwrap();
    assert_eq!(saved.document_revision, 1);
    assert_eq!(saved.default_connection_id, Some("legacy".into()));
    assert!(image_generation_backend::domain::id(
        saved.profiles[0].revision()
    ));
    let bytes = std::fs::read_to_string(directory.path().join("profiles.json")).unwrap();
    assert!(bytes.contains("owned-secret-legacy"));
    assert!(bytes.contains("trace-openai-image-v1"));
    let mut deleted = saved;
    deleted.profiles.clear();
    deleted.default_connection_id = None;
    store.save(deleted, 1, None, None).unwrap();
    let replay = json!({"sourceId":"trace-openai-image-v1","sourceDigest":"a".repeat(64),"expectedRevision":"invalid","profiles":null,"defaultConnectionId":123});
    assert_eq!(store.import(&replay).unwrap(), receipt);
    assert_eq!(
        store.import_status("trace-openai-image-v1").unwrap(),
        receipt
    );
    assert!(store.read().unwrap().profiles.is_empty());
    let changed = json!({"sourceId":"trace-openai-image-v1","sourceDigest":"b".repeat(64)});
    assert_eq!(
        store.import(&changed).unwrap_err().code,
        "operation_conflict"
    );
}
#[test]
fn imports_preserve_existing_destination_and_enforce_cas_id_collisions_and_source_shape() {
    let directory = tempfile::tempdir().unwrap();
    let store = Profiles::new(directory.path());
    let mut existing = profile("existing");
    *existing.credential_mut() = Credential::None;
    store
        .save(
            Configuration {
                schema_version: 1,
                document_revision: 0,
                default_connection_id: Some("existing".into()),
                profiles: vec![existing],
            },
            0,
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        store
            .import(&import(vec![profile("legacy")], 0))
            .unwrap_err()
            .code,
        "configuration_changed"
    );
    assert_eq!(
        store
            .import(&import(vec![profile("existing")], 1))
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    for change in [
        json!({"sourceId":"unknown"}),
        json!({"sourceDigest":"bad"}),
        json!({"defaultConnectionId":"missing"}),
        json!({"profiles":null}),
    ] {
        let mut params = import(vec![profile("legacy")], 1);
        for (key, value) in change.as_object().unwrap() {
            params[key] = value.clone();
        }
        assert!(store.import(&params).is_err());
        assert_eq!(
            store.import_status("trace-openai-image-v1").unwrap()["state"],
            "absent"
        );
    }
    store.import(&import(vec![profile("legacy")], 1)).unwrap();
    let saved = store.read().unwrap();
    assert_eq!(saved.default_connection_id, Some("existing".into()));
    assert_eq!(saved.profiles.len(), 2);
    let mut forged = saved.clone();
    forged.profiles.push(profile("untrusted"));
    assert!(store.save(forged, 2, None, None).is_err());
}
#[cfg(unix)]
#[test]
fn failed_import_write_preserves_both_old_profiles_and_absent_marker() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let store = Profiles::new(directory.path());
    let mut existing = profile("existing");
    *existing.credential_mut() = Credential::None;
    store
        .save(
            Configuration {
                schema_version: 1,
                document_revision: 0,
                default_connection_id: Some("existing".into()),
                profiles: vec![existing],
            },
            0,
            None,
            None,
        )
        .unwrap();
    let before = std::fs::read(directory.path().join("profiles.json")).unwrap();
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = store.import(&import(vec![profile("legacy")], 1));
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(directory.path().join("profiles.json")).unwrap(),
        before
    );
    assert_eq!(
        store.import_status("trace-openai-image-v1").unwrap()["state"],
        "absent"
    );
    assert_eq!(store.read().unwrap().profiles.len(), 1);
}
#[test]
fn malformed_import_receipt_or_retirement_history_rejects_preflight() {
    for mutation in [
        json!({"imports":[{"sourceId":"unknown","sourceDigest":"a".repeat(64),"profileIds":["legacy"]}]}),
        json!({"imports":[{"sourceId":"trace-openai-image-v1","sourceDigest":"bad","profileIds":["legacy"]}]}),
        json!({"imports":[{"sourceId":"trace-openai-image-v1","sourceDigest":"a".repeat(64),"profileIds":["legacy","legacy"]}]}),
        json!({"retiredProfileIds":["legacy"]}),
        json!({"retiredProfileIds":["bad/id"]}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = Profiles::new(directory.path());
        store.import(&import(vec![profile("legacy")], 0)).unwrap();
        let path = directory.path().join("profiles.json");
        let mut document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        for (key, value) in mutation.as_object().unwrap() {
            document[key] = value.clone();
        }
        std::fs::write(path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(store.preflight_read().unwrap_err().code, "unavailable");
    }
}

#[test]
fn rollback_epochs_with_unchanged_legacy_values_keep_independent_receipts_and_historical_default() {
    let directory = tempfile::tempdir().unwrap();
    let store = Profiles::new(directory.path());
    let original = store.import(&import(vec![profile("original")], 0)).unwrap();
    let original_profile = store.read().unwrap().profiles[0].clone();
    let epochs = [
        format!("trace-openai-image-v1.{}", "a".repeat(32)),
        format!("trace-openai-image-v1.{}", "0123456789abcdef".repeat(2)),
    ];
    let mut receipts = vec![];
    for (index, source) in epochs.iter().enumerate() {
        assert_eq!(store.import_status(source).unwrap()["state"], "absent");
        let mut request = import(
            vec![profile(&format!("rollback-{index}"))],
            index as u64 + 1,
        );
        request["sourceId"] = json!(source);
        let receipt = store.import(&request).unwrap();
        receipts.push(receipt.clone());
        let configuration = store.read().unwrap();
        assert_eq!(configuration.document_revision, index as u64 + 2);
        assert_eq!(
            configuration.default_connection_id.as_deref(),
            Some("original")
        );
        assert_eq!(configuration.profiles[0], original_profile);
        // Every epoch preserves the same old model/resource semantics in its
        // own profile and secret scope; it never edits an earlier profile.
        assert_eq!(configuration.profiles.len(), index + 2);
        assert_eq!(
            configuration.profiles[index + 1].credential(),
            &Credential::Secret {
                id: format!("owned-secret-rollback-{index}")
            }
        );
        let bytes = std::fs::read(directory.path().join("profiles.json")).unwrap();
        request["expectedRevision"] = json!("invalid");
        request["profiles"] = Value::Null;
        assert_eq!(store.import(&request).unwrap(), receipt);
        assert_eq!(
            std::fs::read(directory.path().join("profiles.json")).unwrap(),
            bytes
        );
    }
    drop(store);
    let reopened = Profiles::new(directory.path());
    reopened.preflight_read().unwrap();
    assert_eq!(
        reopened.import_status("trace-openai-image-v1").unwrap(),
        original
    );
    for (source, receipt) in epochs.iter().zip(receipts) {
        assert_eq!(reopened.import_status(source).unwrap(), receipt);
    }
    let document: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("profiles.json")).unwrap())
            .unwrap();
    assert_eq!(document["imports"].as_array().unwrap().len(), 3);
}

#[test]
fn lost_epoch_import_ack_reuses_its_committed_receipt_and_never_overwrites_original() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let directory = tempfile::tempdir().unwrap();
    let fail = Arc::new(AtomicBool::new(false));
    let store = Profiles::with_directory_sync(directory.path(), {
        let fail = fail.clone();
        Arc::new(move |_| {
            if fail.swap(false, Ordering::SeqCst) {
                Err(std::io::Error::other(
                    "Injected lost committed import acknowledgement",
                ))
            } else {
                Ok(())
            }
        })
    });
    let original = store.import(&import(vec![profile("original")], 0)).unwrap();
    let source = format!("trace-openai-image-v1.{}", "b".repeat(32));
    let mut request = import(vec![profile("rollback")], 1);
    request["sourceId"] = json!(source);
    fail.store(true, Ordering::Release);
    assert_eq!(
        store.import(&request).unwrap_err().code,
        "mutation_uncertain"
    );
    let receipt = store.import_status(&source).unwrap();
    assert_eq!(receipt["state"], "imported");
    let committed = store.read().unwrap();
    assert_eq!(committed.document_revision, 2);
    assert_eq!(committed.default_connection_id.as_deref(), Some("original"));
    let bytes = std::fs::read(directory.path().join("profiles.json")).unwrap();
    request["expectedRevision"] = json!(0);
    request["profiles"] = Value::Null;
    request["defaultConnectionId"] = json!("invalid");
    assert_eq!(store.import(&request).unwrap(), receipt);
    assert_eq!(
        std::fs::read(directory.path().join("profiles.json")).unwrap(),
        bytes
    );
    let mut deleted = committed;
    deleted.profiles.retain(|p| p.id() == "original");
    store.save(deleted, 2, None, None).unwrap();
    assert_eq!(store.import(&request).unwrap(), receipt);
    assert_eq!(
        store.import_status("trace-openai-image-v1").unwrap(),
        original
    );
    let mut changed = request.clone();
    changed["sourceDigest"] = json!("c".repeat(64));
    assert_eq!(
        store.import(&changed).unwrap_err().code,
        "operation_conflict"
    );
    assert_eq!(store.read().unwrap().profiles.len(), 1);
}

#[test]
fn invalid_epoch_sources_and_duplicate_historical_sources_fail_without_configuration_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let store = Profiles::new(directory.path());
    let original = store.import(&import(vec![profile("original")], 0)).unwrap();
    let path = directory.path().join("profiles.json");
    let before = std::fs::read(&path).unwrap();
    for source in [
        "trace-openai-image-v2".into(),
        "trace-openai-image-v1.".into(),
        format!("trace-openai-image-v1.{}", "a".repeat(31)),
        format!("trace-openai-image-v1.{}", "a".repeat(33)),
        format!("trace-openai-image-v1.{}", "A".repeat(32)),
        format!("trace-openai-image-v1.{}", "g".repeat(32)),
        format!("trace-openai-image-v1/{}", "a".repeat(32)),
        format!("trace-openai-image-v1..{}", "a".repeat(32)),
        format!("trace-openai-image-v1.{}", "a".repeat(1024 * 1024)),
    ] {
        let mut request = import(vec![profile("new")], 1);
        request["sourceId"] = json!(source);
        assert_eq!(store.import(&request).unwrap_err().code, "invalid_request");
        assert_eq!(
            store.import_status(&source).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            store.import_status("trace-openai-image-v1").unwrap(),
            original
        );
    }
    let mut document: Value = serde_json::from_slice(&before).unwrap();
    let receipt = document["imports"][0].clone();
    document["imports"].as_array_mut().unwrap().push(receipt);
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    assert_eq!(store.preflight_read().unwrap_err().code, "unavailable");
}
