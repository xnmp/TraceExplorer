# Host integration

The plugin runs inside [xnmp/tauri-explorer](https://github.com/xnmp/tauri-explorer). Its Rust code relies on host crate services, and its Svelte components rely on the host plugin SDK and shared theme/components.

The host update is [PR #991](https://github.com/xnmp/tauri-explorer/pull/991).

The current host changes start from dev commit `151002923ebda01a0c885f75a54b920db311347b` and are developed on `feat/streamlined-ai-image-trace`. `host.patch` contains the complete host update, including plugin sources, host capabilities, and regression tests. The patch applies to that base; after the host PR merges, the dev branch already contains the integration.

To reproduce the pre-merge integration in a clean host checkout:

```sh
git checkout 151002923ebda01a0c885f75a54b920db311347b
git apply --check /path/to/TraceExplorer/integration/host.patch
git apply /path/to/TraceExplorer/integration/host.patch
bun install --frozen-lockfile
bun run check
bun run build
bun run tauri dev
```

Run tests from the host checkout because the focused tests use its fixtures and infrastructure:

```sh
bunx vitest run tests/domain/image-generation-settings.test.ts tests/domain/image-output-filename.test.ts tests/domain/trace-layout.test.ts tests/plugins/openai-image.test.ts
bunx playwright test e2e/image-crop.spec.ts e2e/openai-image.spec.ts e2e/image-editor.spec.ts e2e/trace-inspector.spec.ts
cargo test --manifest-path src-tauri/Cargo.toml openai_image --lib
```

The source manifest is deliberately explicit. `scripts/sync-from-host.py --check` verifies that this repository's plugin snapshot matches the host; `--write` refreshes it. Shared SDK and window/explorer changes remain in the host integration patch.
