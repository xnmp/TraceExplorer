# Shared AI services: final status (2026-10-11)

This supersedes earlier status notes. The plan in `docs/shared-ai-services-implementation-plan.md` is implemented, reviewed and natively verified. Paired PRs: host #1048 (into `dev`) and Trace #12 (into `main`), for issue #1047. Nothing is released or installed: neither is authorized.

## Branches

| Repo | Checkout | Branch | Final tip |
|---|---|---|---|
| Host | `/tmp/te-shared-ai-host` | `feat/shared-ai-services` | `abe6bc35` (code `890aaf64`) |
| Trace | `.worktrees/shared-ai-services` | `feat/shared-ai-services` | `52af23a` |

Agent worktrees, build targets and logs live under `/var/tmp/te-wt/`. Summarise a CI run with `/var/tmp/te-wt/ci.sh <repo> <sha>`.

## Done since the previous status

- **Round-2 Trace review fixed.**
  - The fake host in the tests now enforces the real host's per-consumer quota. Terminal unknown outcomes hold their slot until "Stop active recovery" in AI Operations, as plan §7.3 and §21 intend. The host's capacity error now names that resolution.
  - Rebased prepared output and anchor paths after a profile move.
  - The provider commits a proven success in the same transaction as its snapshot.
  - The prompt-titles filter drops only exact repeats.
  - Follow-ups:
    - the fake host refuses reuse of a released ID;
    - the provider's read-fault hook sits behind the `test-hooks` feature;
    - a malformed anchor row is left unrebased.
- **Windows races found by CI, fixed at the root.**
  - The ledger keeps its WAL sidecars across connections, and every ledger open goes through `open_ledger`, which sets `PERSIST_WAL` and `journal_size_limit=0`. Before this, a concurrent connect could observe a delete-pending sidecar.
  - Rebased prepared paths use one normalized form (`stored_target`) in every comparison.
  - The cmd-shim cancellation test gives nested PowerShell more time to start.
- **Native acceptance isolates CLI logins.**
  - The host's default text profile is the Codex CLI. One acceptance attempt on 2026-10-11 therefore made a few real title requests through the developer's saved Codex login.
  - The runner now points `CODEX_HOME` and `CLAUDE_CONFIG_DIR` at empty private homes, puts refusing `codex`/`claude` shims first on `PATH`, and reports how many invocations the shims refused.
  - Final runs on the final tips: absent provider 2/2, present provider 3/3, generation 9/9 twice. The shims refused only `codex exec --help` probes. Hashes are in host `docs/shared-ai-native-acceptance.md`.

## Remaining

1. Confirm CI is green on both final tips, then update the PR descriptions, mark both PRs ready, and merge: host into `dev` first, then Trace into `main`.
2. Clean up `/var/tmp/te-wt` worktrees, branches and build targets after merge, checking each one first.

## Known limits and follow-ups

- **The image-editor tool entry point can't be reached.** The host image editor always opens in crop mode. This predates this work.
- **The provider keeps a durable Failed receipt for transient admission refusals.** This deviates from plan §8.5. Trace's status polling needs that receipt to settle a start that was never dispatched.
- **A future default-on Codex tool would run before the event backstop rejects the turn.** This is documented in the host's `docs/shared-ai-cli-text-isolation.md`.
- **Unacknowledged deliveries hold the host quota.** If the provider stays unreachable after publication, 16 links waiting for acknowledgement block new Trace generation through the host quota until acknowledgement resumes. Plan §7.3 intends the pinning. The provider can't be disabled or removed while it is busy.
- **An intermittent browser test predates this branch.** `e2e/graph.spec.ts` "the clicked tile stays where it was on screen while its graph relayouts" once saw a 26 px shift, against a limit of 2, on CI for `52af23a`. The view code is unchanged from `main`. It may be a real anchoring race and is worth investigating separately.
- **One host test always fails locally:** `file_mutation::...creation_is_lazy_and_competing_entry_plans...`. It also fails on base and passes in CI.
