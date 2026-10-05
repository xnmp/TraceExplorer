# Host integration

The plugin runs inside [xnmp/tauri-explorer](https://github.com/xnmp/tauri-explorer). Its Rust code relies on host crate services, and its Svelte components rely on the host plugin SDK and shared theme/components.

The host update merged as [PR #991](https://github.com/xnmp/tauri-explorer/pull/991), commit [`af06e086`](https://github.com/xnmp/tauri-explorer/commit/af06e08693826756491d44139a3af039f1da37c0) on `dev`. All 24 final-head CI checks passed. Local acceptance includes 52 Chromium outcomes and 16 native crop outcomes across eight formats.

The plugin snapshot matches the merged host tree. `host.patch` contains the complete update from base commit `151002923ebda01a0c885f75a54b920db311347b`, including plugin sources, host capabilities, and regression tests. The patch applies to that earlier base; current `dev` already includes the integration.

Build the pinned integration from a clean host checkout:

```sh
git checkout af06e08693826756491d44139a3af039f1da37c0
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
