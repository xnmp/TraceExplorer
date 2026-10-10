//! Contract integration through the real Trace dispatcher/database and shared
//! reverse client. The host side is a deterministic wire fixture, not a live AI.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use trace_explorer_backend::{dispatch, host_rpc, initialize, EventEmitter, Request};

struct Fixture {
    revision: u64,
    fingerprint: String,
    text: String,
    returned_revision: Option<u64>,
    inputs: Vec<String>,
}
async fn rpc(method: &str, params: Value) -> Value {
    dispatch(
        EventEmitter::new(|_, _| Ok(())),
        Request {
            jsonrpc: "2.0".into(),
            id: 1,
            method: method.into(),
            params,
        },
    )
    .await
}
async fn title(run_id: i64, id: &str, revision: u64) -> Value {
    rpc(
        "trace_prompt_title",
        json!({"runId":run_id,"requestId":id,"expectedConfigurationRevision":revision}),
    )
    .await
}

#[tokio::test]
async fn titles_use_persisted_prompts_deduplicate_and_isolate_generation_contexts() {
    let root = tempfile::tempdir().unwrap();
    initialize(root.path()).unwrap();
    let fixture = Arc::new(Mutex::new(Fixture {
        revision: 1,
        fingerprint: "f".repeat(64),
        text: "Moonlit forest".into(),
        returned_revision: None,
        inputs: vec![],
    }));
    let provider = fixture.clone();
    host_rpc::configure(move |frame| {
        let mut fixture = provider.lock().unwrap();
        let context = json!({"profileId":"custom","configurationRevision":fixture.revision,"fingerprint":fixture.fingerprint,"transport":"openai-chat-completions","requestedModel":"custom-model"});
        let result = match frame["method"].as_str() {
            Some("host.text.describe") => {
                json!({"version":1,"enabled":true,"available":true,"configurationRevision":fixture.revision,"context":context})
            }
            Some("host.text.generate") => {
                let request = &frame["params"];
                assert!(request["requestId"]
                    .as_str()
                    .unwrap()
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)));
                assert_eq!(request["maxOutputTokens"], 64);
                assert_eq!(request["expectedConfigurationRevision"], fixture.revision);
                assert!(request["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("as data"));
                assert!(request.get("codexPath").is_none());
                fixture
                    .inputs
                    .push(request["input"].as_str().unwrap().into());
                let mut context = context;
                if let Some(revision) = fixture.returned_revision {
                    context["configurationRevision"] = json!(revision);
                }
                json!({"text":fixture.text,"context":context})
            }
            Some("host.text.cancel") => json!({"cancelled":true}),
            _ => panic!("Unexpected host call: {frame}"),
        };
        drop(fixture);
        assert!(host_rpc::deliver(
            &json!({"jsonrpc":"2.0","id":frame["id"],"result":result})
        ));
        Ok(())
    });
    assert!(rpc(
        "initialize",
        json!({"protocolVersion":1,"activeRunIds":[],"textService":{"version":1}})
    )
    .await
    .get("error")
    .is_none());
    for _ in 0..2 {
        let response = rpc(
            "provenance.begin",
            json!({"start":{"operation":"openai.image.generate","parameters":{},"inputs":[]}}),
        )
        .await;
        assert!(response.get("error").is_none(), "{response}");
    }
    let database = root.path().join("trace.sqlite");
    let db = Connection::open(&database).unwrap();
    let prompt =
        "A full persisted prompt with details beyond any truncated graph label. 黄昏的森林";
    db.execute(
        "UPDATE runs SET parameters=?1 WHERE id=1",
        [json!({"prompt":prompt}).to_string()],
    )
    .unwrap();
    db.execute(
        "UPDATE runs SET parameters=?1 WHERE id=2",
        [json!({"prompt":prompt}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO image_prompt_titles(digest,title) VALUES('legacy','Old Codex title')",
        [],
    )
    .unwrap();
    drop(db);
    let request_id = "title-550e8400-e29b-41d4-a716-446655440000-1";
    let (first, duplicate) = tokio::join!(title(1, request_id, 1), title(2, "title-second", 1));
    assert_eq!(first["result"]["title"], "Moonlit forest", "{first}");
    assert_eq!(
        duplicate["result"]["title"], "Moonlit forest",
        "{duplicate}"
    );
    assert_eq!(fixture.lock().unwrap().inputs, vec![prompt]);
    {
        let mut fixture = fixture.lock().unwrap();
        fixture.revision = 2;
        fixture.fingerprint = "a".repeat(64);
        fixture.text = "黄昏的森林".into();
    }
    assert_eq!(
        title(1, "title-new-context", 2).await["result"]["title"],
        "黄昏的森林"
    );
    assert_eq!(fixture.lock().unwrap().inputs.len(), 2);
    // Credential rotation advances revision but keeps the non-secret cache identity.
    fixture.lock().unwrap().revision = 3;
    assert_eq!(
        title(1, "title-rotated", 3).await["result"]["title"],
        "黄昏的森林"
    );
    assert_eq!(fixture.lock().unwrap().inputs.len(), 2);
    assert!(title(1, "title-old-revision", 2)
        .await
        .get("error")
        .is_some());
    {
        let mut fixture = fixture.lock().unwrap();
        fixture.revision = 4;
        fixture.fingerprint = "b".repeat(64);
        fixture.returned_revision = Some(5);
    }
    assert!(title(1, "title-mismatched-result", 4)
        .await
        .get("error")
        .is_some());
    fixture.lock().unwrap().returned_revision = None;
    fixture.lock().unwrap().text = "first\nsecond".into();
    assert!(title(1, "title-invalid-result", 4)
        .await
        .get("error")
        .is_some());
    let db = Connection::open(database).unwrap();
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM image_prompt_titles_v1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
    let legacy: String = db
        .query_row(
            "SELECT title FROM image_prompt_titles WHERE digest='legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(legacy, "Old Codex title");
    db.execute(
        "INSERT INTO runs(id,operation,parameters) VALUES(3,'openai.image.generate',?1)",
        params![json!({"prompt":"x".repeat(16_001)}).to_string()],
    )
    .unwrap();
    drop(db);
    let calls = fixture.lock().unwrap().inputs.len();
    assert!(title(3, "title-too-large", 4).await.get("error").is_some());
    rpc(
        "trace_cancel_prompt_title",
        json!({"requestId":"title-cancelled-before-admission"}),
    )
    .await;
    assert!(title(1, "title-cancelled-before-admission", 4)
        .await
        .get("error")
        .is_some());
    assert_eq!(fixture.lock().unwrap().inputs.len(), calls);
}
