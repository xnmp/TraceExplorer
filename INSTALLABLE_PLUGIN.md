# Installable TraceExplorer contract

TraceExplorer must build from this repository, without a Tauri Explorer source checkout. A release package contains a manifest, frontend module/styles, and the native backend executable for its target. Installing that package into a compatible released host activates Trace and AI image editing without rebuilding the host. The host must have no static imports of Trace/OpenAI components or linkage to their provider/database implementation.

Latest user requirement: generation currently reports "no such file or directory". Generate into managed temporary storage and diagnose that error from actual evidence. Selecting an output in Trace exposes a disk icon to save permanently; use parent_edit.png, parent_edit_2.png, etc. as the suggested collision-free filename. Saving must retain lineage, preserve bytes/source, avoid overwriting a racing destination, and keep unsaved results available across an ordinary restart. This remains part of the installable-plugin goal.

Remove the redundant Current caption from Trace output cards; retain their outline for selection and meaningful changed/missing/revision indicators.

Selecting a different node in the same connected Trace must retain the visible graph during background verification, including inspector remounts while the explorer changes folders. No Loading trace flash and no stale response replacing a newer selection. Unrelated selections must not display a previous lineage.

The host owns generic package installation, SDK compatibility, contribution lifecycle, UI mounting, workspace operations, and process transport. TraceExplorer owns its pane, image forms, generation adapters, SQLite provenance and native publication journal. Core crop/rename operations communicate with the installed provenance provider through a generic recording interface. Existing trace.sqlite history and connection settings survive the transition and uninstall.

Use a manifest-validated archive with immutable versioned payloads, bounded extraction, no traversal/symlinks, and atomic install/upgrade. Serve only frontend assets through a restricted plugin protocol. Share the host's Svelte runtime through an explicitly versioned SDK; never bundle a second runtime or import private host stores. Run native plugin code in an owned process with bounded JSON-RPC over stdio, per-request IDs, ordered event delivery, crash reporting and process-tree cleanup. Disable removes UI contributions; accepted jobs retain ownership until settled. Uninstall must account for active work and retain user outputs/history.

Verification must cover: independent clean builds; malformed/incompatible archives; install into a clean native profile; real selection/AI/crop/Trace outcomes; restart persistence; upgrade; disable/re-enable; uninstall; missing/crashed backend; bounded malformed RPC; queued/concurrent jobs; old history compatibility; CSP in the production webview; complete host regression checks. Publish a downloadable release and merge required generic host support before declaring completion.

Research: [VS Code extension host](https://code.visualstudio.com/api/advanced-topics/extension-host), [Tauri configuration/CSP](https://v2.tauri.app/reference/config/), [Tauri custom protocols](https://docs.rs/tauri/latest/tauri/struct.Builder.html).


## Required runtime invariants

- One native broker per profile/provider, shared across windows. Native data locations are server-owned; RPC uses opaque run IDs, never caller-supplied database paths.
- Initialization carries host-retained live publisher leases before reconciliation. Backend death does not imply a host crop publisher died.
- Native job IDs are allocated by the host. Durable client operation IDs support acceptance/status lookup; lost replies never automatically replay a paid generation.
- Codex executes through a host-owned controlled-process service. The host tracks children from creation and cancels their owned groups if the backend dies. A backend process-group kill alone is insufficient because CLI launchers create distinct groups.
- The input reader/router remains live while dispatch waits on host callbacks. Bound queued and active image work separately from RPC frames. Large process output uses owned spool handles; graph/raw-detail transport needs bounded paging/chunking.
- Core crop/rename remain usable when no provider is installed. Report committed output separately from unavailable recording. Installed AI generation requires a durable acceptance record before contacting its provider.
- Payload upgrade is transactional with data compatibility: migrations need a consistent state snapshot and declared backward/rollback policy; swapping executables cannot undo a schema migration.
- SDK v1 pins compiler/runtime Svelte5.56.3 exactly; reject mismatches before evaluating JS. All Svelte imports bind to the same host instance. [Maintainer compatibility guidance](https://github.com/sveltejs/svelte/discussions/14573).

## Verification and release

TraceExplorer builds independently from this checkout. The [0.1.0 release](https://github.com/xnmp/TraceExplorer/releases/tag/v0.1.0) contains Linux x64/ARM64, macOS Intel/ARM64, and Windows x64 packages with SHA-256 sidecars. Every uploaded archive and checksum matches the qualified local bytes. All five package targets and browser CI pass.

The generic host integration is merged in [PR #996](https://github.com/xnmp/tauri-explorer/pull/996) at `0a29f5411123e1e015e9ac3f55b94ec4fcb8418b`, whose tree exactly matches the qualified source. All 23 final host checks pass. The [compatible Linux x64 host preview](https://github.com/xnmp/tauri-explorer/releases/tag/v1.11.2-plugin-sdk1-preview.1) contains the exact production binary tested with the released plugin. It requires Arch Linux / glibc 2.43+, GTK3, WebKitGTK 4.1, and libsoup3. Other operating systems need a host build containing this SDK v1 integration.

The production native acceptance passes six suites and 33 outcomes with test hooks disabled and public navigation: clean installation and shared-runtime/CSP loading; keyboard/settings; temporary generation and background progress; native permanent save and collision naming; Trace navigation, prompt tooltips and deselection retention; pixel-verified crop lineage; restart; disable/remove/reinstall; failed native upgrade with database rollback; busy lifecycle refusal; and backend crash recovery without provider replay or orphaned processes. Source and installed payload hashes remain unchanged; renderer errors and remaining owned processes are zero. Provider requests use deterministic fixtures; live paid generation is opt-in.

Local contracts pass: 67 plugin native unit contracts plus four actual-process contracts, 12 frontend unit contracts and six tracked browser regressions; 1,734 host native contracts and 3,285 frontend unit contracts. Independent adversarial review verified acceptance, ownership, interrupted upgrade, and stable contribution ordering. Core layout/ordering browser regressions and progress completion/cancellation at desktop, narrow, and short viewports pass.
