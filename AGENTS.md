# AGENTS.md

TraceExplorer is an installable plugin (`.teplugin`) for the [Tauri Explorer](https://github.com/xnmp/tauri-explorer) host. It provides the **Trace view**, a provenance graph that replaces a folder's listing, and **AI image editing** through OpenAI or Codex. The frontend is Svelte 5 and TypeScript, built against the host's shared runtime. The backend is a Rust executable in `src-tauri/` that the host runs over JSON-RPC on stdio and that owns `trace.sqlite`.

What it does for users: [README.md](README.md). How it plugs into the host: [integration/README.md](integration/README.md).

## Layout

| Path | What lives there |
|---|---|
| `src/lib/domain/` | Pure logic with no Svelte or IO: graph model and layout (`trace-graph/`), input and retry rules, filenames |
| `src/lib/plugins/trace/` | The Trace contribution. `view/` holds the view (`TraceView.svelte`), the folder session and paging, layout worker, picks (`input-picks.ts`), tooltips and Preview info |
| `src/lib/plugins/openai-image/` | AI Edit dialog and form, job registration with `retry` (`image-jobs.ts`), run history |
| `src/lib/api/` | Typed wrappers over backend RPC |
| `src-tauri/src/trace/` | The folder index (`folder_graph.rs`: components, members, paging), folder eligibility (`folders.rs`), saves, jobs, titles |
| `src-tauri/src/openai_image*` | Provider adapters. `codex_turn.rs` reads `codex exec --json` events |
| `integration/plugin-sdk/` | The host SDK contract (`index.d.ts`) and the theme tokens every host theme defines |
| `e2e/harness/` | Browser harness that mounts the real view against a **mock backend** (`view-fixture.ts`) and a mock host pane (`ViewHarness.svelte`) |
| `docs/` | [Trace view layout](docs/trace-view-layout.md) and [plan](docs/trace-view-plan.md) |

`PRODUCT_PLAN.md`, `STAGE_1_TRACE_PLUGIN.md`, `INSTALLABLE_PLUGIN.md`, `CHANGES.md` and `TAURI_EXPLORER_PLUGIN_SURFACE_ISSUE.md` are historical background, not current specs.

## Commands

Use **bun only**, never npm, yarn or pnpm. CI (`.github/workflows/ci.yml`) runs all of these:

```sh
bun install --frozen-lockfile
bun run check                 # svelte-check; does NOT cover e2e/harness
bun run test                  # vitest
cargo test --locked --manifest-path src-tauri/Cargo.toml
bun run test:browser          # Playwright on port 1541, headless
python3 scripts/package-plugin.py   # → package/TraceExplorer-<ver>-<target>.teplugin
scripts/host-smoke.sh <host checkout>  # native install + WebDriver smoke under xvfb
```

- **Exit codes:** never pipe Playwright into `tail` without capturing its exit code; write the output to a log and check `$?`.
- **Ports:** in a worktree, run e2e from a temporary config on another port, and delete it afterwards. Port 1420 belongs to the host dev server.
- **Harness after merges:** look for duplicate top-level declarations in `e2e/harness/*`, since `check` won't catch them.
- **Host smoke:** needs a host built with `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks`.

## Conventions

- **Domain first.** Put rules in pure functions (`src/lib/domain`, `input-picks.ts`, `target-location.ts`, `has_relationship` in `folder_graph.rs`), unit-test them, and keep components thin.
- **Svelte 5 runes.** Don't use `$effect` to sync state that can be derived.
  - The view's ordered picks are a *writable* `$derived` that re-derives whenever the host selection's contents change. The view's own clicks call the host first, then assign a **fresh** object; assigning the same object is a no-op. See the header comment in `input-picks.ts` before touching selection.
- **Host compatibility by feature, not version.** Detect what the host offers (an optional field like `pane.tileSize`, a module lookup like `hostFileTiles()`) and degrade cleanly when it's absent. Host capability names are listed in `integration/README.md`.
  - Shapes in `integration/plugin-sdk/index.d.ts` must match the host's `src/lib/plugins/api.ts` exactly.
  - SDK changes need a host PR first, or alongside.
- **Styling:** use only the tokens in `integration/plugin-sdk/theme-tokens.ts`; `tests/plugins/theme-tokens.test.ts` enforces it.
- **The mock backend must behave like the real one.** Mirror `folder_graph.rs` rules in `e2e/harness/view-fixture.ts`, and make the harness pane select like the host does: Shift selects a range, and only content changes notify. Tests that only pass against the mock are worse than no tests.
- **Paths:** canonicalize with `dunce`, so Windows paths stay as plain `C:\…`. Component ids change when components merge, so don't hold one across a merge.
- **Reviews:** changes to selection, the folder index, or publication need an independent adversarial review before merge.

## Releasing

1. Bump the version in `package.json`, `plugin.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` (`trace-explorer-backend`).
2. Open a PR into `main` and squash-merge it once CI is green. Wait for the `main` "Build plugin" run, then `gh run download` its 5 target artifacts and run `sha256sum -c` on them.
3. Create the release: `gh release create vX.Y.Z --target <full main SHA> --title "TraceExplorer vX.Y.Z"` with all `.teplugin` and `.sha256` files. Follow the style of earlier release notes: user-facing, and stating the minimum host version.
4. Install locally:
   - With a host change, run the host's `arch_install.sh`, which queues the newest package from `~/Repos/TraceExplorer/package`.
   - For a plugin-only release, copy the package to `~/.config/tauri-explorer/pending-plugins/<sha256>.teplugin` and restart the app.
   - Check the result in `~/.config/tauri-explorer/installed-plugins/installed.json`.

Known CI flakes:
- macOS package timing assertions;
- the host-side WebKitGTK crash ([tauri-explorer#1026](https://github.com/xnmp/tauri-explorer/issues/1026)).

Rerun them before suspecting a regression.
