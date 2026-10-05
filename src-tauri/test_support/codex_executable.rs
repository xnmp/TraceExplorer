use super::*;

fn environment(bins: &[&Path], fallback_bins: Vec<PathBuf>) -> Environment {
    Environment {
        path: std::env::join_paths(bins).unwrap(),
        fallback_bins,
    }
}

fn install(bin: &Path) -> PathBuf {
    std::fs::create_dir_all(bin).unwrap();
    let program = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::write(&program, b"fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    program
}

#[test]
fn inherited_path_wins_over_fallback_installations() {
    let dir = tempfile::tempdir().unwrap();
    let primary = dir.path().join("primary");
    let fallback = dir.path().join("fallback");
    let expected = install(&primary);
    install(&fallback);
    assert_eq!(
        resolve_in("", &environment(&[&primary], vec![fallback]))
            .unwrap()
            .program,
        expected
    );
}

#[test]
fn desktop_environment_finds_newest_installed_nvm_cli_without_shell_startup() {
    let root = tempfile::tempdir().unwrap();
    install(&root.path().join("versions/node/v9.8.0/bin"));
    let newest = install(&root.path().join("versions/node/v25.6.0/bin"));
    install(&root.path().join("versions/node/v25.5.99/bin"));
    // Unrecognized directory names cannot become implicit CLI installations.
    install(&root.path().join("versions/node/not-a-version/bin"));
    let desktop = environment(&[], nvm_bins(root.path()));
    assert_eq!(resolve_in("", &desktop).unwrap().program, newest);
}

#[test]
fn configured_path_takes_priority_and_accepts_spaces() {
    let dir = tempfile::tempdir().unwrap();
    let expected = install(&dir.path().join("custom installation"));
    let other = dir.path().join("path");
    install(&other);
    let resolved = resolve_in(expected.to_str().unwrap(), &environment(&[&other], vec![])).unwrap();
    assert_eq!(resolved.program, expected);
}

#[test]
fn invalid_configured_path_is_not_silently_replaced_by_another_installation() {
    let dir = tempfile::tempdir().unwrap();
    install(dir.path());
    let env = environment(&[dir.path()], vec![]);
    for configured in [
        "codex",
        "~/bin/codex",
        "codex --exec",
        "\0",
        &"x".repeat(8193),
    ] {
        assert!(resolve_in(configured, &env).is_err());
    }
    assert!(resolve_in(dir.path().join("missing").to_str().unwrap(), &env).is_err());
    assert!(resolve_in(dir.path().to_str().unwrap(), &env).is_err());
}

#[test]
fn missing_installation_provides_the_setting_and_terminal_diagnostic() {
    let dir = tempfile::tempdir().unwrap();
    let error = resolve_in("", &environment(&[dir.path()], vec![]))
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("Codex executable path"));
    assert!(error.contains("command -v codex"));
    assert!(nvm_bins(&dir.path().join("absent")).is_empty());
}

#[cfg(unix)]
#[test]
fn non_executable_cli_is_skipped_and_npm_symlink_retains_its_runtime_directory() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let unusable = dir.path().join("unusable");
    let blocked = install(&unusable);
    std::fs::set_permissions(blocked, std::fs::Permissions::from_mode(0o600)).unwrap();
    let bin = dir.path().join("node/bin");
    let package = dir.path().join("node/lib/node_modules/codex");
    let target = install(&package);
    std::fs::create_dir_all(&bin).unwrap();
    let launcher = bin.join("codex");
    symlink(target, &launcher).unwrap();
    let resolved = resolve_in("", &environment(&[&unusable, &bin], vec![])).unwrap();
    assert_eq!(resolved.program, launcher);
    assert_eq!(
        std::env::split_paths(&resolved.search_path).next().unwrap(),
        bin
    );
}

#[cfg(unix)]
#[test]
fn desktop_child_can_run_a_launcher_requiring_its_sibling_runtime() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let program = install(dir.path());
    let runtime = dir.path().join("codex-fixture-node");
    std::fs::write(&program, b"#!/usr/bin/env codex-fixture-node\n").unwrap();
    std::fs::write(&runtime, b"#!/bin/sh\nprintf 'codex-cli fixture\\n'\n").unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    let resolved = resolve_in("", &environment(&[], vec![dir.path().to_path_buf()])).unwrap();
    let output = std::process::Command::new(&resolved.program)
        .env("PATH", &resolved.search_path)
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"codex-cli fixture\n");
}
