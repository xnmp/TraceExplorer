# Extend the plugin API for artifact-oriented workspaces (Trace Explorer umbrella)

## What's the friction?

Trace Explorer is an opt-in provenance-aware media workspace built on Tauri Explorer. A user should be able to start with an ordinary image, run an edit or animation action, open the result as media, expand either artifact to browse its descendants, and inspect how each output was made. Later, they should be able to edit an upstream recipe and see which downstream outputs are affected.

The existing build-time plugin system handles commands, context-menu actions, settings, dialogs, simple virtual directory listings, and session-level job presentation. It cannot yet express an artifact that is both openable media and an expandable lineage container. The `FileEntry` model is file-or-directory and path-based; `FsProvider` only lists; double-click uses the entry kind to choose navigation or file opening; and current media plugins reject virtual paths. There is no generic inspector contribution or durable run-status integration. File moves and external changes also need to be observable without making a plugin import explorer internals or infer lineage from filenames.

This issue tracks the **host-owned plugin surface** needed for Trace Explorer. The Trace domain model, media provider adapters, project database, and regeneration algorithm belong to Trace work, not to the generic explorer API. This is an umbrella issue to deliver through small, independently mergeable slices against the current `dev` branch.

## Proposed behavior and API areas

### 1. Addressable entries with separate open and expand capabilities

- Let a plugin expose a stable, opaque resource identity independent of its current display path or backing file path. Existing local `FileEntry` behavior should remain compatible.
- Represent **open/preview** and **expand/navigate** as independent capabilities. An image with descendants can support both. Define explicit keyboard, double-click, and disclosure behavior rather than treating the item as either a file or a directory.
- Provide a provider-facing resolver for a virtual resource's display metadata, children, and optional backing local file/media. A virtual resource without a backing file must not be passed into native file operations or external-open commands.
- Keep selection, breadcrumbs, history, refresh, search/filter, and context-menu targeting coherent when navigating plugin resources. Multi-parent lineage may choose one navigation parent without losing its other links in plugin data.
- Make file-backed virtual media available to existing preview/open mechanisms and applicable image actions through a documented resolution path. Do not require each media plugin to special-case `trace://` paths.

### 2. Selection-aware inspector contribution

- Let a plugin contribute a pane or inspector section for the active selection, including plugin-owned resources and ordinary files it recognizes. The host owns placement, focus, sizing, and lifetime; the plugin owns its content.
- Provide a typed selection/context snapshot and a way to react to changes. Unregister the contribution cleanly when the plugin is disabled, a pane closes, or a window is torn down.
- Keep the extension generic: the host need not know about provenance graphs, recipes, or logical assets.

### 3. Durable-operation bridge, separate from the Jobs panel

- Expose a stable correlation ID and typed lifecycle for plugin operations: accepted, running/progress, completed with output references, failed, and cancelled. A completion that arrives before the start response must still reconcile exactly once.
- Permit a plugin-owned backend to persist and query run state across window reloads and app restarts. The host Jobs panel is a projection of that state; it is not the provenance database. Define how active jobs behave when the plugin is disabled or a window closes.
- Support multiple outputs and diagnostic metadata without putting provider-specific request schemas or secrets in the host API. A result path alone is insufficient for a durable run record.
- Keep native commands compiled in and permission-scoped under the current Tauri model. This issue does not require runtime loading of arbitrary Rust or JavaScript plugins.

### 4. File lifecycle observations for plugin-owned records

- Give a plugin enough normalized information to reconcile recognized files after host-mediated rename, move, delete, restore, or replacement, including the committed mutation receipt where available. Preserve the host's existing undo and conflict behavior.
- Distinguish host-mediated mutations from external filesystem changes. An external edit or replacement should be reported as evidence requiring reconciliation, not automatically recorded as a generated child.
- Specify how virtual entries that resolve to local files participate in file actions, and which operations remain unavailable for them.

### 5. Ownership, compatibility, and integration

- Keep all contributions registered through an owned context with disposers. Disabled plugins should add no file-list or preview hot-path work.
- Expose a small, documented contract that can evolve additively. Add plugin-surface contract tests using a minimal test plugin, so subsequent Tauri Explorer changes catch breakage before Trace does.
- Ensure the same behavior across Details, List, Tiles, and Miller navigation, across multiple tabs/panes and windows where applicable, with keyboard and pointer interaction.
- Document the boundary between Tauri Explorer's build-time application plugins and Tauri's native plugin/permission mechanism. Separate source packages may come later; an installed app will still need a build that includes the plugin.

## Suggested delivery slices

1. Resource identity and open/expand resolution, demonstrated by a test artifact with a local image and one virtual child.
2. Selection-aware inspector contribution.
3. Durable operation correlation/recovery bridge, demonstrated with a fake backend job rather than a paid provider.
4. File mutation/reconciliation events and virtual-file action policy.
5. Cross-view/window compatibility pass and plugin API documentation.

Each slice should merge into `dev` after its contract tests pass. Trace Explorer can remain disabled by default until its first complete workflow is usable. Avoid a long-lived fork of Tauri Explorer.

## Acceptance criteria

- [ ] A test plugin lists a virtual artifact that opens or previews a real image and expands to show a child without masquerading as a native directory.
- [ ] Selection, breadcrumbs/history, context actions, and keyboard navigation work for that artifact in all supported views; normal filesystem entries behave as before.
- [ ] A generic inspector contribution follows selection and disappears on disable or teardown without stale UI or listeners.
- [ ] A plugin operation can be correlated to its output(s), recover its state after a renderer restart, and settle once if completion races with registration; disabling the UI plugin does not lose a committed result.
- [ ] A host-mediated move/rename preserves the plugin's ability to find a recognized file; an external edit is surfaced as an unverified change rather than fabricated provenance.
- [ ] Virtual resources without backing files cannot reach native file-mutating/open commands through a string path accident.
- [ ] Host/plugin contract tests and a small real-backend test cover the paths that browser mocks cannot verify; the plugin API and lifecycle behavior are documented.

## Scope limits

This issue supplies generic extension points. It does not implement Trace's provenance schema, graph UI, media model catalog, hosted API integrations, semantic regeneration, or logical asset identity. Those should use these extension points in separate Trace feature issues.

## Screenshots

- [ ] Resource that both opens/previews and expands to descendants, in the supported file-list views.
- [ ] Inspector contribution for a selected artifact and its clean removal after disabling the test plugin.
- [ ] Jobs panel/result state after an operation survives renderer restart, or equivalent native-test evidence if the state is not visually distinguishable.
