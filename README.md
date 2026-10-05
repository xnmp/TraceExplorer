# TraceExplorer

An installable image-editing and provenance plugin for [Tauri Explorer](https://github.com/xnmp/tauri-explorer).

Ctrl+E opens AI Edit and Ctrl+Enter generates. Codex, 2K resolution, and Keep the same aspect ratio are the defaults. Connection settings preserve your draft. Seed is disabled and marked Not supported.

Generation runs in the background and saves into managed temporary storage. Select an output in Trace and use its disk button to save permanently, with names such as `parent_edit.png` and `parent_edit_2.png`. The Trace pane shows thumbnails and prompts; technical metadata stays under Raw. Hover an image to see its prompt, or click it to select its file. The pane retains the last viewed trace after deselection. Toggle Trace Pane controls visibility from the command palette. Crop Image… is a core command for the selected image.

## Installation

Download the `.teplugin` archive matching your operating system and CPU from [Releases](https://github.com/xnmp/TraceExplorer/releases). In a compatible Tauri Explorer host, open **Settings → Plugins → Install plugin…** and select the archive. Enable, disable, and remove packages in the same section. Removal retains generated images and history; reinstalling reconnects to them.

SDK v1 requires the host's Svelte 5.56.3 runtime. The installer checks platform, SDK, archive contents, and payload digests before activating code. The original built-in implementation was [PR #991](https://github.com/xnmp/tauri-explorer/pull/991); this package requires the subsequent generic installed-plugin host support.

The first separately installable release is currently being qualified. See [the implementation contract](INSTALLABLE_PLUGIN.md) for remaining release checks.

## Build and test

This checkout builds independently; a host source checkout is not required.

```sh
bun install --frozen-lockfile
bun run check
bun run test
cargo test --locked --manifest-path src-tauri/Cargo.toml
python3 scripts/package-plugin.py
```

The package contains a frontend module, stylesheet, and native backend executable. TraceExplorer owns its provider adapters and SQLite journal. The host supplies the shared UI runtime, workspace operations, package lifecycle, optional recording bridge, and controlled CLI process service. [SDK and protocol integration](integration/README.md).

[Product direction](PRODUCT_PLAN.md) · [Stage 1 specification](STAGE_1_TRACE_PLUGIN.md) · [Requested UI changes](CHANGES.md)

MIT license.
