use super::*;

const THREAD: &str = "01a11dad-5c1e-7f3a-9b2d-4e6f8a0c2d41";

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("test_support/fixtures/codex")
        .join(name);
    std::fs::read(path).unwrap()
}

fn stream(events: &[Value]) -> Vec<u8> {
    events
        .iter()
        .map(|event| format!("{event}\n"))
        .collect::<String>()
        .into_bytes()
}

fn reply_turn(text: &str) -> Turn {
    read_turn(&stream(&[
        json!({"type":"thread.started","thread_id":THREAD}),
        json!({"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":text}}),
        json!({"type":"turn.completed","usage":{"output_tokens":4}}),
    ]))
    .unwrap()
}

#[test]
fn a_text_only_refusal_is_quoted_from_codexs_final_reply() {
    let turn = read_turn(&fixture("refusal.jsonl")).unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(turn.thread_id.as_deref(), Some(THREAD));
    assert_eq!(
        turn.usage,
        json!({"input_tokens":27593,"cached_input_tokens":3456,"output_tokens":291,"reasoning_output_tokens":192})
    );
    let failure = Failure::no_image(&turn);
    assert_eq!(
        failure.message(),
        "Codex replied without generating an image: “I can’t make that edit: it depicts copyrighted characters (Charizard and Alakazam) in a new scene. I can make an original fire-type dragon and a psychic fox instead — want me to do that?”"
    );
    let record = failure.record();
    assert_eq!(record["stage"], "no_image");
    assert!(record["codex_reply"]["text"]
        .as_str()
        .unwrap()
        .contains("scene.\n\nI can make"));
    assert_eq!(record["codex_reply"]["truncated"], false);
    // Reasoning is never kept.
    assert!(!record.to_string().contains("Considering the request"));
}

#[test]
fn an_image_tool_error_relayed_by_the_model_is_shown_verbatim() {
    let failure = Failure::no_image(&read_turn(&fixture("tool-error.jsonl")).unwrap());
    assert_eq!(
        failure.message(),
        "Codex replied without generating an image: “Image generation failed: the image tool reported that this request was rejected by the safety system. No image was created.”"
    );
}

#[test]
fn a_successful_turn_survives_warnings_and_a_retried_stream_error() {
    let turn = read_turn(&fixture("image-saved.jsonl")).unwrap();
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(Failure::of_turn(&turn), None);
    assert_eq!(
        turn.reply.as_deref(),
        Some("Here is the edited image, saved at the default location.")
    );
}

#[test]
fn a_failed_turn_reports_codexs_error() {
    let turn = read_turn(&fixture("turn-failed.jsonl")).unwrap();
    assert_eq!(turn.status, TurnStatus::Failed);
    let failure = Failure::of_turn(&turn).unwrap();
    assert_eq!(
        failure.message(),
        "Codex reported an error: You've hit your usage limit. Try again at 4:05 PM."
    );
    assert_eq!(failure.record()["stage"], "turn_failed");
    assert_eq!(
        failure.record()["codex_error"]["text"],
        "You've hit your usage limit. Try again at 4:05 PM."
    );
    let silent = read_turn(&stream(&[
        json!({"type":"thread.started","thread_id":THREAD}),
        json!({"type":"turn.failed","error":{}}),
        json!({"type":"turn.completed","usage":{}}),
    ]))
    .unwrap();
    assert_eq!(
        silent.status,
        TurnStatus::Failed,
        "a later completion never hides a failure"
    );
    assert_eq!(
        Failure::of_turn(&silent).unwrap().message(),
        "Codex reported that the image turn failed, without a reason"
    );
}

#[test]
fn a_cut_off_stream_is_unfinished_and_keeps_the_last_reply() {
    let turn = read_turn(&fixture("truncated.jsonl")).unwrap();
    assert_eq!(turn.status, TurnStatus::Unfinished);
    assert_eq!(
        Failure::of_turn(&turn).unwrap().message(),
        "Codex stopped before finishing. Its last reply: “Working on the edit now.”"
    );
    assert_eq!(
        Failure::of_turn(&read_turn(b"").unwrap())
            .unwrap()
            .message(),
        "Codex stopped before finishing its image turn"
    );
}

