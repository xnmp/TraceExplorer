# Shared AI services: continuation status (2026-10-10, late)

This supersedes earlier status notes. Nothing is merged into `dev`/`main` or released. Paired draft PRs: host #1048 (into `dev`), Trace #12 (into `main`), issue #1047.

## Branches

| Repo | Checkout | Branch | Tip | CI |
|---|---|---|---|---|
| Host | `/tmp/te-shared-ai-host` | `feat/shared-ai-services` | `37a3579a` (pushed) | running |
| Trace | `.worktrees/shared-ai-services` | `feat/shared-ai-services` | `8a99e61` (pushed) | green on all 5 targets |

Agent worktrees and logs live under `/var/tmp/te-wt/`. Summarise a CI run with `/var/tmp/te-wt/ci.sh <repo> <sha>`.

## Done since the previous status

- **Acceptance gaps closed.**
  - Native consumer-kill fixture (3.20).
  - Native e2e for §14.4: titles/default profile, slow-profile isolation, text/image config isolation, selection and folder generation with ordered inputs, retry lineage, progress panel, Save/Discard.
  - §21.3 #12: Plugins-page modal.
  - 21.1, 21.3 and 2.6 were covered by earlier merges.
- **Review round 1.** Four independent reviewers covered host lifecycle, host store/AI, Trace consumer and provider. Every confirmed defect is fixed with tests:
  - unknown outcomes are terminal and retryable;
  - publication happens before the provider ack;
  - moved profiles;
  - cancellation-intent leak;
  - sealing reported as Running;
  - Codex host-error classification;
  - first-run journal and ledger recovery;
  - unaccepted jobs settle;
  - parked jobs are dismissable;
  - a refused drain restores ACTIVE;
  - cross-platform profile lock;
  - degraded store open;
  - best-effort byte GC;
  - malformed config repair;
  - temp-file sweep;
  - keyring orphans.
- **CLI text adapters.** Codex and Claude Code are enabled behind isolation checks, a decision the user made on 2026-10-10. See host `docs/shared-ai-cli-text-isolation.md`.
- **Review round 2, host.** It found two low-severity issues (parked-job reactivation, keyring deletion on a failed dir sync) plus Codex `todo_list`. All are fixed in `37a3579a`.
- **Flaky tests made deterministic.** Trace deadline/FIFO/layout/Playwright tests, the host mutation matrix (a real ArtifactLease fork bug), and `ai/tests.rs` semaphore contention.

## In flight

- **Review round 2, Trace.** It reviews `554f8e9..c0a2715`.
- **Paired change: typed pre-spawn refusal codes and bounded stdin for `host.process.run`.**
  - Worktrees: `/var/tmp/te-wt/host-process-api` and `/var/tmp/te-wt/trace-process-api`.
  - Codex image prompts go via stdin when the host supports it, which removes the Windows cmd.exe 8191-character limit.

## Remaining before merge

1. Merge the in-flight branches. Get CI green on both repos on all platforms.
2. Rebuild the host e2e binary and the Trace/provider archives from the final tips. Re-run `e2e-tauri/run-shared-ai-services.sh` with the absent and present profiles, including `SHARED_AI_NATIVE_GENERATE=1`. Record the hashes in host `docs/shared-ai-native-acceptance.md`.
3. Re-fetch `origin/dev` and `origin/main`, and merge them in if they moved. Update the PR #1048 and #12 descriptions, mark them ready, and merge once CI is green. No release and no install: neither is authorized.
4. Clean up `/var/tmp/te-wt` worktrees and branches after merge, checking each one first.

## Known gaps and decisions

- **Image-editor tool entry point is unreachable.** The host image editor always opens in crop mode, so Trace's "AI edit" editor tool can't be reached. This predates the work on host `dev`, and fixing it needs a host editor tool switcher.
- **The provider keeps a durable Failed receipt for transient admission refusals.** This deviates from plan §8.5. Trace's status polling needs that receipt to settle a never-dispatched start.
- **Possible remaining Codex CLI risk.** A future default-on Codex tool would run before the event backstop rejects the turn. This is documented.
- **One host test always fails locally:** `file_mutation::...creation_is_lazy_and_competing_entry_plans...`. It also fails on base and passes in CI.
