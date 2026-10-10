//! How the Codex task reaches `codex exec`: on stdin when the host can send
//! it, otherwise as the last argument. A task that a transport cannot carry
//! intact is refused before any process is requested, as a definite failure.
use crate::error::invalid;
use std::path::Path;
use te_image_generation_contract::SafeError;

/// `codex exec` reads its prompt from stdin when the prompt argument is `-`.
pub(super) const STDIN_PROMPT: &str = "-";
/// cmd.exe truncates command lines beyond 8191 characters; batch launchers
/// (npm's `codex.cmd`) run through it.
const CMD_LIMIT: usize = 8191;
/// CreateProcess's command-line limit, for native executables.
const CREATE_PROCESS_LIMIT: usize = 32767;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PromptTransport {
    /// Pass `-` as the prompt argument and send the task on stdin.
    Stdin,
    /// Pass the task itself as the prompt argument.
    Argv,
}

/// Choose the transport for `task`, given the host's stdin bound (`None` when
/// it cannot send stdin) and the rest of the command line.
pub(super) fn prompt_transport(
    task: &str,
    stdin_bound: Option<usize>,
    windows: bool,
    program: &Path,
    args: &[String],
) -> Result<PromptTransport, SafeError> {
    if let Some(bound) = stdin_bound {
        return if task.len() <= bound {
            Ok(PromptTransport::Stdin)
        } else {
            Err(invalid(
                "The Codex image task is larger than the host can send on stdin",
            ))
        };
    }
    if windows {
        let batch = program
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            });
        let limit = if batch {
            CMD_LIMIT
        } else {
            CREATE_PROCESS_LIMIT
        };
        let all = args.iter().map(String::as_str).chain([task]);
        if windows_command_line_units(program, all, batch) > limit {
            return Err(invalid(
                "This prompt is too long to pass to Codex on Windows with this version of Tauri Explorer; shorten it or update Tauri Explorer",
            ));
        }
    }
    Ok(PromptTransport::Argv)
}

/// Upper bound, in UTF-16 units, of the command line Windows builds for
/// `program args`: every argument quoted, quotes and backslashes escaped, and
/// for batch files the `cmd.exe /c` wrapper plus `%` escaping.
fn windows_command_line_units<'a>(
    program: &Path,
    args: impl Iterator<Item = &'a str>,
    batch: bool,
) -> usize {
    let cost = |text: &str| -> usize {
        text.encode_utf16()
            .map(|unit| match char::from_u32(u32::from(unit)) {
                Some('"' | '\\') => 2,
                Some('%') if batch => 8,
                _ => 1,
            })
            .sum::<usize>()
            + 3
    };
    let wrapper = if batch { 32 } else { 0 };
    wrapper + cost(&program.to_string_lossy()) + args.map(cost).sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Vec<String> {
        ["exec", "--json", "--"].map(String::from).to_vec()
    }

    #[test]
    fn stdin_is_used_whenever_the_host_supports_it_and_the_task_fits() {
        let long = "x".repeat(20_000);
        for windows in [false, true] {
            assert_eq!(
                prompt_transport(
                    &long,
                    Some(256 * 1024),
                    windows,
                    Path::new("C:\\npm\\codex.cmd"),
                    &args()
                ),
                Ok(PromptTransport::Stdin)
            );
        }
        let refused =
            prompt_transport(&long, Some(10_000), false, Path::new("/bin/codex"), &args())
                .unwrap_err();
        assert_eq!(refused.code, "invalid_request");
    }

    #[test]
    fn argv_is_kept_without_host_stdin_where_it_fits() {
        let long = "x".repeat(100_000);
        // Unix argv has no cmd.exe limit.
        assert_eq!(
            prompt_transport(&long, None, false, Path::new("/usr/bin/codex"), &args()),
            Ok(PromptTransport::Argv)
        );
        assert_eq!(
            prompt_transport(
                "Draw a bird",
                None,
                true,
                Path::new("C:\\npm\\codex.cmd"),
                &args()
            ),
            Ok(PromptTransport::Argv)
        );
    }

    #[test]
    fn windows_refuses_an_argv_task_the_launcher_would_truncate() {
        let launcher = Path::new("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.CMD");
        let over = "x".repeat(CMD_LIMIT);
        let refused = prompt_transport(&over, None, true, launcher, &args()).unwrap_err();
        assert_eq!(refused.code, "invalid_request");
        // Escaping counts: few characters, many cmd.exe units.
        let percent = "%".repeat(CMD_LIMIT / 8);
        assert!(percent.len() < CMD_LIMIT);
        assert!(prompt_transport(&percent, None, true, launcher, &args()).is_err());
        // A native executable has the larger CreateProcess limit.
        let native = Path::new("C:\\codex\\codex.exe");
        assert_eq!(
            prompt_transport(&over, None, true, native, &args()),
            Ok(PromptTransport::Argv)
        );
        assert!(prompt_transport(
            &"x".repeat(CREATE_PROCESS_LIMIT),
            None,
            true,
            native,
            &args()
        )
        .is_err());
        // The same task is fine off Windows and with host stdin.
        assert!(prompt_transport(&over, None, false, launcher, &args()).is_ok());
        assert_eq!(
            prompt_transport(&over, Some(256 * 1024), true, launcher, &args()),
            Ok(PromptTransport::Stdin)
        );
    }
}