#[test]
fn a_malformed_complete_line_is_a_protocol_error() {
    assert_eq!(
        read_turn(&fixture("malformed.jsonl")),
        Err(StreamError::Malformed)
    );
    assert_eq!(
        read_turn(&stream(&[
            json!({"type":"thread.started","thread_id":"../../elsewhere"})
        ])),
        Err(StreamError::InvalidThread)
    );
    assert_eq!(
        read_turn(&stream(&[
            json!({"type":"thread.started","thread_id":THREAD}),
            json!({"type":"thread.started","thread_id":THREAD}),
        ])),
        Err(StreamError::MultipleThreads)
    );
}

#[test]
fn an_empty_or_blank_reply_says_codex_gave_no_reply() {
    for text in ["", "  \n\t "] {
        let failure = Failure::no_image(&reply_turn(text));
        assert_eq!(
            failure.message(),
            "Codex finished without generating an image and gave no reply"
        );
        assert!(failure.record().get("codex_reply").is_none());
    }
    let turn = read_turn(&stream(&[
        json!({"type":"thread.started","thread_id":THREAD}),
        json!({"type":"error","message":"Reconnecting... 1/5"}),
        json!({"type":"turn.completed","usage":{}}),
    ]))
    .unwrap();
    assert_eq!(
        Failure::no_image(&turn).message(),
        "Codex finished without generating an image. It reported: Reconnecting... 1/5"
    );
}

#[test]
fn a_long_reply_is_bounded_in_the_message_and_in_the_record() {
    let reply = "word ".repeat(1000);
    let failure = Failure::no_image(&reply_turn(&reply));
    let message = failure.message();
    let quoted = message
        .strip_prefix("Codex replied without generating an image: “")
        .unwrap()
        .strip_suffix("”")
        .unwrap();
    assert!(quoted.ends_with('…'));
    assert!(quoted.chars().count() <= MESSAGE_TEXT_CHARS + 1);
    let record = failure.record();
    let kept = record["codex_reply"]["text"].as_str().unwrap();
    assert!(kept.len() <= RECORDED_TEXT_BYTES && kept.len() > RECORDED_TEXT_BYTES - 8);
    assert_eq!(record["codex_reply"]["truncated"], true);
}

#[test]
fn non_ascii_replies_are_cut_on_character_boundaries() {
    let reply = "画像を生成できません。🐉".repeat(400);
    let failure = Failure::no_image(&reply_turn(&reply));
    let message = failure.message();
    assert!(message.contains("“画像を生成できません。🐉"));
    let quoted = message.split('“').nth(1).unwrap();
    assert!(quoted.chars().count() <= MESSAGE_TEXT_CHARS + 2);
    let record = failure.record();
    let kept = record["codex_reply"]["text"].as_str().unwrap();
    assert!(kept.len() <= RECORDED_TEXT_BYTES);
    assert!(reply.starts_with(kept));
    // A single unbroken word longer than the limit is still cut.
    assert_eq!(excerpt(&"🐉".repeat(400), 5), "🐉🐉🐉🐉🐉…");
}

#[test]
fn control_characters_never_reach_the_message_or_the_record() {
    let failure = Failure::no_image(&reply_turn("No\u{1b}[31m image\u{7}\u{0} here\nsorry"));
    assert_eq!(
        failure.message(),
        "Codex replied without generating an image: “No[31m image here sorry”"
    );
    assert_eq!(
        failure.record()["codex_reply"]["text"],
        "No[31m image here\nsorry"
    );
}

#[test]
fn a_tool_success_without_a_png_names_the_thread() {
    let failure = Failure::OutputMissing {
        thread_id: THREAD.into(),
    };
    assert_eq!(
        failure.message(),
        format!(
            "Codex's image tool ran for thread {THREAD}, but no PNG was found in its output folder"
        )
    );
    assert_eq!(failure.record(), json!({"stage":"image_missing"}));
}
