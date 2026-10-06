# TraceExplorer

An installable image-editing and provenance plugin for [Tauri Explorer](https://github.com/xnmp/tauri-explorer).

Ctrl+E opens AI Edit and Ctrl+Enter generates. Codex, 2K resolution, and Keep the same aspect ratio are the defaults. Connection settings preserve your draft. Seed is disabled and marked Not supported.

Generation runs in the background and saves into managed temporary storage. Select an output in Trace and use its disk button to save permanently, with names such as `parent_edit.png` and `parent_edit_2.png`. The Trace pane shows compact image cards and prompts; technical metadata stays under Raw. Hover an image to see its prompt, or click it to select its file. Loaded thumbnails stay cached during tree navigation, and refreshes retain the previous image until its replacement is ready. The pane retains the last viewed trace after deselection. Toggle Trace Pane controls visibility from the command palette. Crop Image… is a core command for the selected image.

## Installation

Download the `.teplugin` archive matching your operating system and CPU from [Releases](https://github.com/xnmp/TraceExplorer/releases). In a compatible Tauri Explorer host, choose **Install Plugin…** in the command palette and select the archive; its picker filters for `.teplugin` files. **Settings → Plugins → Install plugin…** is also available. Enable, disable, and remove packages in the same section. Removal retains generated images and history; reinstalling reconnects to them.

SDK v1 requires the host's Svelte 5.56.3 runtime. The installer checks platform, SDK, archive contents, and payload digests before activating code. The original built-in implementation was [PR #991](https://github.com/xnmp/tauri-explorer/pull/991); this package requires the subsequent generic installed-plugin host support.

Release [0.1.1](https://github.com/xnmp/TraceExplorer/releases/tag/v0.1.1) supplies all five target packages. The compatible [Linux x64 SDK v1 host preview](https://github.com/xnmp/tauri-explorer/releases/tag/v1.11.2-plugin-sdk1-preview.2) requires Arch Linux with glibc 2.43, GTK3, WebKitGTK 4.1, and libsoup3. Other platforms need a host build containing [PR #996](https://github.com/xnmp/tauri-explorer/pull/996). The plugin can then be installed without rebuilding that host. Command-palette installation and Arch auto-install are merged in [PR #998](https://github.com/xnmp/tauri-explorer/pull/998).

On Arch, the host’s `arch_install.sh` automatically queues the latest matching package from `$HOME/Repos/TraceExplorer/package` when it exists. A full app restart validates and installs it. Override the file or directory with `TRACE_EXPLORER_PLUGIN_PATH` or:

```sh
./arch_install.sh --plugin-path /path/to/plugin.teplugin
```

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
