# Trace Explorer

Image provenance and AI image editing plugins for [Tauri Explorer](https://github.com/xnmp/tauri-explorer).

Trace records the actual image revisions and transformations behind creative work. The explorer remains the place to browse and select files; the Trace pane shows their ancestry, outputs, prompts, and generation status.

- Ctrl+E opens AI edit; Ctrl+Enter generates.
- Codex is the default connection, with OpenAI API models available.
- Resolution defaults to 2K; aspect ratio defaults to Keep the same.
- Connection settings preserve the edit draft and report save failures.
- Background progress appears in the bottom-right corner.
- Completed edits use one output thumbnail node, with technical metadata under Raw.
- Clicking a node reveals its file; Toggle Trace Pane is available in the command palette.
- Seed is disabled and marked Not supported because the current providers expose no seed.

## Integration status

These plugins currently compile into Tauri Explorer. They are not a separately installable JavaScript package: the native Rust adapters use the host's job lifecycle, filesystem publication, config, and SQLite provenance services.

This repository keeps the plugin sources, focused tests, design documents, and the current host integration patch together. `src/` and `src-tauri/` preserve the paths used in the host repository. Build and run the plugins from the matching Tauri Explorer checkout; see [integration/README.md](integration/README.md).

## Source synchronization

```sh
python3 scripts/sync-from-host.py --host /path/to/tauri-explorer --check
python3 scripts/sync-from-host.py --host /path/to/tauri-explorer --write
```

The source manifest is [integration/source-manifest.json](integration/source-manifest.json). Host-wide capabilities and UI changes are captured in `integration/host.patch`; they remain maintained and tested in the host PR.

[Product direction](PRODUCT_PLAN.md) · [Stage 1 specification](STAGE_1_TRACE_PLUGIN.md) · [Requested UI changes](CHANGES.md)

MIT license.
