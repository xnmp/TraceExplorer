#![cfg(unix)]
use image_generation_backend::{
    credential_command::{resolve_on_path, run},
    domain::credential_rules::command_key,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

fn script(body: &str) -> (tempfile::TempDir, Vec<String>) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("credential-helper");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    // An explicit interpreter reads the test script instead of executing a
    // freshly written file (which can produce ETXTBSY in parallel tests).
    (
        directory,
        vec!["/bin/sh".into(), path.to_str().unwrap().into()],
    )
}
fn execute(body: &str) -> image_generation_backend::error::Result<String> {
    let (_directory, argv) = script(body);
    run(&argv, &AtomicBool::new(false), Duration::from_secs(3))
}
#[test]
fn strips_one_line_ending_and_preserves_other_bytes() {
    assert_eq!(
        execute("printf ' key with spaces \\n'").unwrap(),
        " key with spaces "
    );
    assert_eq!(execute("printf 'key\\r\\n'").unwrap(), "key");
    assert_eq!(execute("printf 'key'").unwrap(), "key");
    assert_eq!(command_key(b"key\n\n"), None);
    assert_eq!(command_key(b"key\r"), None);
    assert_eq!(command_key(&[0xff]), None);
}
#[test]
fn rejects_empty_multiline_control_and_oversized_keys() {
    for body in [
        "printf ''",
        "printf '   \\n'",
        "printf 'key\\nsecond\\n'",
        "printf 'key\\n\\n'",
        "printf 'key\\t'",
        "printf '%4097s' x",
    ] {
        let failure = execute(body).unwrap_err();
        assert_eq!(failure.code, "unavailable");
        assert_eq!(failure.message, "Credential command printed no usable key");
    }
}
#[test]
fn exit_status_never_discloses_stdout_or_stderr() {
    let failure =
        execute("printf 'sk-stdout-canary'; printf 'sk-stderr-canary' >&2; exit 23").unwrap_err();
    assert_eq!(failure.code, "unavailable");
    assert_eq!(failure.message, "Credential command exited with status 23");
    let rendered = serde_json::to_string(&failure).unwrap();
    assert!(!rendered.contains("sk-stdout-canary"));
    assert!(!rendered.contains("sk-stderr-canary"));
}
#[test]
fn stdout_limit_is_enforced_while_the_child_is_running() {
    let failure = execute("printf '%65537s' x; exec sleep 5").unwrap_err();
    assert_eq!(failure.message, "Credential command printed no usable key");
}
#[test]
fn missing_program_has_a_fixed_start_failure() {
    let directory = tempfile::tempdir().unwrap();
    let argv = vec![directory.path().join("missing").to_str().unwrap().into()];
    let failure = run(&argv, &AtomicBool::new(false), Duration::from_secs(1)).unwrap_err();
    assert_eq!(failure.code, "unavailable");
    assert_eq!(failure.message, "Credential command could not start");
}
#[test]
fn timeout_kills_and_reaps_the_process() {
    let (directory, mut argv) = script("printf '%s' $$ > \"$1\"; exec sleep 5");
    let pid_file = directory.path().join("pid");
    argv.push(pid_file.to_str().unwrap().into());
    let started = Instant::now();
    let worker =
        std::thread::spawn(move || run(&argv, &AtomicBool::new(false), Duration::from_secs(2)));
    let readiness = Instant::now() + Duration::from_secs(1);
    while !pid_file.exists() && Instant::now() < readiness {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        pid_file.exists(),
        "helper did not signal readiness before its timeout"
    );
    let failure = worker.join().unwrap().unwrap_err();
    assert_eq!(failure.message, "Credential command timed out");
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
#[test]
fn cancellation_interrupts_a_running_helper() {
    let (_directory, argv) = script("exec sleep 5");
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            cancel.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let failure = run(&argv, &cancel, Duration::from_secs(3)).unwrap_err();
        assert_eq!(failure.message, "Credential command was cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
    });
}
#[test]
fn arguments_are_literal_and_the_environment_is_inherited() {
    let (_directory, mut argv) = script("test -n \"$PATH\" || exit 9; printf '%s' \"$1\"");
    argv.push("$HOME * ~ $(whoami) ; literal".into());
    assert_eq!(
        run(&argv, &AtomicBool::new(false), Duration::from_secs(1)).unwrap(),
        "$HOME * ~ $(whoami) ; literal"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn timeout_kills_a_descendant_retaining_stdout_after_the_leader_exits() {
    let (directory, mut argv) =
        script("sleep 5 &\nprintf '%s' $! > \"$1\"\nprintf 'key\\n'\nexit 0");
    let pid_file = directory.path().join("descendant-pid");
    argv.push(pid_file.to_str().unwrap().into());
    let failure = run(&argv, &AtomicBool::new(false), Duration::from_secs(2)).unwrap_err();
    assert_eq!(failure.message, "Credential command timed out");
    let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    // Orphan reaping belongs to the OS; a zombie is terminated, not running.
    for _ in 0..100 {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Ok(stat) if stat.rsplit_once(") ").unwrap().1.starts_with('Z') => return,
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    panic!("Timed-out credential descendant is still running");
}

#[test]
fn bare_program_names_resolve_on_path_and_receive_literal_arguments() {
    let argv = vec!["printf".into(), "%s".into(), "$HOME * ~ ; literal".into()];
    assert_eq!(
        run(&argv, &AtomicBool::new(false), Duration::from_secs(1)).unwrap(),
        "$HOME * ~ ; literal"
    );
}

#[test]
fn path_lookup_is_ordered_and_relative_entries_use_the_supplied_cwd() {
    let cwd = std::path::Path::new("/work");
    let path = std::ffi::OsStr::new("/first:/second");
    assert_eq!(
        resolve_on_path("helper", Some(path), cwd, |_| true),
        Some("/first/helper".into())
    );
    assert_eq!(
        resolve_on_path("helper", Some(path), cwd, |p| p
            == std::path::Path::new("/second/helper")),
        Some("/second/helper".into())
    );
    assert_eq!(resolve_on_path("helper", Some(path), cwd, |_| false), None);
    assert_eq!(resolve_on_path("helper", None, cwd, |_| true), None);
    assert_eq!(
        resolve_on_path(
            "helper",
            Some(std::ffi::OsStr::new("relative:")),
            cwd,
            |_| true
        ),
        Some("/work/relative/helper".into())
    );
    assert_eq!(
        resolve_on_path("helper", Some(std::ffi::OsStr::new("")), cwd, |_| true),
        Some("/work/helper".into())
    );
}
