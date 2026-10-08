<script lang="ts">
  /**
   * One connected component: plans the scene for the current focus, lays it
   * out (synchronously when small, otherwise off-thread with stale results
   * discarded) and animates from whatever geometry is currently displayed.
   * Tiles and routes always render from the same committed plan + layout pair.
   */
  import { tick } from "svelte";
  import type { NodeKey } from "$lib/domain/trace-graph/model";
  import { planScene, routeStyle, junctionRelated, type RouteStyle, type ScenePlan } from "$lib/domain/trace-graph/scene";
  import { nearestInDirection, type Direction, type GraphLayout } from "$lib/domain/trace-graph/layout";
  import { endpointKey } from "$lib/domain/trace-graph/junctions";
  import { promptTitles } from "../prompt-titles.svelte";
  import type { ComponentData } from "./folder-session.svelte";
  import { cachedLayout, computeLayout, layoutNow } from "./layout-client";
  import { captureGraph, playGraph, prefersReducedMotion, zoomOf } from "./motion";
  import { nodeTitle } from "./node-target";
  import TraceTile from "./TraceTile.svelte";

  interface Props {
    data: ComponentData;
    focus: NodeKey | null;
    selected: ReadonlySet<NodeKey>;
    width: number;
    revision: number;
    scroller: HTMLElement | null;
    onactivate: (key: NodeKey, event: MouseEvent) => void;
    onnavigate: (key: NodeKey) => void;
    onopen: (key: NodeKey) => void;
    onmenu: (key: NodeKey, event: MouseEvent) => void;
    onsaved: (key: NodeKey, path: string) => void;
    /** Selection lease for hover saves (see TraceImageActions). */
    captureSelection?: () => () => boolean;
    ondiscarded: (key: NodeKey) => void;
    /** Called after a new layout is in the DOM (motion has started), with a promise that settles when motion ends. */
    oncommit?: (settled: Promise<void>) => void;
  }

  let { data, focus, selected, width, revision, scroller, onactivate, onnavigate, onopen, onmenu, onsaved, ondiscarded, oncommit, captureSelection }: Props = $props();

  /** Below this many tiles layout runs inline; it takes well under a frame. */
  const SYNC_LIMIT = 60;
  /** Tile windowing only pays off for very large neighborhoods. */
  const WINDOW_MIN = 120;
  const WINDOW_MARGIN = 800;
  const uid = $props.id();

  let canvas = $state<HTMLElement | null>(null);
  let failure = $state("");
  // Reading order of the last committed layout keeps siblings in place across focus changes.
  let ordering: ReadonlyMap<NodeKey, number> | undefined;
  let running: Animation[] = [];
  /** Only the latest full commit plays; one superseded before rendering never starts. */
  let plays = 0;

  const plan = $derived(planScene(data.dag, data.members, focus, width, ordering));

  // The first render uses the very plan the effect below sees, so mounting
  // commits once instead of re-planning with the new reading order as a hint.
  function initial(): { plan: ScenePlan; layout: GraphLayout } | null {
    const first = plan;
    const layout = cachedLayout(first.request) ?? (first.request.items.length <= SYNC_LIMIT ? layoutNow(first.request) : null);
    if (layout) ordering = layout.readingOrder;
    return layout ? { plan: first, layout } : null;
  }
  let shown = $state.raw(initial());

  function commit(next: ScenePlan, layout: GraphLayout): void {
    if (shown && shown.plan === next && shown.layout === layout) return;
    // Same geometry (only tones or selection changed): nothing moves, so
    // motion still running carries on and nothing is measured.
    if (shown && shown.layout === layout) {
      shown = { plan: next, layout };
      failure = "";
      // After any pending full commit has started its motion, so `settled` waits for it.
      void tick().then(() => oncommit?.(Promise.allSettled(running.map((animation) => animation.finished)).then(() => {})));
      return;
    }
    const element = canvas;
    const before = element && shown && !prefersReducedMotion() ? captureGraph(element) : null;
    for (const animation of running) animation.cancel();
    running = [];
    shown = { plan: next, layout };
    ordering = layout.readingOrder;
    failure = "";
    const current = ++plays;
    void tick().then(() => {
      if (current !== plays) return;
      if (before && canvas) running = playGraph(canvas, before);
      oncommit?.(Promise.allSettled(running.map((animation) => animation.finished)).then(() => {}));
    });
  }

  $effect(() => {
    const next = plan;
    const ready = cachedLayout(next.request) ?? (next.request.items.length <= SYNC_LIMIT ? layoutNow(next.request) : null);
    if (ready) { commit(next, ready); return; }
    let live = true;
    const superseded = new AbortController();
    computeLayout(next.request, superseded.signal).then(
      (layout) => { if (live) commit(next, layout); },
      (error: Error) => { if (live) failure = error.message; },
    );
    return () => { live = false; superseded.abort(); };
  });

  // Windowing: only tiles near the scroller's viewport are mounted.
  let band = $state.raw<{ top: number; bottom: number } | null>(null);
  $effect(() => {
    const element = canvas, container = scroller;
    if (!element || !container || (shown?.plan.tiles.size ?? 0) <= WINDOW_MIN) { band = null; return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      // Rects may be in zoomed pixels; the band is in the canvas's own.
      const box = element.getBoundingClientRect(), view = container.getBoundingClientRect(), zoom = zoomOf(element, box);
      const top = Math.floor(((view.top - box.top) / zoom - WINDOW_MARGIN) / 200) * 200;
      const bottom = Math.ceil(((view.bottom - box.top) / zoom + WINDOW_MARGIN) / 200) * 200;
      if (band?.top !== top || band?.bottom !== bottom) band = { top, bottom };
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    container.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => { container.removeEventListener("scroll", schedule); observer.disconnect(); cancelAnimationFrame(frame); };
  });

  const visibleTiles = $derived.by(() => {
    if (!shown) return [];
    const { plan: current, layout } = shown;
    return [...current.tiles.values()].filter((tile) => {
      const placed = layout.nodes.get(tile.key);
      if (!placed) return false;
      if (!band || tile.key === current.lineage.focus || selected.has(tile.key)) return true;
      return placed.y + placed.height >= band.top && placed.y <= band.bottom;
    });
  });

  // With a focus, its lineage (the selected branch) is drawn with more contrast than the rest.
  const branch = $derived(!!shown && shown.plan.lineage.focus !== null);
  /** A line's colour: highlight and branch (with a focus) win over the route's scope. */
  const MARKER_TONES = ["", "subfolder", "external", "branch", "highlight"] as const;
  const lineTone = (style: RouteStyle): (typeof MARKER_TONES)[number] =>
    style.highlighted ? "highlight" : branch && style.related ? "branch" : style.kind === "current" ? "" : style.kind;
  // Each connector's vertical extent, so windowing can skip far-away ones too.
  const extents = $derived(shown ? new Map(shown.layout.routes.map((route) => [route.id, verticalExtent(route.path)])) : new Map<string, [number, number]>());
  const inBand = (top: number, bottom: number) => !band || (bottom >= band.top && top <= band.bottom);
  const routes = $derived(shown ? shown.layout.routes
    .filter((route) => inBand(...extents.get(route.id)!))
    .map((route) => ({ route, style: routeStyle(route, data.dag, shown!.plan.lineage) })) : []);
  const junctions = $derived(shown ? [...shown.layout.junctions.values()].filter((junction) => inBand(junction.y, junction.y)) : []);
  const junctionTitle = (parents: readonly NodeKey[]) => `Combined inputs: ${parents.map((key) => {
    const node = data.dag.nodes.get(key);
    return node ? promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node) : key;
  }).join(", ")}`;

  function verticalExtent(path: string): [number, number] {
    // Paths are absolute M/L/C commands, so every second number is a y coordinate.
    const numbers = path.match(/-?\d+(?:\.\d+)?/g) ?? [];
    let top = Infinity, bottom = -Infinity;
    for (let index = 1; index < numbers.length; index += 2) {
      const y = Number(numbers[index]);
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    return [top, bottom];
  }

  const DIRECTIONS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
  function keydown(key: NodeKey, event: KeyboardEvent): void {
    if (event.key === "Enter") { event.preventDefault(); onopen(key); return; }
    const direction = DIRECTIONS[event.key];
    if (!direction || !shown || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const next = nearestInDirection(shown.layout, key, direction);
    if (!next) return;
    onnavigate(next);
    // The view reveals the new tile once it has moved; focusing must not scroll first.
    void tick().then(() => canvas?.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(next)}"]`)?.focus({ preventScroll: true }));
  }
</script>

{#if shown && failure}
  <!-- The graph shown is stale: say so rather than leave it looking current. -->
  <div class="pending stale" role="alert">Trace layout failed: {failure}</div>
{/if}
{#if shown}
  <div class="graph" bind:this={canvas} style:width="{shown.layout.width}px" style:height="{shown.layout.height}px">
    <svg class="edges" width={shown.layout.width} height={shown.layout.height} aria-hidden="true">
      <defs>
        <!-- One arrowhead per line colour, so every arrowhead matches its line. -->
        {#each MARKER_TONES as tone (tone)}
          <marker id="arrow-{uid}{tone ? `-${tone}` : ""}" class={tone} viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
            <polygon points="0,0 6,3 0,6" />
          </marker>
        {/each}
      </defs>
      <!-- Motion's fading copies of departed connectors and junctions (motion.ts); Svelte keeps it empty. -->
      <g class="ghosts" data-motion-ghosts></g>
      {#each routes as { route, style } (route.id)}
        {@const tone = lineTone(style)}
        <path class={style.kind} class:unrelated={!style.related} class:branch={branch && style.related} class:highlight={style.highlighted}
          data-route={route.id} data-from={endpointKey(route.from)} data-to={endpointKey(route.to)}
          marker-end={route.terminal ? `url(#arrow-${uid}${tone ? `-${tone}` : ""})` : undefined} d={route.path} />
      {/each}
      {#each junctions as junction (junction.id)}
        <circle class="junction" class:highlight={junctionRelated(junction.parents, shown.plan.lineage)}
          data-junction={junction.id} cx={junction.x} cy={junction.y} r="2.8"><title>{junctionTitle(junction.parents)}</title></circle>
      {/each}
    </svg>
    <!-- Motion's fading copies of departed tiles (motion.ts); Svelte keeps it empty. -->
    <div class="ghosts" data-motion-ghosts aria-hidden="true" inert></div>
    {#each visibleTiles as tile (tile.key)}
      <TraceTile {tile} placed={shown.layout.nodes.get(tile.key)!} selected={selected.has(tile.key)} {revision}
        onactivate={(event) => onactivate(tile.key, event)} onopen={() => onopen(tile.key)}
        onmenu={(event) => onmenu(tile.key, event)} onkey={(event) => keydown(tile.key, event)}
        {captureSelection} onsaved={(path) => onsaved(tile.key, path)} ondiscarded={() => ondiscarded(tile.key)} />
    {/each}
  </div>
{:else}
  <div class="pending" role="status">{failure ? `Trace layout failed: ${failure}` : "Arranging…"}</div>
{/if}

<style>
  .graph { position: relative; margin: 0 auto; }
  .edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  /*
   * Line colours, one per tone. Lines, their arrowheads and junction dots read
   * the same property, so they always match. Only tokens every host theme
   * defines are used without a fallback (see integration/plugin-sdk/theme-tokens.ts).
   */
  .edges {
    --edge: var(--trace-edge, color-mix(in srgb, var(--text-secondary) 55%, transparent));
    --edge-subfolder: var(--trace-edge-subfolder, color-mix(in srgb, var(--accent) 45%, var(--text-secondary)));
    --edge-external: var(--trace-edge-external, color-mix(in srgb, var(--system-caution-text, var(--system-caution)) 70%, var(--text-secondary)));
    --edge-branch: var(--trace-edge-branch, color-mix(in srgb, var(--text-primary) 72%, transparent));
    --edge-highlight: var(--trace-edge-highlight, var(--accent));
  }
  .edges path { fill: none; stroke: var(--edge); stroke-width: 1.35; }
  .edges path.subfolder { stroke: var(--edge-subfolder); }
  .edges path.external { stroke: var(--edge-external); stroke-dasharray: 4 3; }
  .edges path.branch { stroke: var(--edge-branch); stroke-width: 1.6; }
  .edges path.highlight { stroke: var(--edge-highlight); stroke-width: 2.3; }
  .edges path.unrelated { opacity: .4; }
  .edges marker polygon { fill: var(--edge); }
  .edges marker.subfolder polygon { fill: var(--edge-subfolder); }
  .edges marker.external polygon { fill: var(--edge-external); }
  .edges marker.branch polygon { fill: var(--edge-branch); }
  .edges marker.highlight polygon { fill: var(--edge-highlight); }
  .junction { fill: color-mix(in srgb, var(--text-secondary) 75%, transparent); stroke: var(--background-solid); stroke-width: 1; pointer-events: auto; }
  .junction.highlight { fill: var(--edge-highlight); }
  .ghosts { pointer-events: none; }
  div.ghosts { position: absolute; inset: 0; }
  .pending { padding: 18px 12px; color: var(--text-secondary); font-size: 12px; }
  .pending.stale { padding: 4px 12px; }
</style>
