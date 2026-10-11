<script lang="ts">
  /**
   * A minimal SDK-2 host: one Explorer pane that renders the registered file
   * view (or a built-in list where it is unavailable), and a Preview pane that
   * shows files or plugin Preview targets with their info sections.
   *
   * The Preview mirrors the host's side dock: a header, the image centred in
   * the space left over, the host's own info rows, then the plugin sections,
   * which inherit the host's `--preview-info-inset`.
   */
  import type { Component } from "svelte";
  import type { FileViewContribution, FileViewPane, ImageEditorSource, PluginContext, PreviewInfoContribution, PreviewSubject, PreviewTarget, TileSizePreset } from "../../integration/plugin-sdk";
  import type { FileEntry } from "$lib/domain/file";
  import { tracePlugin } from "$lib/plugins/trace";
  import { forgetFolderSnapshots } from "$lib/plugins/trace/view/folder-session.svelte";
  import { openAIImagePlugin } from "$lib/plugins/openai-image";
  import { DIRECTORY, files, backend, initialTileSize } from "./view-fixture";
  import { TILE_IMAGE_PX } from "./tile-presets";

  let views = $state.raw<FileViewContribution[]>([]);
  let sections = $state.raw<PreviewInfoContribution[]>([]);
  const commands = new Map<string, () => void | Promise<void>>();
  /** Each command's `when`: whether the host would offer it (for example on its shortcut). */
  const conditions = new Map<string, () => boolean>();
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const fileListeners: Array<(directories: readonly string[]) => void> = [];

  let enabled = $state(true);
  let fileView = $state<string | null>("trace.view");
  let directory = $state(DIRECTORY);
  let entries = $state.raw<FileEntry[]>(files());
  let selected = $state.raw<string[]>([]);
  let cursor = $state<string | null>(null);
  /** The Shift-range anchor, as the host's `selectionAnchorPath`. */
  let anchor: string | null = null;
  /**
   * Replaces the selection as the host's `setSelection` does: only a change of
   * its contents notifies (the host mutates a SvelteSet in place), and a
   * non-empty change replaces a Preview target.
   */
  function replaceSelection(next: readonly string[]): void {
    const unique = [...new Set(next)];
    if (unique.length === selected.length && unique.every((path) => selected.includes(path))) return;
    selected = unique;
    if (unique.length && target) target = null;
  }
  let target = $state.raw<PreviewTarget | null>(null);
  let viewWidth = $state(900);
  let opened = $state.raw<string[]>([]);
  let menus = $state.raw<Array<string | null>>([]);
  let navigations = $state.raw<string[]>([]);
  let actionError = $state("");
  // The pane's tile size, as a host with the "tileSize" capability reports it; null simulates an older host.
  let tilePreset = $state<TileSizePreset | null>(initialTileSize);
  // `?ai=1` also activates the AI image plugin, with dialogs and a jobs service.
  const ai = new URLSearchParams(location.search).has("ai");
  const dialogs = new Map<string, Component<any>>();
  let opened_dialogs = $state.raw<Array<{ id: string; props: Record<string, unknown> }>>([]);
  let accepted = $state.raw<Array<{ label: string; detail: string }>>([]);
  /** The AI edit tool in a stand-in for the host's image editor: it stays mounted while the editor's source fills in. */
  let editorTool = $state.raw<{ component: Component<any>; props?: Record<string, unknown> } | null>(null);
  let editorSource = $state.raw<ImageEditorSource | null>(null);
  let editorToolId: string | null = null;
  let toasts = $state.raw<Array<{ message: string; variant: string }>>([]);
  /** `?editorApi=0` simulates a host without `presentation.openImageEditor`. */
  const editorApi = new URLSearchParams(location.search).get("editorApi") !== "0";
  const editorCalls: Array<{ path: string; tool: string }> = [];
  let editorClosed: (() => void) | undefined;
  const menuItems = new Map<string, { label: string; group: string; when: (entries: FileEntry[]) => boolean; handler: (entries: FileEntry[]) => void | Promise<void> }>();
  let disposed = false;
  const absolutePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
  /** Mirrors the host's imageEditorRequestError (plugin-image-editor.ts) and its dialog-store refusals, with the same messages. */
  function imageEditorRequestError(request: unknown): string | null {
    if (disposed) return "Plugin caller was disposed";
    if (typeof request !== "object" || request === null) return "Image editor request must be an object";
    const { path, tool } = request as Record<string, unknown>;
    if (typeof tool !== "string" || tool !== editorToolId) return "Image editor tool is not registered by this plugin";
    if (typeof path !== "string" || !path || path.length > 4096 || path.includes("\0") || !absolutePath(path)) return "Image editor path must be an absolute file path";
    if (editorSource) return "Close the open image editor first";
    if (opened_dialogs.length || configureOpen) return "Close the open dialog first";
    return null;
  }

  let configureOpen = $state(false);
  let closeConfiguration: (() => void) | undefined;
  let configureFailure: string | null = null;
  function activate() {
    views = []; sections = []; commands.clear(); conditions.clear(); listeners.clear(); fileListeners.length = 0; menuItems.clear(); editorToolId = null; disposed = false;
    const ctx = {
      registerSettingsSection: () => {},
      registerFileView: (view: FileViewContribution) => { views = [...views, view]; },
      registerPreviewInfo: (section: PreviewInfoContribution) => { sections = [...sections, section]; },
      registerCommand: (command: { id: string; handler: () => void | Promise<void>; when?: () => boolean }) => { commands.set(command.id, command.handler); conditions.set(command.id, command.when ?? (() => true)); },
      events: { listen: (name: string, handler: (payload: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), handler]); } },
      workspace: {
        onFilesChanged: (handler: (directories: readonly string[]) => void) => { fileListeners.push(handler); },
        toggleFileView: (id: string) => { fileView = fileView === id ? null : id; },
        getFileView: () => fileView,
        getSelection: () => entries.filter((entry) => selected.includes(entry.path)),
        captureSelection: () => () => true,
        selectFile: async () => {},
      },
    } as unknown as PluginContext;
    tracePlugin.activate(ctx);
    if (ai) openAIImagePlugin.activate({
      ...ctx,
      registerContextMenuItem: (item: { id: string; label: string; group: string; when: (entries: FileEntry[]) => boolean; handler: (entries: FileEntry[]) => void | Promise<void> }) => { menuItems.set(item.id, item); }, registerSettingsSection: () => {},
      registerImageEditorTool: (tool: { id: string; component: Component<any>; props?: Record<string, unknown> }) => { editorTool = tool; editorToolId = tool.id; },
      registerDialog: (dialog: { id: string; component: Component<any> }) => { dialogs.set(dialog.id, dialog.component); },
      openDialog: (id: string, props: Record<string, unknown> = {}) => { opened_dialogs = [...opened_dialogs, { id, props }]; },
      closeDialog: (id: string) => { opened_dialogs = opened_dialogs.filter((dialog) => dialog.id !== id); },
      presentation: { ...(editorApi ? { openImageEditor: async (request: { path: string; tool: string }) => {
        // Recorded as asked, so tests see refused requests too.
        editorCalls.push({ ...(request as object) } as { path: string; tool: string });
        const refused = imageEditorRequestError(request);
        if (refused) throw new Error(refused);
        editorSource = { path: request.path, name: request.path.split(/[\\/]/).at(-1)!, digest: "0".repeat(64), format: "PNG", referencePaths: [] };
        await new Promise<void>((resolve) => { editorClosed = resolve; });
      } } : {}), openDialog: async (id: string) => {
        if (configureFailure) throw new Error(configureFailure);
        if (id !== "image-generation.connections") throw new Error("Unknown provider dialog");
        configureOpen = true;
        await new Promise<void>((resolve) => { closeConfiguration = resolve; });
        return { reason: "closed" };
      } },
      saveSettings: async () => {},
      toast: { show: (message: string, variant = "info") => { toasts = [...toasts, { message, variant }]; }, error: (message: string) => { toasts = [...toasts, { message, variant: "error" }]; } },
      jobs: { accept: async (registration: { label: string; detail: string }, start: () => Promise<{ ok: boolean }>) => {
        const result = await start();
        if (result.ok) accepted = [...accepted, { label: registration.label, detail: registration.detail }];
        return result;
      } },
    } as unknown as PluginContext);
  }
  activate();

  backend.onChange(() => {
    entries = files();
    for (const listener of listeners.get("trace:changed") ?? []) listener("");
    for (const listener of fileListeners) listener([directory]);
  });

  const selection = $derived(entries.filter((entry) => selected.includes(entry.path)));
  const pane: FileViewPane = {
    paneId: "pane-1",
    get directory() { return directory; },
    get entries() { return entries; },
    get selection() { return selection; },
    // As the host: the cursor while it is selected, otherwise the first selected file in listing order.
    get focusedPath() { return cursor && selected.includes(cursor) ? cursor : selection[0]?.path ?? null; },
    get active() { return true; },
    get previewTarget() { return target; },
    get tileSize() { return tilePreset ? { preset: tilePreset, imagePx: TILE_IMAGE_PX[tilePreset] } : undefined; },
    // As the host's selectEntry (tauri-explorer selection.ts calculateSelection):
    // Shift selects the listing range from the anchor, Ctrl toggles, a plain click selects one.
    select(entry, modifiers = {}) {
      // The host moves its cursor even to an entry it does not list.
      cursor = entry.path;
      const clicked = entries.findIndex((other) => other.path === entry.path);
      if (clicked < 0) return;
      const from = entries.findIndex((other) => other.path === anchor);
      if (modifiers.shiftKey && from >= 0) {
        replaceSelection(entries.slice(Math.min(from, clicked), Math.max(from, clicked) + 1).map((other) => other.path));
      } else if (modifiers.ctrlKey) {
        replaceSelection(selected.includes(entry.path) ? selected.filter((path) => path !== entry.path) : [...selected, entry.path]);
        anchor = entry.path;
      } else {
        replaceSelection([entry.path]);
        anchor = entry.path;
      }
    },
    // As the host's selectPaths: listed paths only; `focus` becomes the anchor and cursor.
    setSelection(paths, focus = null) {
      const listed = new Set(entries.map((entry) => entry.path));
      const next = paths.filter((path) => listed.has(path));
      const primary = focus !== null && next.includes(focus) ? focus : next.at(-1) ?? null;
      replaceSelection(next);
      anchor = primary;
      if (primary) cursor = primary;
    },
    clearSelection() { replaceSelection([]); anchor = null; },
    async open(entry) { opened = [...opened, entry.path]; },
    contextMenu(event, entry) { event.preventDefault(); menus = [...menus, entry?.path ?? null]; },
    async navigate(path) { navigations = [...navigations, path]; },
    setPreviewTarget(next) { if (next) { replaceSelection([]); anchor = null; target = next; } else target = null; },
    exitView() { fileView = null; },
  };

  const active = $derived(enabled ? views.find((view) => view.id === fileView && (view.available?.(directory) ?? true)) ?? null : null);
  const subject = $derived<PreviewSubject | null>(target ? { kind: "target", target, pluginId: "trace", paneId: "pane-1" }
    : selection.length === 1 ? { kind: "file", entry: selection[0], paneId: "pane-1" } : null);
  const shownSections = $derived(enabled && subject ? sections.filter((section) => section.when(subject)) : []);

  async function run(action: { run(): void | Promise<void> }) {
    actionError = "";
    try { await action.run(); } catch (error) { actionError = error instanceof Error ? error.message : String(error); }
  }

  export const harness = {
    backend,
    setConfigureFailure(message: string | null) { configureFailure = message; },
    setWidth(width: number) { viewWidth = width; },
    /** Changes the pane's tile-size preset live, as the host's setting would; null removes it (an older host). */
    setTileSize(preset: TileSizePreset | null) { tilePreset = preset; },
    toggle() { return commands.get("plugin.trace.toggle")?.(); },
    disable() { enabled = false; disposed = true; tracePlugin.deactivate?.(); },
    enable() { enabled = true; activate(); },
    navigate(path: string) { directory = path; entries = path === DIRECTORY ? files() : []; selected = []; anchor = null; target = null; },
    /** Hides the Trace view and shows it again, as the host does when switching away from its tab and back: the view unmounts, and a new one mounts. */
    leaveView: () => { fileView = null; },
    enterView: () => { fileView = "trace.view"; },
    /** Forgets what each folder last showed, as if no view had shown them yet. */
    forgetFolders: () => forgetFolderSnapshots(),
    state: () => ({ selected: [...selected], cursor, target: target ? { id: target.id, title: target.title, badge: target.badge ?? null } : null, fileView, opened: [...opened], menus: [...menus], navigations: [...navigations] }),
    selectPath(path: string) { pane.setSelection([path], path); },
    /** The host replaces the selection itself (another pane, a command), as `explorer.selectPaths` does. */
    setSelection(paths: string[]) { pane.setSelection(paths); },
    /** The host's Select all: every listed file (an unchanged selection notifies nothing). */
    selectAll() { replaceSelection(entries.map((entry) => entry.path)); anchor = entries[0]?.path ?? null; },
    /** Re-sorts the listing (reversed), as choosing another sort order does: the selection is unchanged. */
    resort() { entries = [...entries].reverse(); },
    command: (id: string) => commands.get(id)?.(),
    /** Opens the image editor's AI edit on `path`, captured at `digest`, before its preview has loaded (no size yet). */
    openEditor(path: string, digest: string) { editorSource = { path, name: path.split("/").at(-1)!, digest, format: "PNG", referencePaths: [] }; },
    /** The editor's preview loaded: its source now has a size, as the host's derived source does. */
    editorLoaded(width: number, height: number) { if (editorSource) editorSource = { ...editorSource, size: { width, height } }; },
    /** The context-menu items the host would show for the selected paths, as `[id, label]`. */
    menuFor(paths: string[]) { const chosen = entries.filter((entry) => paths.includes(entry.path)); return [...menuItems].filter(([, item]) => item.when(chosen)).map(([id, item]) => [id, item.label]); },
    invokeMenu(id: string, paths: string[]) { return menuItems.get(id)?.handler(entries.filter((entry) => paths.includes(entry.path))); },
    toasts: () => toasts.map((toast) => ({ ...toast })),
    /** Closes the image editor stand-in, as the user closing the host editor would. */
    closeEditor() { editorSource = null; editorClosed?.(); editorClosed = undefined; },
    editorCalls: () => editorCalls.map((call) => ({ ...call })),
    enabled: (id: string) => conditions.get(id)?.() ?? false,
    accepted: () => [...accepted],
  };
