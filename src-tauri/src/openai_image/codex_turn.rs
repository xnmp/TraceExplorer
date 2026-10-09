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
use serde_json::{json, Value};

/// Longest reply or error excerpt kept in a failed run's details, in bytes.
pub(super) const RECORDED_TEXT_BYTES: usize = 2048;
/// Longest reply or error excerpt shown in a job's error message, in characters.
pub(super) const MESSAGE_TEXT_CHARS: usize = 300;

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

/// Why a Codex image job ended without an image.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Failure {
    /// Codex reported the turn as failed.
    TurnFailed { error: Option<String> },
    /// The event stream ended before the turn finished.
    Unfinished {
        error: Option<String>,
        reply: Option<String>,
    },
    /// The turn completed but saved no image: the model answered in text
    /// (a refusal or a question), or the image tool failed and it said so.
    NoImage {
        reply: Option<String>,
        error: Option<String>,
    },
    /// Codex saved output for the thread, but it holds no PNG.
    OutputMissing { thread_id: String },
}

impl Failure {
    /// The failure a turn that did not complete describes, if it describes one.
    pub(super) fn of_turn(turn: &Turn) -> Option<Self> {
        match turn.status {
            TurnStatus::Completed => None,
            TurnStatus::Failed => Some(Self::TurnFailed {
                error: turn.error.clone(),
            }),
            TurnStatus::Unfinished => Some(Self::Unfinished {
                error: turn.error.clone(),
                reply: turn.reply.clone(),
            }),
        }
    }

    pub(super) fn no_image(turn: &Turn) -> Self {
        Self::NoImage {
            reply: turn.reply.clone(),
            error: turn.error.clone(),
        }
    }

    /// The job error shown in the Image generation panel: one bounded line.
    pub(super) fn message(&self) -> String {
        let quoted = |text: &str| format!("“{}”", excerpt(text, MESSAGE_TEXT_CHARS));
        let error =
            |text: &Option<String>| present(text).map(|text| excerpt(text, MESSAGE_TEXT_CHARS));
        match self {
            Self::TurnFailed { error: message } => match error(message) {
                Some(message) => format!("Codex reported an error: {message}"),
                None => "Codex reported that the image turn failed, without a reason".into(),
            },
            Self::Unfinished { error: message, reply } => match (error(message), present(reply)) {
                (Some(message), _) => format!("Codex stopped before finishing: {message}"),
                (None, Some(reply)) => format!("Codex stopped before finishing. Its last reply: {}", quoted(reply)),
                (None, None) => "Codex stopped before finishing its image turn".into(),
            },
            Self::NoImage { reply, error: message } => match (present(reply), error(message)) {
                (Some(reply), _) => format!("Codex replied without generating an image: {}", quoted(reply)),
                (None, Some(message)) => format!("Codex finished without generating an image. It reported: {message}"),
                (None, None) => "Codex finished without generating an image and gave no reply".into(),
            },
            Self::OutputMissing { thread_id } => format!(
                "Codex's image tool ran for thread {thread_id}, but no PNG was found in its output folder"
            ),
        }
    }

    /// Fields merged into the failed run's details. Only the final agent
    /// message and the reported error are kept, each bounded; reasoning and
    /// inputs never are.
    pub(super) fn record(&self) -> Value {
        let mut record = serde_json::Map::new();
        let (stage, reply, error) = match self {
            Self::TurnFailed { error } => ("turn_failed", None, error.as_deref()),
            Self::Unfinished { error, reply } => {
                ("turn_unfinished", reply.as_deref(), error.as_deref())
            }
            Self::NoImage { reply, error } => ("no_image", reply.as_deref(), error.as_deref()),
            Self::OutputMissing { .. } => ("image_missing", None, None),
        };
        record.insert("stage".into(), stage.into());
        for (key, text) in [("codex_reply", reply), ("codex_error", error)] {
            if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                let (kept, truncated) = bounded(text, RECORDED_TEXT_BYTES);
                record.insert(key.into(), json!({"text": kept, "truncated": truncated}));
            }
        }
        Value::Object(record)
    }
}

fn present(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|text| !text.trim().is_empty())
}

/// Drops control characters other than newlines and tabs.
fn printable(text: &str) -> impl Iterator<Item = char> + '_ {
    text.chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
}

/// At most `limit` bytes of `text`, cut at a character boundary.
pub(super) fn bounded(text: &str, limit: usize) -> (String, bool) {
    let mut kept = String::new();
    let mut truncated = false;
    for character in printable(text) {
        if kept.len() + character.len_utf8() > limit {
            truncated = true;
            break;
        }
        kept.push(character);
    }
    (kept, truncated)
}

/// One line of at most `limit` characters, whitespace collapsed, with an
/// ellipsis when cut.
pub(super) fn excerpt(text: &str, limit: usize) -> String {
    let line = printable(text)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let kept: String = line.chars().take(limit).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
#[path = "../../test_support/codex_turn.rs"]
mod tests;
