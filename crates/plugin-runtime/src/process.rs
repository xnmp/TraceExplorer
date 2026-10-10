//! Typed `host.process.run` request and the host's process capabilities.
//! The wire shape matches the host's `installed_plugins/process_run.rs`
//! exactly; the contract is in integration/README.md ("Owned processes").
use serde_json::{json, Value};

/// Initialization capability for bounded stdin: `{version: 1, maxBytes}`.
pub const STDIN_CAPABILITY: &str = "processStdin";

/// The stdin byte bound advertised in `initialize` params, or `None` when the
/// host cannot take stdin. Detected by capability, never by host version.
pub fn stdin_bound(initialize: &Value) -> Option<usize> {
    let capability = &initialize[STDIN_CAPABILITY];
    if capability["version"] != 1 {
        return None;
    }
    capability["maxBytes"]
        .as_u64()
        .and_then(|bytes| usize::try_from(bytes).ok())
        .filter(|bytes| *bytes > 0)
}

/// Whether a `host.process.run` error code proves the program never ran.
/// Hosts without typed refusals report them as `service_unavailable`, which
/// stays uncertain, as do `interrupted` and every other code.
pub fn proves_not_started(code: &str) -> bool {
    matches!(
        code,
        "invalid_request" | "capacity_reached" | "not_found" | "permission_denied" | "not_started"
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRequest {
    /// Absolute executable path.
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// `(name, Some(value))` sets a variable, `(name, None)` removes it.
    pub env: Vec<(String, Option<String>)>,
    pub stdout_limit: usize,
    pub stderr_limit: usize,
    /// Written to the child's stdin, which is then closed; requires the
    /// `processStdin` capability and at most its `maxBytes` UTF-8 bytes.
    pub stdin: Option<String>,
}

impl ProcessRequest {
    /// Wire params. `stdin` is omitted when absent, so hosts that predate it
    /// (and refuse unknown fields) still accept every request without it.
    pub fn params(&self) -> Value {
        let mut params = json!({
            "program": self.program,
            "args": self.args,
            "cwd": self.cwd,
            "env": self.env,
            "stdoutLimit": self.stdout_limit,
            "stderrLimit": self.stderr_limit,
        });
        if let Some(stdin) = &self.stdin {
            params["stdin"] = json!(stdin);
        }
        params
    }

    /// Whether the encoded request, with its JSON-RPC envelope, fits the
    /// reverse-request frame. A request that does not is never sent.
    pub fn fits_frame(&self) -> bool {
        serde_json::to_vec(&self.params()).is_ok_and(|bytes| {
            bytes.len() + crate::rpc::ENVELOPE_BYTES <= crate::rpc::MAX_FRAME_BYTES
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(stdin: Option<String>) -> ProcessRequest {
        ProcessRequest {
            program: "/usr/bin/codex".into(),
            args: vec!["exec".into(), "-".into()],
            cwd: Some("/tmp/work".into()),
            env: vec![
                ("PATH".into(), Some("/usr/bin".into())),
                ("CODEX_API_KEY".into(), None),
            ],
            stdout_limit: 1024,
            stderr_limit: 64,
            stdin,
        }
    }

    #[test]
    fn params_match_the_host_shape_and_omit_absent_stdin() {
        let legacy = request(None).params();
        assert_eq!(
            legacy,
            json!({"program":"/usr/bin/codex","args":["exec","-"],"cwd":"/tmp/work","env":[["PATH","/usr/bin"],["CODEX_API_KEY",null]],"stdoutLimit":1024,"stderrLimit":64})
        );
        assert!(
            legacy.get("stdin").is_none(),
            "an old host would refuse the field"
        );
        assert_eq!(request(Some("task".into())).params()["stdin"], "task");
    }

    #[test]
    fn stdin_support_is_read_from_the_initialize_capability() {
        assert_eq!(
            stdin_bound(
                &json!({"processService":true,"processStdin":{"version":1,"maxBytes":262144}})
            ),
            Some(262144)
        );
        for absent in [
            json!({"processService":true}),
            json!({"processStdin":true}),
            json!({"processStdin":{"version":2,"maxBytes":262144}}),
            json!({"processStdin":{"version":1}}),
            json!({"processStdin":{"version":1,"maxBytes":0}}),
            json!({"processStdin":{"version":1,"maxBytes":-1}}),
            Value::Null,
        ] {
            assert_eq!(stdin_bound(&absent), None, "{absent}");
        }
    }

    #[test]
    fn only_typed_pre_spawn_refusals_prove_non_execution() {
        for code in [
            "invalid_request",
            "capacity_reached",
            "not_found",
            "permission_denied",
            "not_started",
        ] {
            assert!(proves_not_started(code), "{code}");
        }
        for code in [
            "service_unavailable",
            "interrupted",
            "protocol_error",
            "host_unavailable",
            "storage_unavailable",
            "",
        ] {
            assert!(!proves_not_started(code), "{code}");
        }
    }

    #[test]
    fn a_request_that_cannot_fit_the_frame_is_detected_before_sending() {
        assert!(request(Some("x".repeat(256 * 1024))).fits_frame());
        // Control characters escape to six bytes each.
        assert!(!request(Some("\u{1}".repeat(200 * 1024))).fits_frame());
    }
}
