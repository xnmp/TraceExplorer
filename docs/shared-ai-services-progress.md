# Shared AI services implementation state

Prepared 2026-10-10. This records a **partial implementation**, not completion of the plan.

## Checkouts

- Trace: `/home/chong/Repos/TraceExplorer/.worktrees/shared-ai-services`, branch `feat/shared-ai-services`, based on main `cae90fb4344375cf8fc1453df74f50ecdc0b4d55`.
- Host: `/tmp/te-shared-ai-host`, branch `feat/shared-ai-services`, based on dev `3ebfba5792379026f749afed78cb2c65736534a7`.
- The user's original checkouts and unrelated untracked files were preserved. Changes remain local and uncommitted.
- The original implementation plan is an untracked user file in the primary Trace checkout. It was read as input and was not staged, removed or rewritten.

## Implemented

Host text configuration/settings and HTTP execution:

- Discriminated profile configuration with editable model/root, independent default/enabled state, non-secret context fingerprints and CAS revisions.
- Native cross-process configuration coordination, synced replacement, corruption/newer-schema errors and resumable copy-if-unset legacy path/summary migration.
- Write-only immutable OS credential records, environment/none modes and injected test secrets. No new plaintext-key fallback.
- OpenAI-compatible Chat Completions and native Anthropic Messages: correct bounded request/result protocols, nested roots, disabled redirects/retries, refusal/truncation rejection and safe errors.
- Bounded execution/snapshot workers, per-incarnation request ownership, total deadlines, cancellation before admission and caller/window shutdown cancellation.
- Host settings profile manager, dirty drafts, write-only keys, local Check versus explicit Test, stale/CAS/multi-window event handling.
- SDK 2-compatible `textGeneration` capability and active-only native reverse-text bridge. Broker identity/liveness is derived natively; preflight cannot read configuration or generate text through this bridge.

Trace titles:

- One shared reverse client for text and owned processes; bounded frames/pending state, connection-wide IDs, disconnect fanout and late process spool release.
- Titles load authoritative persisted prompts and send no image credentials, provider choice or executable path.
- Additive context/recipe/prompt cache preserves the legacy table; credential rotation reuses compatible non-secret contexts; mismatched response contexts and malformed output are rejected.
- Trace-owned summary preference/binding; global configuration notifications clear labels/cancel active work; unavailable/older hosts keep raw prompts.
- Image contribution no longer controls titles. Existing image generation/provider ownership is otherwise unchanged.

## Deliberately unavailable / unfinished

The installed CLI versions cannot establish the plan's strict no-tools/no-managed-hooks contract using an exec invocation. Both production CLI text adapters return actionable unavailable errors before starting an executable. Codex remains the configured first-run default, so first-run text generation is unavailable until the user selects a configured HTTP profile. Candidate CLI argument/parsing/cancellation fixtures are tested but are not working production support.

Codex can force managed features on despite CLI opt-outs; Claude safe mode retains managed hooks from server/MDM/registry policies. A separate inspection followed by a new exec process would race configuration changes. See the host's `docs/shared-ai-native-text-evidence.md` for pinned official source and the required same-instance policy/admission boundary.

Stages D–G remain unimplemented: declared cross-plugin service routing, durable service admission/lifecycle claims, artifact store, qualified job snapshots/recovery/cancellation, managed modal navigation, independent Image Generation package, credential migration/cutover, Trace image-service consumption, paired five-target artifacts and packaged host acceptance. The current image code still lives in TraceExplorer. Do not claim extraction or replay/recovery guarantees beyond the existing image implementation.

## Verification and limits

- Trace `bun run check`: clean.
- Trace unit suite: 330 passed, 1 skipped. The initial scale timing failure under parallel compilation passed both isolated and full reruns.
- Trace native suite: 138 unit + 9 subprocess protocol + 1 dispatcher/database integration passed; 2 pre-existing ignored tests.
- Trace browser suite on isolated port 1557 with 4 workers: 124 passed. The initial default-concurrency run exhausted resource quota; the corrected harness and bounded-worker full rerun passed.
- Trace frontend build passed. One diagnostic Linux archive was packaged with the debug backend and its checksum verified; this is not a release artifact or native packaged-host acceptance.
- Host settings domain/controller/mock parity: 30 tests passed; plugin context/runtime/lifecycle subset: 21 passed.
- Host settings browser suite against a stable production preview on isolated port 1564: 4 passed, including keyboard/320px behavior.
- Host frontend build/type check and code-map coverage passed.
- Host native text/bridge/config/process/watcher regression: 66 passed. Results are recorded in `/tmp/te-ai-native-regression.log`; the latest counts are in the host evidence document. Automated providers are local HTTP/fake CLI and secrets are in-memory fixtures.
- Independent adversarial review found and fixed ID mismatch, lost pre-admission cancellation, secret cleanup after replacement uncertainty, truncation/refusal acceptance, discovery/migration omissions, config-write migration races, cross-window save/event races and describe worker capacity. CLI isolation remains unsupported rather than silently weakened.
- Real Linux/macOS/Windows secret stores and macOS/Windows process/replacement behavior were not qualified. No paid/live provider requests, releases, PRs, merges or user-app installation occurred.

## Publication block

Automatic approval review rejected creating the required host GitHub issue: it stated that implementing the plan did not authorize publishing requirements externally. A reviewable issue body remains at `/tmp/shared-ai-issue.md`. No issue was created and no approval was bypassed. Local work proceeded in isolated worktrees.

The complete host WIP (including new source files and screenshots) is preserved as `docs/shared-ai-host-wip.patch` beside this record. Apply against the recorded host baseline with `git apply --binary`; do not apply over unrelated changes.
