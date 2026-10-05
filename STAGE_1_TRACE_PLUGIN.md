# Trace Explorer stage 1: recorded image edits and a read-only DAG

Status: merged into `dev`, 4 October 2026; native verification and limitations below.

## Implementation status

The merged [host inspector PR #978](https://github.com/xnmp/tauri-explorer/pull/978) and [Trace/OpenAI Images PR #979](https://github.com/xnmp/tauri-explorer/pull/979) provide the plugin pane, read-only DAG, native durable records, and a separate OpenAI image plugin. Both PRs are merged into `dev` (Trace/OpenAI squash `4eefa908`). The host changes were made in a new worktree; the original Tauri Explorer checkout is untouched.

**Available workflows:** native crop saved as a copy; OpenAI image editing from one to eight selected PNG/JPEG/WebP images; and prompt-only generation into a selected local folder. **Codex mode is the default** and runs the installed CLI headlessly using its existing ChatGPT sign-in. No API key is required or forwarded. **API key mode** remains available using a configured key or `OPENAI_API_KEY`, with `gpt-image-2` as its default model and optional GPT Image 2.5 Sunburst/Flare. With several selected images, choose the edit target; the others become ordered references and all are recorded as provenance parents.

Runs are recorded before execution and retain prompts, settings, input revisions, safe status/error codes, and available provider request/usage details. Successful publication records the output revision. Startup reconciliation uses retained native file identity and a digest to recover a published output after an interrupted database update. Failed and cancelled runs do not invent outputs. The OpenAI run-history command exposes the latest 64 runs, including failed prompt-only generations; pending publication paths are labelled unverified.

The pane shows ancestors, descendants, forks, and multi-input joins. Selecting a node shows revision/run details. Changed selected bytes are labelled as a historical revision, missing paths are marked, and oversized files are explicitly unverified. Explorer rename and history undo/redo preserve the current revision's locator.

**Deliberate first-release limits:** provenance is in app-local SQLite, not embedded in exported PNGs; graph editing, regeneration, relinking, retention controls, portable export, and asset identity are later stages. Crop replacement is untraced because it uses a separate native recovery journal; save-as-copy is traced. The UI accepts at most eight inputs, bounded to 20 MiB per image, 64 MiB combined, and 16 megapixels per decoded image. Codex requires a compatible CLI executable on the app's PATH, a saved ChatGPT sign-in, and built-in image generation access; headless qualification used CLI 0.160.0 on Linux. Windows npm launcher behavior has not been qualified. Codex controls actual image model/settings and may rewrite the user prompt; its JSONL does not report those fields, so Trace records the user prompt and exact agent task and leaves actual model/tool prompt unknown. The documented image model is recorded separately, without presenting it as observed runtime evidence. Provider revision and monetary cost remain unknown when not reported. A crash in the narrow interval before staging evidence is recorded can leave a private temporary directory. Live Codex generation, single-image editing, and two-image composition have been verified with ChatGPT sign-in; no paid Images API request has been made during verification.

### Use

1. Enable **Trace** and **OpenAI Images** in plugin settings (both default on). For the default **Codex** connection, install a compatible Codex CLI and run `codex login` with ChatGPT. Alternatively, choose **OpenAI API key** in **AI / OpenAI Images**, and enter a key or launch the app with `OPENAI_API_KEY` set.
2. Select one to eight images and right-click → **AI → Edit with OpenAI**, choose the edit target when there are references, enter a prompt and PNG filename, and submit. Mention image 2, image 3, etc. for specific reference roles. The connection can also be selected in the dialog. For a new image, right-click a local folder → **AI → Generate image with OpenAI…**.
3. Select the source or output to inspect the Trace pane. Repeat an edit on the output to extend the graph organically.
4. Use the command palette's **OpenAI: Image Run History** to inspect failed generations with no output file.

### Verification

The full native suite passed (1,753 tests; 45 ignored), and the full frontend suite passed (3,222 tests; 3 skipped). Svelte checks reported no errors or warnings. Targeted browser workflows passed in Chromium and WebKit, covering generation/edit submission, failure history, all three explorer views, multi-parent lineage, changed bytes, and verification limits. Native tests exercise actual HTTP JSON/multipart transport through a local server, captured-byte identity, no-overwrite publication, cancellation, interrupted completion, and startup recovery. Browser tests use a provider mock. A separately invoked native live qualification passed a real two-image Codex edit through capture, headless execution, PNG publication, and SQLite provenance, asserting both recorded parents. This requires an existing ChatGPT sign-in, not an Images API key.

## Purpose and user experience

Start with the image-editing action Tauri Explorer already ships. When a user edits an image, Trace records what the edit actually consumed and produced. Selecting either the source or result shows a **Trace pane** with a small, read-only provenance DAG. This should work without creating a project, importing files, or assigning descendants by hand.

The first model action is an OpenAI image edit using saved Codex ChatGPT sign-in or an API key. Native crop-as-copy also records provenance. The recording boundary should remain provider-neutral so later upscale, animation, and other model actions can use the same durable format. The existing explorer remains the way to browse, select, preview, and open files.

## The first complete workflow

1. Right-click an image and use the OpenAI image edit action. Enter a prompt and output filename.
2. Before remote work starts, the native backend creates a durable run record with a stable ID and the submitted recipe. It records the exact bytes staged as input, rather than assuming the source path still identifies those bytes later.
3. When the output is safely published, the backend records its path, content fingerprint, status, and completion details. A failed or cancelled run remains in history without inventing an output artifact.
4. Select the output image. The Trace pane shows `source image → edit run → output image`, with the prompt, model, provider, timestamps, and any known version/cost information in a details area. Select the source to see edits branching from it. A second edit of an output extends the DAG naturally.
5. Restart the app and select either file again; the same graph and run details appear.

The pane may let the user focus a node, inspect its recorded fields, and reveal a file in the explorer. It does not change prompts, rewire edges, import unrelated files, or regenerate anything in this stage.

## What to record

- **Artifact revision:** stable ID, image type, path as a locator, content hash of the bytes used or produced, size, and availability status. An untraced source is shown as `Existing image; earlier origin unknown`.
- **Edit run:** stable ID, operation type, input revision ID and role, output revision ID when successful, user prompt, exact submitted API prompt or Codex agent task, model choice when controllable, relevant non-secret settings, provider identity, available provider/model revision, start/end times, status, and error details. Unknown provider revision or cost must remain explicitly unknown.
- **Evidence:** distinguish the user's submitted parameters from a provider's actual reported version/cost and from values inferred by Trace. Do not persist API keys, tokens, temporary upload URLs, or raw private diagnostics by default.

Model outputs can be nondeterministic. The record explains how a result was obtained; it does not promise that rerunning the same prompt will reproduce identical bytes.

## Integrity and lifecycle nuances

- **Capture at execution:** hash the exact source bytes staged for the image provider. The source may move or change while the job runs; its path alone is insufficient evidence of what was submitted.
- **Record before notifying:** persist the run's terminal state in the native backend before emitting a completion event. Frontend events update the pane and Jobs panel; they are not the sole record of history. On restart, reconcile incomplete runs and any published output whose final database update was interrupted.
- **Publish safely:** never silently overwrite the source or an existing result. Handle file publication and database updates as a recoverable sequence, since the filesystem and SQLite cannot share one atomic transaction.
- **Identify a selected file:** use recorded location plus content fingerprint and host file-mutation receipts where available. A rename through Tauri Explorer should update the locator. If a file is missing or its bytes differ, retain the historical node and show `missing` or `changed`; do not attach the path's new bytes to the old revision automatically. External moves may require relinking later.
- **Bound the graph:** center it on the selected artifact, showing its ancestry and nearby branches. The current query rejects connected graphs exceeding 1,024 artifacts or runs; branch collapsing and paged expansion can follow later.
- **Keep provenance honest:** edits made outside this recorded path have unknown ancestry. The pane should say so rather than infer causation from filenames or timestamps. Disabling the Trace pane does not stop native recording. Crop-as-copy remains usable with a warning if recording fails; OpenAI generation requires a durable start record before a paid request. Its dialog explicitly states that the prompt and settings are recorded.

## Storage and plugin boundary

Use a schema-versioned, app-local SQLite store for the first release so an edit anywhere can be recorded without project setup or sidecar files. This is a local index, not embedded metadata in the PNG. Keep storage behind a repository interface so later project-local storage, export, or portable sidecars can be added without rewriting the graph model. Prompts are captured only for explicitly submitted model actions, with disclosure in the dialog. Retention/delete-history controls remain future work; there is no claim of encrypted storage or PNG-embedded provenance.

The Trace plugin owns its domain records, query/projection logic, and pane. The host plugin API provides a selection-aware pane contribution. A native provider-neutral recording module survives plugin UI teardown; the crop and OpenAI adapters call it directly. The workspace context also provides automatically disposed file-change notifications, so Trace does not import core state. A public recording API for third-party native adapters can be added when another producer needs it. This stage uses the inspector and durable-operation portions of [tauri-explorer issue #969](https://github.com/xnmp/tauri-explorer/issues/969). Artifact-as-folder navigation and generic virtual-resource activation are later work.

## Acceptance walkthrough

Edit `griswold.png` into `griswold-fog.png`, then edit that output into `griswold-night.png`. Selecting the last image shows all three images and the two edit runs in order; selecting the original shows the branching history. Every run shows its user prompt and exact submitted request/task, reported model evidence when available, and no secret. Codex's actual image-tool prompt/model remain unknown rather than invented. Close and reopen the app: the graph remains. Rename one output through Tauri Explorer: its graph identity survives. Change its bytes externally: Trace flags the mismatch. Simulate a failed edit and a renderer restart during a successful edit: neither produces an invented output, and a published result can be recovered from the native run record.

Verification should cover the native persistence/recovery path, the selected-file lookup, and the user-visible pane in all supported explorer views. A browser mock alone cannot establish that a native job's output and provenance survived a restart.

## Codex transport and usage

Codex mode runs a fresh ephemeral `codex exec --json` session in a private temporary directory. It ignores user configuration, disables shell execution/hooks/plugins/apps/browser tools, and removes API key/token environment overrides. The adapter checks saved ChatGPT sign-in through `codex login status`; Codex owns credential storage and refresh. Captured images are staged with neutral ordered filenames and attached with repeated `--image` arguments. The positional task is separated from the variable image arguments.

The adapter accepts only a completed JSONL thread identity and the single regular PNG in that fresh thread's generated-images directory. It does not trust model-written paths, scan for the newest global image, or reuse unrelated outputs. Both pipe output and PNG decoding are bounded; cancellation/timeout terminates the owned process tree and remains active if a launcher exits before its descendants close the pipes. Interrupted or failed runs retain the durable Trace lifecycle.

Images count toward general Codex usage limits, as described in the [official image generation documentation](https://learn.chatgpt.com/docs/image-generation). Saved authentication reuse is documented in [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode); headless image generation/editing and multiple-image inputs were additionally verified here, because the image documentation's CLI examples describe interactive use. The exact built-in image-tool call is not exposed in the CLI JSONL. Its generated-images layout and login-status text are version-sensitive integration points; the native fixture and opt-in live test qualify that contract.

The opt-in native test can be run with `TRACE_CODEX_TEST_SOURCE` and optional `TRACE_CODEX_TEST_REFERENCE` absolute image paths (and `TRACE_CODEX_TEST_OUTPUT` to retain the result), then `cargo test live_codex_edit_records_a_real_output --lib -- --ignored`. It consumes Codex usage and is excluded from ordinary CI.


## Merged verification

Both PRs are merged into `dev` at `4eefa908`. All 23 PR checks passed. Fresh image generation and a two-image edit ran through the native plugin using saved Codex ChatGPT sign-in. The final native suite passed all three tests, including crop lineage, exact persistence after app restart, rename identity, changed-byte detection, run history and narrow-window file navigation. The final pass reused those fresh outputs after a test-only completion-selector correction. API-key transport was fixture-tested; no live paid Images API call was made.

[Full native report](verification/native-plugin-postmerge/report.md) · [Trace screenshot](verification/native-plugin-postmerge/two-parent-trace.png).
