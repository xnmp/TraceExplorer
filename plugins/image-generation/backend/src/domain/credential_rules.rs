//! Pure command and key policy; no execution or credential lookup.
use crate::error::{invalid, Result};

pub const MAX_STDOUT: usize = 64 * 1024;

pub fn validate_argv(argv: &[String]) -> Result<()> {
    if !(1..=32).contains(&argv.len())
        || argv
            .iter()
            .any(|arg| arg.is_empty() || arg.len() > 4096 || arg.chars().any(char::is_control))
    {
        return Err(invalid("Credential command needs 1–32 nonempty arguments, each at most 4096 bytes without control characters"));
    }
    let program = &argv[0];
    if !std::path::Path::new(program).is_absolute()
        && (program.contains('/')
            || program.contains('\\')
            || program.contains(':')
            || !matches!(
                std::path::Path::new(program)
                    .components()
                    .collect::<Vec<_>>()
                    .as_slice(),
                [std::path::Component::Normal(_)]
            ))
    {
        return Err(invalid(
            "Credential command must use an absolute executable path or a bare program name",
        ));
    }
    Ok(())
}

pub fn usable_key(key: &str) -> bool {
    !key.trim().is_empty() && key.len() <= 4096 && !key.chars().any(char::is_control)
}

/// Strip exactly one line ending, without trimming any other key bytes.
pub fn command_key(stdout: &[u8]) -> Option<String> {
    if stdout.len() > MAX_STDOUT {
        return None;
    }
    let key = std::str::from_utf8(stdout).ok()?;
    let key = key
        .strip_suffix("\r\n")
        .or_else(|| key.strip_suffix('\n'))
        .unwrap_or(key);
    usable_key(key).then(|| key.to_owned())
}

/// Windows implicitly invokes cmd.exe for batch targets, including names with
/// trailing spaces/dots normalized by the Windows filesystem.
pub fn implicit_windows_shell(program: &str) -> bool {
    let normalized = program.trim_end_matches([' ', '.']).to_ascii_lowercase();
    normalized.ends_with(".bat") || normalized.ends_with(".cmd")
}
