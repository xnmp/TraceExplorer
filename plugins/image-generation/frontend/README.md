# Image Generation connection settings

The `image-generation` contribution registers the `image-generation.connections` dialog and a Configure connections settings action. Its production components import the host Modal and shared Svelte runtime through the package build. The native `settings.*` API owns profiles, credentials, generation and cancellation; frontend drafts contain only public configuration and credential references.

The controller preserves dirty edits on revision events and reconciles events received during save. Generation progress lives on the test button, which offers cancellation; each connection shows its last settled outcome inline. All settled tests are automatically resolved through `settings.test.discard`, releasing successful output without placing images in user folders. `settings.test.list` discovers retained tests after restart. Unknown execution evidence remains unchanged; private test resolution is tracked separately from public delivery. Unknown cleanup requires the host’s private `test.update` resolution acknowledgment (`resolved: true`), so host capacity is actually released. Older hosts keep the test discoverable and cleanup retries; the companion host patch is required for full unknown-test resolution. Closing cancels active test intent and stops polling; reopening resumes cleanup.

Run isolated checks from the Trace repository:

```sh
bunx vitest run --config plugins/image-generation/frontend/vitest.config.ts
bunx svelte-check --tsconfig plugins/image-generation/frontend/check.tsconfig.json
```

The browser harness is at `plugins/image-generation/frontend/harness/`. It exercises the actual contribution/dialog with a native API fixture. `HOST_CHECKOUT` points its Modal import at the actual host component; otherwise it uses the existing Trace harness Modal stub. Run it with a temporary Playwright configuration on a free alternate port, then remove that configuration. Browser scenarios cover saved custom URL/model/key settings, explicit generation, inline outcomes and automatic test resolution, cross-window revision conflicts, keyboard close, and the 320px Codex layout. Fixture tests perform no paid/provider calls and do not qualify native key stores or real provider generation.
