<script lang="ts">
  /**
   * The folder grid, drawn from the scene controller's publication: every cell, cover, band and
   * row background exactly as the committed layout placed them, and the publication's retiring
   * exit groups. A renderer only; the controller prepares and commits scenes, and starts this
   * grid's native motion driver (`scene-motion.ts`, attached with `attachMotion`) once per
   * presentation epoch. Every element motion may move is registered as a render handle.
   */
  import { tick, untrack } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ComponentFocus } from "$lib/domain/trace-graph/scene";
  import type { FolderCell } from "$lib/domain/trace-graph/folder-grid";
  import { entityId } from "$lib/domain/trace-graph/folder-scene";
  import type { FileViewPane } from "../../../../../integration/plugin-sdk";
  import { hostFileTile } from "../../../../sdk";
  import type { Publication, PreparationNotice, SceneController } from "./scene-controller.svelte";
  import { selectableSelector } from "./selectable";
  import { gridNeighbor, rovingStop } from "./stack-grid";
  import { zoomOf } from "./motion";
  import { componentNodes, graphOwning, recordsByGraph } from "./scene-view";
  import { NO_GRAPH, presentationView } from "./presentation-view";
  import { createRenderHandles, GRID, sectionKey } from "./render-handles";
  import { createSceneMotion } from "./scene-motion";
  import { PARTICIPANT_MARGIN } from "./participants";
  import RetiringBand from "./RetiringBand.svelte";
  import TraceGraph from "./TraceGraph.svelte";
  import TraceTile from "./TraceTile.svelte";
  import OrdinaryTile from "./OrdinaryTile.svelte";

  let { pane, controller, publication, notices, gridPadding, focus, revision, scroller, onstack, onactivate, onnavigate, onopen, onmenu,
    onselect, onordinarymenu, onbadgehover, onretry, captureSelection, onsaved, ondiscarded }: {
    pane: FileViewPane; controller: SceneController; publication: Publication; notices: ReadonlyMap<string, PreparationNotice>;
    /** The host grid padding the published scene was laid out with. */
    gridPadding: number;
    /** The live focus, for the section's `dimmed` marker only. */
    focus: ComponentFocus | null;
    revision: number; scroller: HTMLElement | null;
    /** Pressing a stack's cover (`toggle` false: selects, and opens a closed stack) or its disclosure (`toggle`: closes a requested, opening or failed stack). */
    onstack: (cell: FolderCell, event: MouseEvent, toggle: boolean) => void;
    onactivate: (key: string, event: MouseEvent, componentId: string) => void;
    onnavigate: (key: string, componentId: string, modifiers?: { shiftKey?: boolean }) => void; onopen: (key: string) => void;
    onmenu: (key: string, event: MouseEvent, componentId: string) => void;
    onselect: (entry: FileEntry, event: MouseEvent) => void; onordinarymenu: (entry: FileEntry, event: MouseEvent) => void;
    onbadgehover: (key: string | null) => void; onretry: (coverKey: string) => void;
    captureSelection: () => () => boolean; onsaved: (key: string, path: string, select: boolean) => void; ondiscarded: (key: string) => void;
  } = $props();
  const host = hostFileTile();
  const HostTile = host?.default;
  /** Cells within this of the viewport stay mounted (the same margin selects motion participants). */
  const WINDOW_MARGIN = PARTICIPANT_MARGIN;
  let grid = $state<HTMLElement | null>(null);
  let viewport = $state.raw({ top: 0, bottom: 2000 });
  let failedVideoPaths = $state.raw<ReadonlySet<string>>(new Set());
  let tabStop = $state<string | null>(null);

  const scene = $derived(publication.scene);
  const presented = $derived(presentationView(publication.presentation));
  const layout = $derived(scene.layout);
  const cells = $derived(scene.cells);
  const styling = $derived(scene.inputs.styling);
  const grouped = $derived(recordsByGraph(scene));
  const bandById = $derived(new Map(layout.bands.map((band) => [band.id, band])));
  const rowCount = $derived(Math.max(0, ...[...layout.cells.values()].map((cell) => cell.row + 1)));
  const cover = $derived(styling.cover ?? { imagePx: null, small: false });

  // Roving tabindex: the stop always names a rendered cell. It follows the last focused cell while
  // that is drawn; once it leaves (a deselected band tile, a merged stack) it falls to the stack that held it.
  const stops = $derived(new Set([...cells.map((cell) => cell.id), ...[...scene.graphs.values()].flatMap((graph) => [...graph.plan.tiles.keys()])]));
  const stop = $derived(rovingStop(tabStop, stops, (key) => graphOwning(scene, key), cells[0]?.id ?? null));
  // Windowing selects records of the published scene: cells near the viewport, the keyboard stop and the focus, and
  // whatever is moving this epoch (pinned until it settles). A cell mounted later shows its target pose and starts nothing.
  const nearRect = (top: number, height: number) => top + height >= viewport.top - WINDOW_MARGIN && top <= viewport.bottom + WINDOW_MARGIN;
  const holdsStop = (id: string) => stop !== null && !!scene.inputs.layoutInput.open.get(id)?.graph.dag.nodes.has(stop);
  const pinned = $derived(publication.presentation.pinned);
  const pinnedCell = (cell: FolderCell) => cell.summary ? pinned.has(entityId("tile", cell.id, cell.id)) || presented.pinnedGraphs.has(cell.id)
    : !!cell.entry && pinned.has(entityId("entry", null, cell.entry.path));
  const visible = $derived(cells.filter((cell) => {
    const rect = layout.cells.get(cell.id)!;
    const band = bandById.get(cell.id);
    return stop === cell.id || holdsStop(cell.id) || nearRect(rect.y, band ? band.y + band.height - rect.y : rect.height) || (!!cell.summary && cell.summary.id === focus?.componentId)
      || pinnedCell(cell);
  }));
  $effect(() => {
    const container = scroller, element = grid;
    if (!container || !element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const view = container.getBoundingClientRect(), rect = element.getBoundingClientRect(), zoom = zoomOf(element, rect);
      const top = Math.floor((view.top - rect.top) / zoom / 200) * 200;
      const bottom = Math.ceil((view.bottom - rect.top) / zoom / 200) * 200;
      if (top !== viewport.top || bottom !== viewport.bottom) viewport = { top, bottom };
    };
    // Resizes are applied on the next frame, as TraceGraph's window is: re-rendering inside the
    // ResizeObserver callback can resize the scroller again and loses its notifications.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update(); container.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule); observer.observe(container);
    return () => { container.removeEventListener("scroll", schedule); observer.disconnect(); cancelAnimationFrame(frame); };
  });

  // Native motion: the controller samples and starts it once per presentation epoch.
  const handles = createRenderHandles();
  const motion = createSceneMotion({ handles, scroller: () => scroller });
  $effect(() => untrack(() => controller.attachMotion(motion)));

  // Keyboard focus belongs to the grid until it genuinely leaves (a blur to another element or the page).
  // Removing the focused element fires no blur, so a cover replaced by a toggle, a band tile that leaves
  // the neighbourhood, or a stack that merges away leaves focus on <body>: move it to the surviving stop.
  let focusInside = false;
  function focusout(event: FocusEvent): void {
    const target = event.target as Element, to = event.relatedTarget;
    if (to instanceof Node && grid?.contains(to)) return;
    // A blur caused by removing the element has already disconnected it once the event's turn ends.
    queueMicrotask(() => { if (target.isConnected) focusInside = false; });
  }
  $effect(() => {
    void visible; void scene; void stop;
    if (!focusInside) return;
    void tick().then(() => {
      const active = document.activeElement;
      if (!focusInside || !stop || (active && active !== document.body)) return;
      grid?.querySelector<HTMLElement>(`${selectableSelector(stop)}, [data-entry-path="${CSS.escape(stop)}"]`)?.focus({ preventScroll: true });
    });
  });
  function keydown(key: string, event: KeyboardEvent): void {
    const target = event.target;
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey
      || (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select")))) return;
    if (event.key === "Enter") {
      event.preventDefault(); const cell = cells.find((cell) => cell.id === key);
      if (cell?.entry) void pane.open(cell.entry); else onopen(key);
      return;
    }
    if (!grid) return;
    // Navigation targets come from the committed scene, mounted or not.
    const next = gridNeighbor(scene.navigation, key, event.key);
    if (!next) return;
    event.preventDefault(); tabStop = next;
    const cell = cells.find((cell) => cell.id === next || cell.entry?.path === next);
    const press = new MouseEvent("click", { shiftKey: event.shiftKey });
    if (cell?.summary) onstack(cell, press, false);
    else if (cell?.entry) onselect(cell.entry, press);
    else {
      const owner = graphOwning(scene, next);
      const componentId = owner ? scene.graphs.get(owner)?.componentId : undefined;
      if (componentId) onnavigate(next, componentId, { shiftKey: event.shiftKey });
    }
    void tick().then(() => {
      const element = grid?.querySelector<HTMLElement>(`${selectableSelector(next)}, [data-entry-path="${CSS.escape(next)}"]`);
      element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
</script>

<div class="grid" role="grid" aria-label="Folder" aria-multiselectable="true" aria-colcount={layout.columns} aria-rowcount={rowCount}
  bind:this={grid} {@attach handles.attach(GRID)} onfocusin={() => focusInside = true} onfocusout={focusout} style:margin="{gridPadding}px" style:width="{layout.size.width}px" style:height="{layout.size.height}px">
  {#each layout.rowBands as row (row.id)}
    <div class="row-band" data-grid-row-band={row.row} {@attach handles.attach(entityId("row", null, String(row.row)))} style:top="{row.y}px" style:width="{row.width}px" style:height="{row.height}px"></div>
  {/each}
  {#each visible as cell (cell.id)}
    {@const rect = layout.cells.get(cell.id)!}
    {@const band = bandById.get(cell.id)}
    {@const summary = cell.summary}
    {#if summary}
      {@const record = scene.tiles.get(entityId("tile", cell.id, cell.id))!}
      {@const graph = scene.graphs.get(cell.id)}
      {@const nodes = componentNodes(scene, cell.id)}
      {@const notice = notices.get(cell.id)}
      {@const placement = graph?.placement}
      <section class="component" class:dimmed={focus !== null && focus.componentId !== summary.id} data-stack-count={`${summary.imageCount} images`} data-component={summary.id} data-grid-motion={cell.id} aria-label={summary.title} {@attach handles.attach(sectionKey(cell.id))}
        style:top="{rect.y}px" style:height="{band ? band.y + band.height - rect.y : rect.height}px">
        <div class="cell stack" role="row" aria-rowindex={rect.row + 1} data-grid-cell={cell.id} data-stack-key={cell.id} {@attach handles.attach(record.id)}
          style:left="{rect.x}px" style:width="{rect.width}px" style:height="{rect.height}px">
          <TraceTile tile={record.tile} placed={record.placed}
            explorer={{ name: record.cover?.name ?? summary.title, count: record.cover?.count ?? summary.imageCount, expanded: !!graph, unsaved: record.cover?.unsaved ?? summary.unsaved, active: record.cover?.active ?? summary.active,
              imagePx: cover.imagePx ?? undefined, small: cover.small, progress: notice?.phase ?? null, error: notice?.message ?? null }}
            selected={record.selected} {revision} badgeNodes={nodes} badges={record.badges} badgeSelection={styling.selectedKeys}
            onbadge={(key, event) => onactivate(key, event, summary.id)} {onbadgehover} focused={stop === cell.id} onfocus={() => tabStop = cell.id} onstacktoggle={(event) => onstack(cell, event, true)}
            onactivate={(event) => graph ? onactivate(cell.id, event, summary.id) : onstack(cell, event, false)}
            onopen={() => { if (!graph && cell.entry) void pane.open(cell.entry); else onopen(cell.id); }}
            onmenu={(event) => { if (!graph && cell.entry) onordinarymenu(cell.entry, event); else onmenu(cell.id, event, summary.id); }}
            onkey={(event) => keydown(cell.id, event)} {captureSelection} onsaved={(path, select) => onsaved(cell.id, path, select)} ondiscarded={() => ondiscarded(cell.id)}
            onretry={() => onretry(cell.id)} />
        </div>
        {#if band && graph && placement && nodes}
          <div class="content" data-grid-band={cell.id} data-grid-band-row={band.row} data-group-left={placement.left} data-group-width={placement.right - placement.left} data-child-group-left={band.x} data-child-group-width={band.width} data-horizontal-scroll style:height="{band.y + band.height - rect.y}px">
            {#if nearRect(band.y, band.height) || focus?.componentId === summary.id || holdsStop(cell.id) || presented.pinnedGraphs.has(cell.id)}
              <TraceGraph {graph} records={grouped.get(cell.id)!} presented={presented.graphs.get(cell.id) ?? NO_GRAPH} {pinned} {handles} {nodes} focusedKey={stop ?? undefined} onfocuskey={(key) => tabStop = key} {onbadgehover} selected={styling.selectedKeys} {revision} {scroller}
                ongridkey={keydown} onactivate={(key, event) => onactivate(key, event, summary.id)} {onopen}
                onmenu={(key, event) => onmenu(key, event, summary.id)} {captureSelection} {onsaved} {ondiscarded} />
            {/if}
          </div>
        {/if}
      </section>
    {:else if cell.entry}
      {@const entry = scene.entries.get(cell.entry.path)}
      <div class="cell" role="row" aria-rowindex={rect.row + 1} data-grid-cell={cell.id} data-grid-motion={cell.id} {@attach handles.attach(entityId("entry", null, cell.entry.path))}
        style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.width}px" style:height="{rect.height}px">
        {#if HostTile}<HostTile entry={cell.entry} selected={entry?.selected ?? false} focused={stop === cell.id}
          column={rect.col + 1} size={pane.tileSize?.preset} onfocus={() => tabStop = cell.id} onkeydown={(event) => keydown(cell.id, event)}
          videoUnavailable={failedVideoPaths.has(cell.entry.path)} onvideounavailable={(entry) => failedVideoPaths = new Set(failedVideoPaths).add(entry.path)}
          {onselect} onopen={(entry) => void pane.open(entry)} onmenu={onordinarymenu} />
        {:else}<OrdinaryTile entry={cell.entry} selected={entry?.selected ?? false} focused={stop === cell.id} column={rect.col + 1}
          tile={scene.tile} {revision} onfocus={() => tabStop = cell.id} onkeydown={(event) => keydown(cell.id, event)} {onselect} onopen={(entry) => void pane.open(entry)} onmenu={onordinarymenu} />{/if}
      </div>
    {/if}
  {/each}
  {#each presented.exits as exit (exit.group.renderId)}
    <RetiringBand {exit} {handles} {revision} />
  {/each}
</div>
<style>
  /* Motion travels tiles and ghosts outside the grid mid-flight; that must not toggle the view's horizontal scrollbar. */
  .grid { position: relative; overflow-x: clip; }
  .component { position: absolute; left: 0; width: 100%; pointer-events: none; }
  .cell { position: absolute; top: 0; pointer-events: auto; z-index: 2; }
  .content { position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; }
  .content :global(.tile) { pointer-events: auto; }
  .row-band { position: absolute; left: 0; pointer-events: none; transform-origin: top left; background: color-mix(in srgb, var(--accent) 3%, transparent); }
</style>
