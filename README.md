# TraceExplorer

An installable image-editing and provenance plugin for [Tauri Explorer](https://github.com/xnmp/tauri-explorer).

Ctrl+E opens AI Edit for one to eight highlighted images; the first is the edit target and the others are references. Ctrl+Enter generates. Codex, 2K resolution, and Keep the same aspect ratio are the defaults. Connection settings preserve your draft. Seed is disabled and marked Not supported.

Generation runs in the background and saves into managed temporary storage. Choose one to eight outputs per prompt; related outputs appear together in Trace. Temperature and seed are disabled because the current image providers do not expose them. The host progress panel shows elapsed time and explicitly estimated progress.

Temporary cards carry an **Unsaved** badge. Hover to save with the default filename (`parent_edit.png`, `parent_edit_2.png`, …), discard the candidate, or choose **Save image as…** for a picker. Temporary cards select their Trace details without navigating Explorer into managed storage; permanent cards select their file. Saving retains the output’s provenance and removes its Unsaved badge.

Cards show the prompt immediately, truncated to fit, and use a cached short title when available. Generating nodes follow the same rule and retain their generation spinner. The optional title generator uses Codex credentials with `gpt-6-luna` at its lowest supported effort (`low`); turn it off or configure its executable in Plugins settings or the connection gear. A title spinner appears only when a saved Codex connection is available. Hover reveals the full prompt. Technical metadata stays under **Raw**.

Loaded thumbnails stay cached during tree navigation. Trace remains open after deselection or selection of non-image files within a folder containing provenance; empty folders hide it. Active and unsaved generation workflows remain visible in their intended save folder until saved or discarded. Folder eligibility uses indexed locators and existence checks without hashing images or scanning the folder’s contents.

Drag the divider between the tree and details to resize the tree, or focus it and use the arrow keys. The compatible host also lets you resize the whole pane. **Toggle Trace Pane** controls visibility from the command palette or the **Alt+M, then P** chord; change or remove that binding in **Keyboard Shortcuts** settings. **Crop Image…** is a core command for the selected image.

## Installation

Download the `.teplugin` archive matching your operating system and CPU from [Releases](https://github.com/xnmp/TraceExplorer/releases). In a compatible Tauri Explorer host, choose **Install Plugin…** in the command palette and select the archive; its picker filters for `.teplugin` files. **Settings → Open Plugins** opens the dedicated Plugins menu, with installation, package controls and plugin-specific settings. Enable, disable, and remove packages in the same section. Removal retains generated images and history; reinstalling reconnects to them.

SDK v1 requires the host's Svelte 5.56.3 runtime. The installer checks platform, SDK, archive contents, and payload digests before activating code. The original built-in implementation was [PR #991](https://github.com/xnmp/tauri-explorer/pull/991); this package requires the subsequent generic installed-plugin host support.

Release [0.1.2](https://github.com/xnmp/TraceExplorer/releases/tag/v0.1.2) supplies all five target packages. The compatible [Linux x64 SDK v1 host preview](https://github.com/xnmp/tauri-explorer/releases/tag/v1.11.2-plugin-sdk1-preview.4) requires Arch Linux with glibc 2.43, GTK3, WebKitGTK 4.1, and libsoup3. Other platforms need a host build containing [PR #996](https://github.com/xnmp/tauri-explorer/pull/996). The plugin can then be installed without rebuilding that host. Command-palette installation and Arch auto-install are merged in [PR #998](https://github.com/xnmp/tauri-explorer/pull/998). The separate Plugins Settings menu and code-preview font fix are merged in [PR #1002](https://github.com/xnmp/tauri-explorer/pull/1002).

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
