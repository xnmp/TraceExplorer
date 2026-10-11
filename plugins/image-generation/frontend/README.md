# Image Generation connection settings

The `image-generation` contribution registers the `image-generation.connections` dialog and a Configure connections settings action. Its production components import the host Modal and shared Svelte runtime through the package build. The native `settings.*` API owns profiles, credentials, generation and cancellation; frontend drafts contain only public configuration and credential references.

The controller preserves dirty edits on revision events and reconciles events received during save. Generation progress lives on the test button, which offers cancellation; each connection shows its last settled outcome inline. Successful output is discarded through `settings.test.discard`. Terminal results with no output need no host cleanup and never block another test. `settings.test.list` discovers retained tests before generation is enabled; the backend tracks already-shown past outcomes locally while retaining journal evidence. The host can automatically settle idle operations; older hosts may keep their own claim until the user handles it in the host UI. No new host API is required. Uncertain acceptance keeps inspecting the original operation without replay and remains cancellable. Closing cancels active test intent; uncertain cancellation continues inspecting the original operation until a receipt confirms the outcome. Reopening resumes inspection and output cleanup.

Run isolated checks from the Trace repository:

```sh
bunx vitest run --config plugins/image-generation/frontend/vitest.config.ts
bunx svelte-check --tsconfig plugins/image-generation/frontend/check.tsconfig.json
```

The browser harness is at `plugins/image-generation/frontend/harness/`. It exercises the actual contribution/dialog with a native API fixture. `HOST_CHECKOUT` points its Modal import at the actual host component; otherwise it uses the existing Trace harness Modal stub. Run it with a temporary Playwright configuration on a free alternate port, then remove that configuration. Browser scenarios cover saved custom URL/model/key settings, explicit generation, inline outcomes and automatic output cleanup, cross-window revision conflicts, keyboard close, and the 320px Codex layout. Fixture tests perform no paid/provider calls and do not qualify native key stores or real provider generation.
