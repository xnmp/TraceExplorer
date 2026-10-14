<script lang="ts">
  /**
   * One open stack's band, drawn from the published scene: its tiles, connectors and junctions
   * exactly as the committed layout attached them. A renderer only: no planning, layout or
   * publication happens here (the scene controller owns those).
   */
  import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
  import type { RouteStyle } from "$lib/domain/trace-graph/scene";
  import type { FolderSceneGraph } from "$lib/domain/trace-graph/folder-scene";
  import { endpointKey } from "$lib/domain/trace-graph/junctions";
  import { ARROW } from "$lib/domain/trace-graph/metrics";
  import { promptTitles } from "../prompt-titles.svelte";
  import { zoomOf } from "./motion";
  import { nodeTitle } from "./node-target";
  import { graphStamps, type GraphRecords } from "./scene-view";
  import TraceTile from "./TraceTile.svelte";

  interface Props {
    graph: FolderSceneGraph;
    records: GraphRecords;
    /** The component's nodes (badge and junction titles). */
    nodes: ReadonlyMap<NodeKey, TraceNode>;
    focusedKey?: string | null;
    onfocuskey?: (key: string) => void;
    onbadgehover?: (key: string | null) => void;
    ongridkey: (key: string, event: KeyboardEvent) => void;
    selected: ReadonlySet<NodeKey>;
    revision: number;
    scroller: HTMLElement | null;
    onactivate: (key: NodeKey, event: MouseEvent) => void;
    onopen: (key: NodeKey) => void;
    onmenu: (key: NodeKey, event: MouseEvent) => void;
    onsaved: (key: NodeKey, path: string, select: boolean) => void;
    /** Selection lease for hover saves (see TraceImageActions). */
    captureSelection?: () => () => boolean;
    ondiscarded: (key: NodeKey) => void;
  }

  let { graph, records, nodes, selected, revision, scroller, onactivate, onopen, onmenu, onsaved, ondiscarded, captureSelection, ongridkey, focusedKey, onfocuskey, onbadgehover }: Props = $props();

  /** Tile windowing only pays off for very large neighborhoods. */
  const WINDOW_MIN = 120;
  const WINDOW_MARGIN = 800;
  const uid = $props.id();

  let canvas = $state<HTMLElement | null>(null);
  const attached = $derived(graph.attached);
  const stamps = $derived(graphStamps(graph));
  const relative = $derived(new Map(attached.routes.map((route) => [route.id, route])));

  // Windowing: only tiles near the scroller's viewport are mounted. The logical scene keeps every record.
  let band = $state.raw<{ top: number; bottom: number } | null>(null);
  $effect(() => {
    const element = canvas, container = scroller;
    if (!element || !container || records.tiles.length + 1 <= WINDOW_MIN) { band = null; return; }
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

  const focus = $derived(graph.plan.lineage.focus);
  const visibleTiles = $derived(records.tiles.filter((record) => {
    if (!band || record.tile.key === focus || record.tile.key === focusedKey || selected.has(record.tile.key)) return true;
    return record.placed.y + record.placed.height >= band.top && record.placed.y <= band.bottom;
  }));

  // With a focus, its lineage (the selected branch) is drawn with more contrast than the rest.
  const branch = $derived(focus !== null);
  /** A line's colour: highlight and branch (with a focus) win over the route's scope. */
  const MARKER_TONES = ["", "subfolder", "external", "branch", "highlight"] as const;
  const lineTone = (style: RouteStyle): (typeof MARKER_TONES)[number] =>
    style.highlighted ? "highlight" : branch && style.related ? "branch" : style.kind === "current" ? "" : style.kind;
  // Each connector's vertical extent in band coordinates (its record bounds are in folder coordinates), so windowing can skip far-away ones too.
  const inBand = (top: number, bottom: number) => !band || (bottom >= band.top && top <= band.bottom);
  const routes = $derived(records.routes.flatMap((record) => {
    const route = relative.get(record.route.id);
    const top = record.rect.y - graph.origin.y, bottom = top + record.rect.height;
    return route && inBand(top, bottom) ? [{ route, style: record.style }] : [];
  }));
  const junctions = $derived(records.junctions.flatMap((record) => {
    const junction = attached.junctions.get(record.junction.id);
    return junction && inBand(junction.y, junction.y) ? [{ junction, highlighted: record.highlighted }] : [];
  }));
  const junctionTitle = (parents: readonly NodeKey[]) => `Combined inputs: ${parents.map((key) => {
    const node = nodes.get(key);
    return node ? promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node) : key;
  }).join(", ")}`;

  // Grid keys (arrows, Enter) belong to the folder grid, which navigates the whole scene.
  const keydown = (key: NodeKey, event: KeyboardEvent): void => ongridkey(key, event);
</script>

<div class="graph" data-layout-stamp={stamps.layout} data-attachment={stamps.attachment} data-orientation={graph.layout.orientation} bind:this={canvas} style:width="{attached.width}px" style:height="{attached.height}px">
  <svg class="edges" width={attached.width} height={attached.height} aria-hidden="true">
    <defs>
      <!--
        One arrowhead per line colour, so every arrowhead matches its line.
        Sized in canvas pixels (not stroke widths), so a highlighted line's
        arrowhead is no bigger than any other. Its base sits on the route's
        end and its tip one ARROW.length further on, on the tile's edge
        (layout.ts ends each route that far short of it); `orient="auto"`
        follows the route's straight final stem.
      -->
      {#each MARKER_TONES as tone (tone)}
        <marker id="arrow-{uid}{tone ? `-${tone}` : ""}" class={tone} markerUnits="userSpaceOnUse" viewBox="0 0 {ARROW.length} {ARROW.width}"
          refX="0" refY={ARROW.width / 2} markerWidth={ARROW.length} markerHeight={ARROW.width} orient="auto">
          <polygon points="0,0 {ARROW.length},{ARROW.width / 2} 0,{ARROW.width}" />
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
    {#each junctions as { junction, highlighted } (junction.id)}
      <circle class="junction" class:highlight={highlighted}
        data-junction={junction.id} cx={junction.x} cy={junction.y} r="2.8"><title>{junctionTitle(junction.parents)}</title></circle>
    {/each}
  </svg>
  <!-- Motion's fading copies of departed tiles (motion.ts); Svelte keeps it empty. -->
  <div class="ghosts" data-motion-ghosts aria-hidden="true" inert></div>
  {#each visibleTiles as record (record.tile.key)}
    <TraceTile tile={record.tile} badgeNodes={nodes} focused={focusedKey === undefined || focusedKey === record.tile.key} onfocus={() => onfocuskey?.(record.tile.key)} badges={record.badges} badgeSelection={selected} onbadge={onactivate} onbadgehover={(key) => onbadgehover?.(key)} placed={record.placed} orientation={graph.layout.orientation} selected={record.selected} {revision}
      onactivate={(event) => onactivate(record.tile.key, event)} onopen={() => onopen(record.tile.key)}
      onmenu={(event) => onmenu(record.tile.key, event)} onkey={(event) => keydown(record.tile.key, event)}
      {captureSelection} onsaved={(path, select) => onsaved(record.tile.key, path, select)} ondiscarded={() => ondiscarded(record.tile.key)} />
  {/each}
</div>

<style>
  .graph { position: relative; margin: 0; }
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
</style>
