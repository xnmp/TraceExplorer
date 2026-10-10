# Shared AI services — continuation status (2026-10-10, evening)

Supersedes the "first next action" in `2026-10-10-073019Z-issue-1047.md`. Nothing is merged or released.

## Done this session

### Host `/tmp/te-shared-ai-host` (feat/shared-ai-services)

| Commit | State | Change |
|---|---|---|
| `ca1f2525` | pushed | Queue/shutdown race fixed. The gated regression test fails under the old ordering. The queue worker spawns fallibly. |
| `8f2dac26` | pushed | Windows durability via `durable_dir::sync`, a writable directory-handle flush. The fail-closed gate and `unsupported_platform` availability are removed. The unwired `windows_artifact_namespace.rs`, its fixture and its CI job are removed. See `docs/shared-ai-windows-namespace-evidence.md`. |
| `da950101` | pushed | Clippy and fmt clean under Rust 1.99. Startup GC and recovery are now enabled on Windows. |
| `6126913e` | pushed | Writable Windows evidence flush (`sync_file`). `operationDeadlineAtMs` is measured from native command entry. |
| `23a756d6` | **local only** | Native Wry fixtures: publisher-only proof, and a new seeded-startup-recovery fixture. Both pass, and both fail when their guarded shutdown wait is removed. |

Push `23a756d6` once CI is idle; a new push cancels in-flight runs.

### Trace (this worktree, pushed to `7f43d46`)

- `te_plugin_runtime::durable_dir` is used by Trace and the provider.
- macOS fixture path alias fixed: macOS CI is now green.
- Windows legacy-locator test fixed.
- Write transactions default to IMMEDIATE. This fixes a real `database is locked` failure seen on aarch64.
- `ETXTBSY` exec retry.
- Provider README corrected (local commit).

## CI at host `6126913e` / Trace `7f43d46`

Logs are in `/var/tmp/te-wt/logs-*.txt`; `/var/tmp/te-wt/ci.sh <repo> <sha>` summarizes a run.

| Repo | Check | Result | Notes |
|---|---|---|---|
| Trace | All except Windows | Green | |
| Trace | Windows | 172/1 | Diagnose the single failure in `logs-twin.txt`. |
| Host | CI | Green | |
| Host | Rust platforms, Windows | 1182 pass / 18 fail | `logs-hwin.txt`, not yet diagnosed |
| Host | Rust platforms, macOS | 1570 pass / 1 fail | `logs-hmac.txt` |
| Host | Smoke, ubuntu | Fail | Possibly the known WebKitGTK flake #1026; check `logs-subu.txt`. |
| Host | Smoke, windows | Fail | Check `logs-swin.txt`. |

## Acceptance-gap closure in progress

The gap audit is `/var/tmp/te-wt/traceability.md` (67 items: 30 covered, 33 partial, 4 gaps). Agents follow `/var/tmp/te-wt/conventions.md` and work in worktrees under `/var/tmp/te-wt/`:

| Worktree | Branch | Status |
|---|---|---|
| `trace-provider` | test/shared-ai-provider | **Done**, `9591330` (71 backend tests). It reports a host seam: `verify_bytes` errors reach the provider as `service_unavailable`, so the missing/corrupt reasons never occur in production. |
| `trace-consumer` | test/shared-ai-consumer | In progress or check its log |
| `host-recovery` | test/shared-ai-host-recovery | In progress or check its log |
| `host-mutation` | test/shared-ai-host-mutation | In progress or check its log |

Next steps:

1. Verify each branch's merge-base and merge it into feat/shared-ai-services.
2. Run an independent adversarial review of the merged result, as the user's workflow rules require.
3. Handle the remaining native-e2e gaps: backend killed while the provider runs, multi-window, modals, native Save/Discard, and the §14.4 flows.
4. Fix the remaining CI failures.
5. Update PRs #1048 and #12, then merge.
