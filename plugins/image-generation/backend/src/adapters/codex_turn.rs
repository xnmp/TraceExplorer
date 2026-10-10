//! What one `codex exec --json` turn says about an image job, and how a turn
//! that saved no image is explained to the user.
//!
//! Schema (Codex CLI 0.160, `codex-rs/exec/src/exec_events.rs`): one JSON
//! object per line, tagged by `type`: `thread.started {thread_id}`,
//! `turn.started`, `turn.completed {usage}`, `turn.failed {error:{message}}`,
//! `item.started|item.updated|item.completed {item:{id,type,…}}` and
//! `error {message}`. Item types are `agent_message {text}`, `reasoning`,
//! `command_execution`, `file_change`, `mcp_tool_call`, `collab_tool_call`,
//! `web_search`, `todo_list` and `error {message}` (CLI warnings).
//!
//! The image tool is not in that list: exec drops image-generation items from
//! its JSON output, and a failed image call is reported only to the model,
//! which usually relays it in its reply. So the stream cannot say whether the
//! tool ran. The one direct evidence of a successful call is the thread's
//! `generated_images/<thread>` folder, which Codex creates only when it saves
//! an image; `Failure` combines the two.
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnStatus {
    Completed,
    Failed,
    /// The stream ended before `turn.completed` or `turn.failed`.
    Unfinished,
}

/// The protocol facts of one turn. `reply` is the last agent message and
/// `error` the last reported error; neither is ever parsed for paths.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Turn {
    pub thread_id: Option<String>,
    pub status: TurnStatus,
    pub usage: Value,
    pub reply: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StreamError {
    /// A complete line is not a JSON event.
    Malformed,
    InvalidThread,
    MultipleThreads,
}

impl StreamError {
    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Malformed => {
                "Codex returned an unreadable event stream. Check that the Codex CLI is up to date"
            }
            Self::InvalidThread => "Invalid Codex thread identity",
            Self::MultipleThreads => "Multiple Codex threads returned for one image job",
        }
    }
}

pub(super) fn valid_thread_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

/// Reads the CLI protocol. A final line without a newline that is not JSON is
/// a cut-off stream (the turn is then `Unfinished`), not a malformed one.
pub(super) fn read_turn(bytes: &[u8]) -> Result<Turn, StreamError> {
    let mut turn = Turn {
        thread_id: None,
        status: TurnStatus::Unfinished,
        usage: Value::Object(Default::default()),
        reply: None,
        error: None,
    };
    // `turn.failed`'s error is the reason; otherwise the last error event that
    // is not a retry notice.
    let mut failure: Option<String> = None;
    let mut last_error: Option<String> = None;
    let lines: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
    let last = lines.len() - 1;
    for (index, line) in lines.into_iter().enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let event: Value = match serde_json::from_slice(line) {
            Ok(event) => event,
            Err(_) if index == last => break,
            Err(_) => return Err(StreamError::Malformed),
        };
        let text = |value: &Value| value.as_str().map(str::to_owned);
        match event.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                let id = event
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_thread_id(id))
                    .ok_or(StreamError::InvalidThread)?;
                if turn.thread_id.replace(id.to_owned()).is_some() {
                    return Err(StreamError::MultipleThreads);
                }
            }
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                turn.reply = text(&event["item"]["text"]);
            }
            Some("error") => {
                if let Some(message) =
                    text(&event["message"]).filter(|message| !retry_notice(message))
                {
                    last_error = Some(message);
                }
            }
            Some("turn.failed") => {
                turn.status = TurnStatus::Failed;
                failure = text(&event["error"]["message"])
                    .filter(|message| !retry_notice(message))
                    .or(failure);
            }
            Some("turn.completed") if turn.status != TurnStatus::Failed => {
                turn.status = TurnStatus::Completed;
                turn.usage = usage(&event["usage"]);
            }
            _ => {}
        }
    }
    turn.error = failure.or(last_error);
    Ok(turn)
}

/// Codex reports each transient stream retry ("Reconnecting... 2/5", or
/// "Reconnecting... waiting for network") as a top-level `error` event: it
/// emits stream errors as errors whether or not it will retry, and drops that
/// flag from `--json` output. They are progress, not the reason a turn failed.
fn retry_notice(message: &str) -> bool {
    let message = message.trim_start();
    message.starts_with("Reconnecting...") || message.starts_with("Reconnecting\u{2026}")
}

/// Only numeric token counts; anything else in `usage` is dropped.
fn usage(value: &Value) -> Value {
    let mut usage = serde_json::Map::new();
    for key in [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
    ] {
        if let Some(count) = value.get(key).and_then(Value::as_u64) {
            usage.insert(key.into(), count.into());
        }
    }
    Value::Object(usage)
}
