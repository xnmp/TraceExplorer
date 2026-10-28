# TraceExplorer

An installable image-editing and provenance plugin for [Tauri Explorer](https://github.com/xnmp/tauri-explorer).

Ctrl+E with nothing selected opens **Generate image with AI**: enter a prompt and press Ctrl+Enter. Outputs start unsaved, with the current pane’s folder as the suggested save location. If the pane is not a local folder, open a local output folder and press Ctrl+E again. With one to eight highlighted PNG, JPEG or WebP images, Ctrl+E opens AI Edit; unsupported selections show guidance instead of starting a new image. They are equal inputs, shown as numbered thumbnails (Image 1, Image 2, …) in the order they are sent to the model and recorded, so a prompt can say "put the hat in Image 1 on the man in Image 2"; remove or reorder them in the dialog. In the Trace view, Ctrl-click picks images in order, including unsaved outputs and inputs from other folders. Ctrl+Enter generates. AI Edit opens in its own dialog; on hosts that can open their image editor directly, **AI Edit in Image Editor…** (command) and **Edit in image editor with AI…** (context menu) open one highlighted PNG, JPEG or WebP file in the editor's AI edit tool, using whichever Image Generation connection you pick there (in a Trace view, only when that image is the sole pick); Crop Image… is a separate command. Codex and 2K resolution are the defaults; aspect ratio defaults to Keep (Image 1) for edits and 1:1 for new images. Connection settings preserve your draft.

Generation runs in the background and saves into managed temporary storage. Choose one to eight outputs per prompt; they appear in Trace as children of their source while generating.

## Trace view

Trace replaces the folder's main listing with its provenance graph. Choose it with **Toggle Trace View** (command palette, or the **Alt+M, then P** chord, configurable in **Keyboard Shortcuts**), or from the view options in the folder's context menu. **Set Current View Mode as Default** makes it the default for new panes. Toggling returns to the previous built-in view. Folders without provenance or active/unsaved work show the built-in view and keep the Trace preference.

**Show traces** (command palette, or the folder's context menu on hosts that support it) is the lighter alternative: it stays in the built-in Details, List or Tiles view and groups each image's edits under it, so the Folder Peek caret reveals them. An edit made from several images appears under each, in a "with B" group. Parents in another folder are labelled as outside the folder, and an image whose original was deleted attaches to its nearest surviving ancestor. The Trace view above remains the full graph; Show traces is a no-op on hosts that predate lineage support.

The folder is one tile grid in the host’s sort order. Each lineage appears as a fanned stack with an image count at its cover’s position; files and folders without provenance stay alongside it. Click a stack to select its cover and open a borderless band beneath that row. The cover stays in its cell, other roots wrap below it, and edits run downward. Several stacks can stay open; the cover’s chevron closes its band, and double-click opens the file. Selecting a member from Preview or the host opens its stack. Opening, closing and selecting inside bands preserve every grid column; later rows slide vertically. Pane resize and merging lineages can change columns.

Foreign root inputs are round reference badges on every image they fed, with a folder or outward-arrow glyph. Up to three show directly; `+n` reveals the rest. Click a badge to select its reference in Preview; hover or select it to highlight all consumers. A shared reference keeps independent edit chains in separate stacks. Foreign images with parents in the lineage remain tiles. Other tiles keep the existing ancestry, children and sibling context, junctions, prompts, tooltips and selection styling. Ordinary entries use the host’s `ui/file-tile` when available, with a compatible plugin fallback on older hosts. Trace tiles follow the pane’s `tileSize` setting and keep their size during selection changes.

Preview shows the prompt, with the generation parameters, input references (click one to focus it) and the **Raw** record under a collapsible **Trace details** section that stays as you left it from image to image. Its rows line up with the host's own Preview info in every dock, and switching images never empties or resizes the section while its data loads. Clicking an unsaved output or a reference shows it in Preview without navigating Explorer into its storage folder. The generation form omits temperature and seed because the current image providers do not expose them; historical values remain readable in saved records. The host progress panel shows elapsed time and explicitly estimated progress. When Codex finishes without an image, the job error quotes its reply (or the error it reported); Hosts with the `jobRetry` capability offer Retry on the failed entry; **AI: Image Run History** shows the full reply and offers Retry on any host. Retry resubmits the failed run with the same ordered inputs (pinned to the same revisions), prompt and settings as a new job.

Unsaved outputs carry an **Unsaved** dot and Preview badge. Hover a node (or use Preview's actions) to save with the default filename (`parent_edit.png`, `parent_edit_2.png`, …), discard the candidate, or choose **Save as…** for a picker. Saving keeps the node's identity and provenance, removes its Unsaved marker and selects the saved file when it lands in the displayed folder.

Nodes show the prompt immediately, truncated to fit, and use a cached short title when available. Generating nodes follow the same rule and retain their generation spinner. Prompt summaries use the host's global connection in **Settings → AI → Language models**, independently of image settings. Turn summaries off in **Trace / Prompt titles**. Changing the text connection clears displayed titles and selects a separate cache context. Older hosts or an unavailable/disabled text service retain the original prompt. Hover reveals the full prompt. Technical metadata stays under **Raw**.

Active and unsaved generation workflows remain visible in their intended save folder until saved or discarded. Folder queries use indexed locators and existence checks without hashing images or scanning the folder's contents; component summaries load first and a component's graph loads only when its band opens near the viewport. Layout runs off the UI thread, and transitions (160 ms) respect reduced motion. See [docs/trace-view-layout.md](docs/trace-view-layout.md). **Crop Image…** is a core command for the selected image.

## Installation

Download the `.teplugin` archive matching your operating system and CPU from [Releases](https://github.com/xnmp/TraceExplorer/releases). In a compatible Tauri Explorer host, choose **Install Plugin…** in the command palette and select the archive; its picker filters for `.teplugin` files. **Settings → Open Plugins** opens the dedicated Plugins menu, with installation, package controls and plugin-specific settings. Enable, disable, and remove packages in the same section. Removal retains generated images and history; reinstalling reconnects to them.

This release requires a host with plugin SDK 2 (file views, Preview info and Preview targets) and the host's Svelte 5.56.3 runtime; earlier hosts refuse the package. The installer checks platform, SDK, archive contents, and payload digests before activating code. The original built-in implementation was [PR #991](https://github.com/xnmp/tauri-explorer/pull/991); this package requires the subsequent generic installed-plugin host support.

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

To see where the time went in a slow AI image job, run `python3 -I scripts/image-job-timings.py` (`-n N` for more jobs, `--operation <id>` for one). It reads, read-only, the per-stage wall-clock times that Trace and the image provider each keep in their private databases, and marks the largest gap. Jobs from before this was recorded show no stages. `--self-test` checks the script against temporary databases.

[Product direction](PRODUCT_PLAN.md) · [Stage 1 specification](STAGE_1_TRACE_PLUGIN.md) · [Requested UI changes](CHANGES.md)

MIT license.