</script>

<main style:--view-width="{viewWidth}px">
  <section class="explorer" aria-label="Explorer pane">
    {#if active}
      {@const View = active.component as Component<any>}
      <div class="file-view" data-file-view={active.id}><View {...active.props} {pane} /></div>
    {:else}
      <ul class="builtin" aria-label="Built-in listing">
        {#each entries as entry (entry.path)}<li><button type="button" class:selected={selected.includes(entry.path)} onclick={(event) => pane.select(entry, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey })}>{entry.name}</button></li>{/each}
      </ul>
    {/if}
  </section>
  <aside class="preview" aria-label="Preview">
    <header>
      {#if target}
        <h2 data-testid="preview-title">{target.title}</h2>
        {#if target.badge}<span class="badge" data-testid="preview-badge">{target.badge}</span>{/if}
        <div class="actions">
          {#each target.actions ?? [] as action (action.id)}
            <button type="button" disabled={action.disabled} title={action.title} onclick={() => run(action)}>{action.label}</button>
          {/each}
        </div>
        {#each target.details ?? [] as detail}<p class="detail">{detail.label}: {detail.value}</p>{/each}
        {#if actionError}<p role="alert">{actionError}</p>{/if}
      {:else if selection.length === 1}
        <h2 data-testid="preview-title">{selection[0].name}</h2>
      {:else if selection.length}
        <h2 data-testid="preview-title">{selection.length} items</h2>
      {/if}
    </header>
    {#if subject}
      <div class="content"><div class="image" data-testid="preview-image"></div></div>
      {#if subject.kind === "file"}
        <div class="info" data-testid="host-info">
          <div class="info-row"><span class="info-label">Size</span><span class="info-value">32 B</span></div>
          <div class="info-row"><span class="info-label">Modified</span><span class="info-value">1d</span></div>
        </div>
      {/if}
      {#if shownSections.length}
        <div class="sections">
          {#each shownSections as section (section.id)}
            {@const Section = section.component as Component<any>}
            <Section {...section.props} {subject} />
          {/each}
        </div>
      {/if}
    {/if}
  </aside>
</main>
{#if editorTool && editorSource}
  <section class="plugin-dialog" role="dialog" aria-label="AI edit">
    {#key editorTool}
      {@const Tool = editorTool.component}
      <Tool {...editorTool.props} source={editorSource} onClose={() => { editorSource = null; editorClosed?.(); editorClosed = undefined; }} onBusyChange={() => {}} />
    {/key}
  </section>
{/if}
{#each opened_dialogs as dialog (dialog)}
  {@const Dialog = dialogs.get(dialog.id)}
  {#if Dialog}<Dialog {...dialog.props} open={true} onClose={() => { opened_dialogs = opened_dialogs.filter((other) => other !== dialog); }} />{/if}
{/each}

<style>
  /* Theme tokens come from ./themes.ts (copies of host themes), set on the root element. */
  :global(body) { margin: 0; background: var(--background-solid); font: 13px system-ui; color: var(--text-primary); }
  main { display: flex; height: 100vh; }
  .explorer { display: flex; flex-direction: column; width: var(--view-width); min-width: 0; border-right: 1px solid var(--divider); background: var(--background-solid); }
  .file-view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  /* Mirrors the host's side-dock Preview (PreviewPane.svelte). */
  .preview { --preview-info-inset: 16px; display: flex; flex-direction: column; flex: 1; min-width: 240px; overflow: hidden; background: var(--background-card-secondary); }
  header { flex-shrink: 0; padding: 12px var(--preview-info-inset); }
  .content { display: flex; align-items: center; justify-content: center; flex: 1; min-height: 0; padding: 12px; }
  .image { width: 100%; max-height: 100%; aspect-ratio: 3 / 2; border-radius: 8px; background: var(--accent); }
  .info { flex-shrink: 0; border-top: 1px solid var(--divider); }
  .info-row { display: flex; justify-content: space-between; gap: 8px; padding: 8px var(--preview-info-inset); font-size: var(--font-size-caption); border-bottom: 1px solid var(--divider); }
  .info-row:last-child { border-bottom: none; }
  .info-label { color: var(--text-tertiary); }
  .info-value { color: var(--text-secondary); }
  .sections { flex: 0 1 auto; max-height: 55%; overflow: auto; border-top: 1px solid var(--divider); }
  .builtin { margin: 0; padding: 12px; list-style: none; }
  .builtin .selected { outline: 2px solid var(--accent); }
  .badge { padding: 0 6px; border: 1px solid #a76d24; border-radius: 8px; color: #865413; font-size: 11px; }
  .actions { display: flex; gap: 6px; margin: 8px 0; }
  h2 { margin: 0 0 6px; font-size: 14px; }
</style>

{#if configureOpen}
  <div role="dialog" aria-label="Image connections" aria-modal="true" style="position:fixed;inset:10%;z-index:20;background:var(--background-solid);padding:20px">
    <h2>Image connections</h2>
    <button onclick={() => { backend.configureImages(); configureOpen = false; closeConfiguration?.(); }}>Use custom connection</button>
    <button onclick={() => { configureOpen = false; closeConfiguration?.(); }}>Close connections</button>
  </div>
{/if}
