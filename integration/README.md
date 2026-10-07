# Host integration

TraceExplorer is built and packaged independently. `plugin.json` declares package identity, contributions, exact Svelte ABI, and mutable state files. The release builder adds platform and payload size/SHA256 declarations to `manifest.json` in a `.teplugin` ZIP.

The host loads frontend assets through its restricted `plugin:` protocol. It exposes a frozen SDK v1 with Svelte 5.56.3 public/internal bindings, modal and image-editor components, thumbnails, and a native save picker. Plugin contributions receive public workspace, settings, event, job, and backend services; they import no host stores. The TypeScript contract is [plugin-sdk/index.d.ts](plugin-sdk/index.d.ts).

The backend speaks bounded JSON-RPC2 over stdio. Host initialization supplies active publisher leases before reconciliation. Generation uses host job IDs and durable operation IDs; acceptance/status recovery queries never replay a provider request. Codex subprocesses run through the host's owned process service, so backend death cancels them. Large responses are chunked and process output uses bounded, owned spools.

Core crop and rename call an optional generic provenance service. They remain available without TraceExplorer installed. The plugin records immutable input digests and exact publication evidence; opaque handles contain no caller-supplied database paths. Existing `trace.sqlite` is imported into the package's data directory without deleting the old copy.

Upgrade waits for accepted work and host publishers to settle. The host snapshots declared mutable files, preflights the new backend with recovery deferred, and durably commits activation before external publication-proof cleanup. A failed preflight restores both index and state. The transaction journal records file presence/digests and a terminal phase so interrupted cleanup cannot erase current history. User outputs and data survive removal.

Build the package with `python3 scripts/package-plugin.py`. Native host integration tests must install this actual archive into an isolated profile; frontend mocks alone do not qualify custom-protocol/CSP/runtime behavior.

The original built-in feature work is preserved in Git history and [host PR #991](https://github.com/xnmp/tauri-explorer/pull/991). Source synchronization from the host has been retired; this repository owns the implementation now.

The shared image-editor component uses its `initialTool` for that opening. Plugin AI dialogs open directly in their requested tool; core Crop Image… opens the crop surface separately. Commands can declare a default single shortcut or two-step chord (for example `Alt+M P`); the host registers it in Keyboard Shortcuts, preserves user overrides and retires it with the plugin context.
