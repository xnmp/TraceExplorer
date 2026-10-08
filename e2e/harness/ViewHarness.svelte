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

  function activate() {
    views = []; sections = []; commands.clear(); conditions.clear(); listeners.clear(); fileListeners.length = 0;
    const ctx = {
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
      registerContextMenuItem: () => {}, registerSettingsSection: () => {},
      registerImageEditorTool: (tool: { component: Component<any>; props?: Record<string, unknown> }) => { editorTool = tool; },
      registerDialog: (dialog: { id: string; component: Component<any> }) => { dialogs.set(dialog.id, dialog.component); },
      openDialog: (id: string, props: Record<string, unknown> = {}) => { opened_dialogs = [...opened_dialogs, { id, props }]; },
      closeDialog: (id: string) => { opened_dialogs = opened_dialogs.filter((dialog) => dialog.id !== id); },
      storage: { get: async () => ({ backend: "codex", codexPath: "/opt/codex" }), set: async () => {} },
      saveSettings: async () => {},
      toast: { show: () => {}, error: () => {} },
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
    get focusedPath() { return cursor && selected.includes(cursor) ? cursor : selected[0] ?? null; },
    get active() { return true; },
    get previewTarget() { return target; },
    get tileSize() { return tilePreset ? { preset: tilePreset, imagePx: TILE_IMAGE_PX[tilePreset] } : undefined; },
    select(entry, modifiers = {}) {
      target = null;
      if (modifiers.ctrlKey || modifiers.shiftKey) selected = selected.includes(entry.path) ? selected.filter((path) => path !== entry.path) : [...selected, entry.path];
      else selected = [entry.path];
      cursor = entry.path;
    },
    setSelection(paths, focus = null) {
      const listed = new Set(entries.map((entry) => entry.path));
      selected = paths.filter((path) => listed.has(path));
      cursor = focus ?? selected.at(-1) ?? null;
      if (selected.length) target = null;
    },
    clearSelection() { selected = []; },
    async open(entry) { opened = [...opened, entry.path]; },
    contextMenu(event, entry) { event.preventDefault(); menus = [...menus, entry?.path ?? null]; },
    async navigate(path) { navigations = [...navigations, path]; },
    setPreviewTarget(next) { if (next) { selected = []; target = next; } else target = null; },
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
    setWidth(width: number) { viewWidth = width; },
    /** Changes the pane's tile-size preset live, as the host's setting would; null removes it (an older host). */
    setTileSize(preset: TileSizePreset | null) { tilePreset = preset; },
    toggle() { return commands.get("plugin.trace.toggle")?.(); },
    disable() { enabled = false; tracePlugin.deactivate?.(); },
    enable() { enabled = true; activate(); },
    navigate(path: string) { directory = path; entries = path === DIRECTORY ? files() : []; selected = []; target = null; },
    state: () => ({ selected: [...selected], cursor, target: target ? { id: target.id, title: target.title, badge: target.badge ?? null } : null, fileView, opened: [...opened], menus: [...menus], navigations: [...navigations] }),
    selectPath(path: string) { pane.setSelection([path], path); },
    command: (id: string) => commands.get(id)?.(),
    /** Opens the image editor's AI edit on `path`, captured at `digest`, before its preview has loaded (no size yet). */
    openEditor(path: string, digest: string) { editorSource = { path, name: path.split("/").at(-1)!, digest, format: "PNG", referencePaths: [] }; },
    /** The editor's preview loaded: its source now has a size, as the host's derived source does. */
    editorLoaded(width: number, height: number) { if (editorSource) editorSource = { ...editorSource, size: { width, height } }; },
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
      <Tool {...editorTool.props} source={editorSource} onClose={() => { editorSource = null; }} onBusyChange={() => {}} />
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
