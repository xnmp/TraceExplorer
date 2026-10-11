<script lang="ts">
  import { tick, untrack, onDestroy } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ComponentFocus, BandScenePlan, SceneTile } from "$lib/domain/trace-graph/scene";
  import type { GraphLayout } from "$lib/domain/trace-graph/layout";
  import { gridFlow } from "$lib/domain/trace-graph/grid-flow";
  import { tileSize, type TileMetrics } from "$lib/domain/trace-graph/metrics";
  import type { FileViewPane } from "../../../../../integration/plugin-sdk";
  import { hostFileTile } from "../../../../sdk";
  import type { FolderSession } from "./folder-session.svelte";
  import type { GraphScene } from "./graph-commit";
  import { selectableSelector } from "./selectable";
  import { type FolderCell, folderCells, unlistedCovers, coverNode, gridNeighbor, attachBand, gridPins, rovingStop } from "./stack-grid";
  import { captureGrid, playGrid, prefersReducedMotion, zoomOf } from "./motion";
  import TraceGraph from "./TraceGraph.svelte";
  import TraceTile from "./TraceTile.svelte";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import OrdinaryTile from "./OrdinaryTile.svelte";

  let { pane, session, focus, selected, tile, revision, scroller, width, openKeys, claimedPaths, onexpand, onnear,
    onactivate, onnavigate, onopen, onmenu, onselect, onordinarymenu, captureSelection, onsaved, ondiscarded,
    oncommit, onlayout, onfailure, reveal }: {
    pane: FileViewPane; session: FolderSession; focus: ComponentFocus | null; selected: ReadonlySet<string>; tile: TileMetrics;
    revision: number; scroller: HTMLElement | null; width: number; openKeys: ReadonlySet<string>; claimedPaths: ReadonlySet<string>;
    onexpand: (id: string, open: boolean) => void; onnear: (ids: ReadonlySet<string>) => void;
    onactivate: (key: string, event: MouseEvent, componentId: string) => void;
    onnavigate: (key: string, componentId: string, modifiers?: { shiftKey?: boolean }) => void; onopen: (key: string) => void;
    onmenu: (key: string, event: MouseEvent, componentId: string) => void;
    onselect: (entry: FileEntry, event: MouseEvent) => void; onordinarymenu: (entry: FileEntry, event: MouseEvent) => void;
    captureSelection: () => () => boolean; onsaved: (key: string, path: string, select: boolean) => void; ondiscarded: (key: string) => void;
    oncommit: (scene: GraphScene) => void; onlayout: (id: string, pending: boolean) => void;
    onfailure: (scene: GraphScene, error: Error) => void; reveal: object | null;
  } = $props();
  const host = hostFileTile();
  const HostTile = host?.default;
  let grid = $state<HTMLElement | null>(null);
  let viewport = $state.raw({ top: 0, bottom: 2000 });
  let heights = $state.raw<ReadonlyMap<string, number>>(new Map());
  let covers = $state.raw<ReadonlyMap<string, { plan: BandScenePlan; layout: GraphLayout }>>(new Map());
  let hoveredBadge = $state<string | null>(null);
  let failedVideoPaths = $state.raw<ReadonlySet<string>>(new Set());
  let tabStop = $state<string | null>(null);
  /** Whether the listed file is the cover revision itself: an in-place edit's file holds its newest revision, so the earlier cover is selected as a node. */
  const listsCover = (cell: { entry?: { path: string }; coverKey?: string }) =>
    !!cell.entry && session.index?.members.get(cell.entry.path)?.key === cell.coverKey;
  /** Pressing a closed stack, by mouse or keyboard: select what its open cover selects, then open it. */
  function activateStack(cell: FolderCell, event: MouseEvent, toggle = false): void {
    const summary = cell.summary!;
    // Open means the next press closes, whether or not the stack's data has arrived (or failed to).
    if (toggle && openKeys.has(cell.id)) { onexpand(summary.id, false); return; }
    if (cell.entry && listsCover(cell)) onselect(cell.entry, event); else onactivate(cell.id, event, summary.id);
    onexpand(summary.id, true);
  }
  let running: Animation[] = [];
  let motion = 0;
  /** Stacks that have been unsaved since the grid was last laid out afresh: they keep their cell when saved. */
  let held = $state.raw<ReadonlySet<string>>(new Set());
  const cells = $derived(session.index ? folderCells(pane.entries, session.index, held, claimedPaths) : []);
  const metrics = $derived(host?.tileGridMetrics(pane.tileSize?.preset) ?? { cellWidth: tile.width, cellHeight: tileSize({ foreign: false, hint: true }, tile).height, gap: 8, gridPadding: 0 });
  const innerWidth = $derived(Math.max(0, width - 2 * metrics.gridPadding));
  const columns = $derived(Math.max(1, Math.floor((innerWidth + metrics.gap) / (Math.max(metrics.cellWidth, tile.width) + metrics.gap))));
  const cellWidth = $derived(Math.max(tile.width, (innerWidth - (columns - 1) * metrics.gap) / columns));
  const cellHeight = $derived(Math.max(metrics.cellHeight, tileSize({ foreign: false, hint: true }, tile).height));
  // `held` is history, not derivable: a stack that was unsaved stays placed after the listing until the
  // grid is laid out afresh (another folder, or a new column count).
  let laidOut = "";
  $effect.pre(() => {
    const stamp = `${session.index?.directory}|${columns}`, fresh = stamp !== laidOut, kept = fresh ? new Set<string>() : untrack(() => held);
    const unlisted = unlistedCovers(cells, kept);
    untrack(() => {
      laidOut = stamp;
      const next = new Set([...kept, ...unlisted]);
      if (next.size !== held.size || [...next].some((key) => !held.has(key))) held = next;
    });
  });
  const flow = $derived(gridFlow(cells, new Map(cells.filter((cell) => cell.kind === "stack" && openKeys.has(cell.id)).map((cell) => [cell.id, heights.get(cell.id) ?? 160])), columns,
    { cellWidth, cellHeight, columnGap: metrics.gap, rowGap: metrics.gap }));
  const pins = $derived(gridPins(flow, openKeys));
  /** A band can need more than the pane (many separate inputs need routing lanes). The grid then widens and the
   * view scrolls sideways as a whole, so a cover and the routes hanging from it always move together. */
  const spread = $derived(Math.max(0, ...flow.bands.map((band) => covers.get(band.id)?.layout.width ?? 0)));
  const bridges = $derived(new Map(flow.bands.filter((band) => band.y > flow.cells.get(band.id)!.y + cellHeight).map((band) => [band.id, { top: cellHeight + 2, gutter: 4 }])));
  const bandById = $derived(new Map(flow.bands.map((band) => [band.id, band])));
  // Roving tabindex: the stop always names a rendered cell. It follows the last focused cell while
  // that is drawn; once it leaves (a deselected band tile, a merged stack) it falls to the stack that held it.
  const stops = $derived(new Set([...cells.map((cell) => cell.id),
    ...flow.bands.flatMap((band) => [...(covers.get(band.id)?.plan.tiles.keys() ?? [])])]));
  const stop = $derived(rovingStop(tabStop, stops,
    (key) => cells.find((cell) => cell.summary && session.components.get(cell.summary.id)?.dag.nodes.has(key))?.id, cells[0]?.id ?? null));
  const nearRect = (top: number, height: number) => top + height >= viewport.top - 1200 && top <= viewport.bottom + 1200;
  const visible = $derived(cells.filter((cell) => {
    const rect = flow.cells.get(cell.id)!;
    const band = bandById.get(cell.id);
    return stop === cell.id || (stop !== null && session.components.get(cell.summary?.id ?? "")?.dag.nodes.has(stop)) || nearRect(rect.y, band ? band.y + band.height - rect.y : rect.height) || cell.summary?.id === focus?.componentId;
  }));
  $effect(() => { onnear(new Set(visible.filter((cell) => cell.summary && openKeys.has(cell.id)).map((cell) => cell.summary!.id))); });
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
  $effect.pre(() => {
    void flow;
    const element = untrack(() => grid);
    if (!element) return;
    const before = prefersReducedMotion() ? null : captureGrid(element);
    for (const animation of running) animation.cancel();
    const current = ++motion;
    void tick().then(() => { if (current === motion && grid && before) running = playGrid(grid, before); });
  });
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
    void visible; void session.components; void covers; void stop;
    if (!focusInside) return;
    void tick().then(() => {
      const active = document.activeElement;
      if (!focusInside || !stop || (active && active !== document.body)) return;
      grid?.querySelector<HTMLElement>(`${selectableSelector(stop)}, [data-entry-path="${CSS.escape(stop)}"]`)?.focus({ preventScroll: true });
    });
  });
  onDestroy(() => { motion++; for (const animation of running) animation.cancel(); });
  function geometry(id: string, plan: BandScenePlan, layout: GraphLayout): void {
    const cover = layout.nodes.get(id);
    if (!cover) return;
    const height = Math.max(0, layout.height - cover.y - cover.height);
    if (heights.get(id) !== height) heights = new Map(heights).set(id, height);
    const previous = covers.get(id);
    if (previous?.plan !== plan || previous.layout !== layout) covers = new Map(covers).set(id, { plan, layout });
  }
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
    const rects = new Map<string, import("$lib/domain/trace-graph/grid-flow").GridRect>([...flow.cells].map(([id, rect]) => [id, { ...rect, x: rect.x + (rect.width - tile.width) / 2, width: tile.width }]));
    for (const band of flow.bands) {
      const known = covers.get(band.id), cell = flow.cells.get(band.id)!;
      if (!known) continue;
      const layout = attachBand(known.layout, band.id, 0, band.y - cell.y);
      for (const [id, rect] of layout.nodes) if (id !== band.id) rects.set(id, { ...rect, y: cell.y + rect.y });
    }
    const next = gridNeighbor(rects, key, event.key);
    if (!next) return;
    event.preventDefault(); tabStop = next;
    const cell = cells.find((cell) => cell.id === next || cell.entry?.path === next);
    const press = new MouseEvent("click", { shiftKey: event.shiftKey });
    if (cell?.summary) activateStack(cell, press);
    else if (cell?.entry) onselect(cell.entry, press);
    else {
      const owner = [...session.components].find(([, data]) => data.dag.nodes.has(next));
      if (owner) onnavigate(next, owner[0], { shiftKey: event.shiftKey });
    }
    void tick().then(() => {
      const element = grid?.querySelector<HTMLElement>(`${selectableSelector(next)}, [data-entry-path="${CSS.escape(next)}"]`);
      element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
</script>

<div class="grid" role="grid" aria-label="Folder" aria-multiselectable="true" aria-colcount={columns} aria-rowcount={flow.rowCount}
  bind:this={grid} onfocusin={() => focusInside = true} onfocusout={focusout} style:margin="{metrics.gridPadding}px" style:width="{Math.max(flow.width, spread)}px" style:height="{flow.height}px">
  {#each visible as cell (cell.id)}
    {@const rect = flow.cells.get(cell.id)!}
    {@const band = bandById.get(cell.id)}
    {@const summary = cell.summary}
    {#if summary}
      {@const data = session.components.get(summary.id)}
      {@const known = covers.get(cell.id)}
      {@const node = data?.dag.nodes.get(cell.id) ?? coverNode(cell)}
      {@const cover = (band ? known?.plan.tiles.get(cell.id) : undefined) ?? { key: cell.id, node, tone: focus?.key === cell.id ? "focus" : focus ? "unrelated" : "normal", size: tileSize({ foreign: false, hint: true }, tile), childCount: 0, hiddenDescendants: 0, expandable: false } as SceneTile}
      <section class="component" class:dimmed={focus !== null && focus.componentId !== summary.id} data-stack-count={`${summary.imageCount} images`} data-component={summary.id} data-grid-motion={cell.id} aria-label={summary.title}
        style:top="{rect.y}px" style:height="{band ? band.y + band.height - rect.y : rect.height}px">
        <div class="cell stack" role="row" aria-rowindex={rect.row + 1} data-grid-cell={cell.id} data-stack-key={cell.id}
          style:left="{rect.x}px" style:width="{rect.width}px" style:height="{rect.height}px" class:closed={!band} style:--stack-width="{tile.width}px" style:--stack-image="{tile.image}px">
          {#if band && data}
            <TraceTile tile={cover} placed={{ key: cell.id, x: (rect.width - tile.width) / 2, y: 0, width: tile.width, height: cover.size.height, row: 0, band: 0 }}
              selected={selected.has(cell.id)} {revision} badgeNodes={data.dag.nodes} badges={known?.plan.badges.get(cell.id) ?? []} badgeSelection={selected}
              onbadge={(key, event) => onactivate(key, event, summary.id)} onbadgehover={(key) => hoveredBadge = key} focused={stop === cell.id} onfocus={() => tabStop = cell.id} onclose={() => onexpand(summary.id, false)}
              onactivate={(event) => onactivate(cell.id, event, summary.id)} onopen={() => onopen(cell.id)} onmenu={(event) => onmenu(cell.id, event, summary.id)}
              onkey={(event) => keydown(cell.id, event)} {captureSelection} onsaved={(path, select) => onsaved(cell.id, path, select)} ondiscarded={() => ondiscarded(cell.id)} />
          {:else}
            <button type="button" class="heading" class:selected={selected.has(cell.id)} style:width="{tile.width}px" style:height="{cover.size.height}px" tabindex={stop === cell.id ? 0 : -1} onfocus={() => tabStop = cell.id} data-stack-toggle aria-expanded={!!band} data-tile-key={cell.id} data-node-key={cell.id} aria-pressed={selected.has(cell.id)}
              onclick={(event) => activateStack(cell, event, true)}
              ondblclick={() => { if (cell.entry) void pane.open(cell.entry); else onopen(cell.id); }} onkeydown={(event) => keydown(cell.id, event)}
              oncontextmenu={(event) => { if (cell.entry) onordinarymenu(cell.entry, event); else onmenu(cell.id, event, summary.id); }}>
              <span class="cover-image" style:height="{tile.image}px">{#if node.path}<TraceThumbnail path={node.path} present={summary.cover?.present ?? false} {revision} label="" />{:else}▧{/if}</span>
              <span class="name">{summary.title}</span><span class="count">{summary.imageCount} images</span>
              {#if summary.unsaved}<span class="unsaved">Unsaved</span>{/if}
            </button>
          {/if}
        </div>
        {#if band}
          <div class="content" data-grid-band={cell.id} data-horizontal-scroll style:height="{band.y + band.height - rect.y}px">
            {#if data && (nearRect(band.y, band.height) || focus?.componentId === summary.id || (stop !== null && data.dag.nodes.has(stop)))}
              <TraceGraph {data} {focus} focusedKey={stop ?? undefined} onfocuskey={(key) => tabStop = key} badgeHover={hoveredBadge} onbadgehover={(key) => hoveredBadge = key} {selected} width={flow.width} {tile} {revision} {scroller} componentId={summary.id} {reveal}
                pinned={pins.get(cell.id)!}
                bandTop={band.y - rect.y} bandBridge={bridges.get(cell.id)} ongeometry={(plan, layout) => geometry(cell.id, plan, layout)} ongridkey={keydown}
                onactivate={(key, event) => onactivate(key, event, summary.id)} onnavigate={(key) => onnavigate(key, summary.id)} {onopen}
                onmenu={(key, event) => onmenu(key, event, summary.id)} {captureSelection} {onsaved} {ondiscarded} {oncommit}
                onlayout={(pending) => onlayout(summary.id, pending)} {onfailure} />
            {:else}<div class="loading" role="status">{data ? "" : "Loading…"}</div>{/if}
          </div>
        {/if}
      </section>
    {:else if cell.entry}
      <div class="cell" role="row" aria-rowindex={rect.row + 1} data-grid-cell={cell.id} data-grid-motion={cell.id}
        style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.width}px" style:height="{rect.height}px">
        {#if HostTile}<HostTile entry={cell.entry} selected={pane.selection.some((entry) => entry.path === cell.id)} focused={stop === cell.id}
          column={rect.col + 1} size={pane.tileSize?.preset} onfocus={() => tabStop = cell.id} onkeydown={(event) => keydown(cell.id, event)}
          videoUnavailable={failedVideoPaths.has(cell.entry.path)} onvideounavailable={(entry) => failedVideoPaths = new Set(failedVideoPaths).add(entry.path)}
          {onselect} onopen={(entry) => void pane.open(entry)} onmenu={onordinarymenu} />
        {:else}<OrdinaryTile entry={cell.entry} selected={pane.selection.some((entry) => entry.path === cell.id)} focused={stop === cell.id} column={rect.col + 1}
          {tile} {revision} onfocus={() => tabStop = cell.id} onkeydown={(event) => keydown(cell.id, event)} {onselect} onopen={(entry) => void pane.open(entry)} onmenu={onordinarymenu} />{/if}
      </div>
    {/if}
  {/each}
</div>
<style>
  /* Motion travels tiles and ghosts outside the grid mid-flight; that must not toggle the view's horizontal scrollbar. */
  .grid { position: relative; overflow-x: clip; }
  .component { position: absolute; left: 0; width: 100%; pointer-events: none; }
  .cell { position: absolute; top: 0; pointer-events: auto; z-index: 2; }
  .content { position: absolute; top: 0; left: 0; width: 100%; pointer-events: none; }
  .content :global(.tile) { pointer-events: auto; }
  .content::before { content: ""; position: absolute; inset: 100px 0 0; background: color-mix(in srgb, var(--accent) 3%, transparent); box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 5%, transparent); }
  .heading { position: relative; display: flex; flex-direction: column; align-items: center; width: 100%; height: 100%; margin: 0 auto; box-sizing: border-box; padding: 5px; border: 0; background: none; color: var(--text-primary); font: inherit; cursor: pointer; }
  .stack::before, .stack::after { content: ""; position: absolute; left: calc((100% - var(--stack-width, 92px)) / 2 + 6px); width: calc(var(--stack-width, 92px) - 12px); height: var(--stack-image, 51px); top: 8px; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--background-card-secondary); transform: rotate(0); opacity: 0; z-index: -1; }
  .closed.stack::before { transform: rotate(-5deg); opacity: 1; }
  .closed.stack::after { transform: rotate(5deg); opacity: 1; }
  @media (prefers-reduced-motion: no-preference) { .stack::before, .stack::after { transition: transform 160ms cubic-bezier(.2,.8,.2,1), opacity 160ms; } }
  .heading.selected { border: 1px solid var(--accent); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--accent) 14%, var(--background-card-secondary)); }
  .heading:focus-visible { outline: 2px solid var(--focus-stroke-outer); }
  .cover-image { display: block; width: 100%; overflow: hidden; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); background: var(--background-card-secondary); pointer-events: none; }
  .cover-image :global(.thumbnail) { height: 100% !important; }
  .cover-image :global(.entry) { border: 1px solid var(--control-stroke); background: var(--background-card-secondary); }
  .cover-image :global(.name) { display: none; }
  .name { max-width: 100%; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .count { font-size: 10px; color: var(--text-secondary); }
  .unsaved { font-size: 10px; color: var(--system-caution-text, var(--system-caution)); }
  .loading { position: absolute; bottom: 50px; width: 100%; text-align: center; color: var(--text-secondary); }
</style>
