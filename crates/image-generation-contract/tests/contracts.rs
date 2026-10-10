use serde_json::json;
use te_image_generation_contract::*;

fn recipe() -> EffectiveRecipe {
    serde_json::from_value(json!({"schemaVersion":1,"formatterVersion":1,"connectionId":"fixture","connectionRevision":"recipe-1","adapter":"openai-images","endpointIdentity":"https://fixture.test/v1/images","model":"custom-image","options":{"size":"1024x1024","resolution":null,"aspectRatio":null,"quality":"auto","background":"transparent"},"inputDigests":["a".repeat(64),"b".repeat(64)],"inputRoles":["Base image","Reference 1"],"submittedPrompt":"A snowman ☃\nwith \"blue\" eyes","agentTask":null})).unwrap()
}

#[test]
fn canonical_recipe_has_an_independent_utf8_golden_digest_and_keeps_input_order() {
    let value=recipe();
    // Independently computed from the specified UTF8 JSON field order using
    // Python json.dumps(ensure_ascii=False,separators=(',',':')) + SHA256.
    assert_eq!(value.digest(),"d54dd615b379df0098cb6cc00509d60cf624eca3c03a59bddd33dacf6169aaaa");
    let mut keys:Vec<_>=serde_json::to_value(&value).unwrap().as_object().unwrap().iter().map(|(k,v)|(k.clone(),v.clone())).collect();keys.reverse();
    let reordered:EffectiveRecipe=serde_json::from_value(serde_json::Value::Object(keys.into_iter().collect())).unwrap();assert_eq!(reordered.digest(),value.digest());
    let mut changed=value.clone();changed.input_digests.reverse();assert_ne!(changed.digest(),value.digest());
    changed=value.clone();changed.model=Some("a-new-model".into());assert_ne!(changed.digest(),value.digest());
}

#[test]
fn receipt_variants_reject_unknown_fields_instead_of_discarding_new_evidence() {
    for value in [json!({"state":"running","secret":"unrecognized"}),json!({"state":"unknown","error":{"code":"interrupted","message":"Unconfirmed","correlationId":null},"futureOutcome":true})] {
        assert!(serde_json::from_value::<Execution>(value).is_err());
    }
    for value in [json!({"state":"none","output":"unrecognized"}),json!({"state":"unavailable","reason":"missing","futureOutput":true})] {
        assert!(serde_json::from_value::<Delivery>(value).is_err());
    }
    assert!(serde_json::from_value::<Execution>(json!({"state":"running"})).is_ok());
    assert!(serde_json::from_value::<Delivery>(json!({"state":"unavailable","reason":"missing"})).is_ok());
}

#[test]
fn image_options_enforce_advertised_geometry_without_overflow_on_malformed_sizes() {
    for (size,allowed) in [("auto",true),("1024x1024",true),("3840x2160",true),("0x1024",false),("3841x2160",false),("1024x1025",false),("64x64",false),("3840x3840",false),("3072x512",false),("18446744073709551615x18446744073709551615",false),("9999999999999999999999999x1024",false),("1024X1024",false)] {
        let mut options=recipe().options;options.size=size.into();assert_eq!(options.valid(),allowed,"{size}");
    }
}

#[test]
fn successful_diagnostics_reject_transcripts_and_failed_excerpts_respect_utf8_bytes() {
    let mut value=OperationDiagnostics::CodexImageTurn{thread_id:"550e8400-e29b-41d4-a716-446655440000".into(),turn_state:CodexTurnState::Failed,usage:None,explanation:Some(FailedExplanation{kind:ExplanationKind::Reply,text:"雪".repeat(1365),truncated:true})};
    assert!(value.valid(false));assert!(!value.valid(true));
    {let OperationDiagnostics::CodexImageTurn{explanation,..}=&mut value;explanation.as_mut().unwrap().text.push('雪');}
    assert!(!value.valid(false));
    {let OperationDiagnostics::CodexImageTurn{explanation,..}=&mut value;*explanation=None;}
    assert!(value.valid(true));
}

#[test]
fn operation_identity_is_bounded_ascii_and_does_not_accept_paths_or_empty_ids() {
    assert!(valid_operation_id(&"a".repeat(128)));assert!(!valid_operation_id(&"a".repeat(129)));
    for id in ["","../other","folder/file","C:\\path","雪","with space","line\nfeed"] {assert!(!valid_operation_id(id));}
}
