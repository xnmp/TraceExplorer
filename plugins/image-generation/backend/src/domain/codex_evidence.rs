//! Pure, bounded facts about one CLI turn. Successful transcripts never enter receipts.
use serde_json::Value;
use te_image_generation_contract::{
    CodexTurnState, ExplanationKind, FailedExplanation, OperationDiagnostics, SafeError, TokenUsage,
};
const MAX_TEXT: usize = 4096;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn turn(thread_id: String, state: CodexTurnState, usage: &Value) -> OperationDiagnostics {
    let count = |key: &str| {
        usage[key]
            .as_u64()
            .filter(|count| *count <= MAX_SAFE_INTEGER)
    };
    let usage = TokenUsage {
        input_tokens: count("input_tokens"),
        cached_input_tokens: count("cached_input_tokens"),
        output_tokens: count("output_tokens"),
    };
    OperationDiagnostics::CodexImageTurn {
        thread_id,
        turn_state: state,
        usage: [
            usage.input_tokens,
            usage.cached_input_tokens,
            usage.output_tokens,
        ]
        .iter()
        .any(Option::is_some)
        .then_some(usage),
        explanation: None,
    }
}
fn bounded(text: &str, limit: usize) -> (String, bool) {
    let mut kept = String::new();
    for character in text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
    {
        if kept.len() + character.len_utf8() > limit {
            return (kept, true);
        }
        kept.push(character);
    }
    (kept, false)
}
/// Prefer a reported error; otherwise retain the last bounded refusal/reply.
pub fn failure(
    mut receipt: OperationDiagnostics,
    reply: Option<&str>,
    error: Option<&str>,
) -> OperationDiagnostics {
    let selected = error
        .filter(|s| !s.trim().is_empty())
        .map(|s| (ExplanationKind::Error, s))
        .or_else(|| {
            reply
                .filter(|s| !s.trim().is_empty())
                .map(|s| (ExplanationKind::Reply, s))
        });
    if let Some((kind, text)) = selected {
        let (text, truncated) = bounded(text, MAX_TEXT);
        if !text.trim().is_empty() {
            let OperationDiagnostics::CodexImageTurn { explanation, .. } = &mut receipt;
            *explanation = Some(FailedExplanation {
                kind,
                text,
                truncated,
            });
        }
    }
    receipt
}
/// A short single-line explanation also works in settings' generic error presentation.
pub fn error_message(mut failure: SafeError, receipt: &OperationDiagnostics) -> SafeError {
    let OperationDiagnostics::CodexImageTurn { explanation, .. } = receipt;
    if let Some(explanation) = explanation {
        let line = explanation
            .text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let (excerpt, cut) = bounded(&line, 512);
        failure.message = format!(
            "{} Codex {}: {}{}",
            failure.message,
            if explanation.kind == ExplanationKind::Error {
                "error"
            } else {
                "reply"
            },
            excerpt,
            if cut || explanation.truncated {
                "…"
            } else {
                ""
            }
        );
    }
    failure
}
pub fn same_turn(before: &OperationDiagnostics, after: &OperationDiagnostics) -> bool {
    let mut before = before.clone();
    let mut after = after.clone();
    let OperationDiagnostics::CodexImageTurn { explanation, .. } = &mut before;
    *explanation = None;
    let OperationDiagnostics::CodexImageTurn { explanation, .. } = &mut after;
    *explanation = None;
    before == after
}
