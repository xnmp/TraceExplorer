# Image Generation connection settings

The `image-generation` contribution registers the `image-generation.connections` dialog and a Configure connections settings action. Its production components import the host Modal and shared Svelte runtime through the package build. The native `settings.*` API owns profiles, credentials, generation and cancellation; frontend drafts contain only public configuration and credential references.

The controller preserves dirty edits on revision events, requires explicit reload after a conflicting edit, reconciles events received during save, and labels historical generation tests by settings revision. Test IDs and retained output survive dialog close/reopen within the contribution's current activation. Closing cancels active test intent and stops polling; only the explicit Discard test output action releases successful output. Host restart recovery requires the host's unresolved-operation surface or native retained-test enumeration.

Run isolated checks from the Trace repository:

```sh
bunx vitest run --config plugins/image-generation/frontend/vitest.config.ts
bunx svelte-check --tsconfig plugins/image-generation/frontend/check.tsconfig.json
```

The browser harness is at `plugins/image-generation/frontend/harness/`. It exercises the actual contribution/dialog with a native API fixture. `HOST_CHECKOUT` points its Modal import at the actual host component; otherwise it uses the existing Trace harness Modal stub. Run it with a temporary Playwright configuration on a free alternate port, then remove that configuration. Browser scenarios cover saved custom URL/model/key settings, explicit generation and retained-output discard, cross-window revision conflicts, keyboard close, and the 320px Codex layout. Fixture tests perform no paid/provider calls and do not qualify native key stores or real provider generation.
