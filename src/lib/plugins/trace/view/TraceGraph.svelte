<script lang="ts">
  /**
   * One open stack's band, drawn from the published scene: its tiles, connectors and junctions
   * exactly as the committed layout attached them. A renderer only: no planning, layout or
   * publication happens here (the scene controller owns those).
   *
   * Motion (docs/scene-transactions.md §6): the band also draws what its presentation needs this
   * epoch, registered as render handles for the motion driver: an HTML layer for each live
   * connector or junction that does not move with its section (its SVG source hidden while the
   * layer lasts), and its retiring tiles, connectors and junctions (inert, passive copies).
   */
  import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
  import { JUNCTION_RADIUS, type FolderSceneGraph, type JunctionRecord, type RouteRecord, type TileRecord } from "$lib/domain/trace-graph/folder-scene";
  import { promptTitles } from "../prompt-titles.svelte";
  import { nodeTitle } from "./node-target";
  import type { GraphRecords } from "./scene-view";
  import type { GraphPresentation } from "./presentation-view";
  import { layerKey, type RenderHandles } from "./render-handles";
  import EdgeMarkers from "./EdgeMarkers.svelte";
  import EdgePath from "./EdgePath.svelte";
  import RetiringTile from "./RetiringTile.svelte";
  import TraceTile from "./TraceTile.svelte";

  interface Props {
    graph: FolderSceneGraph;
    records: GraphRecords;
    /** This band's motion layers and retirees this epoch. */
    presented: GraphPresentation;
    /** Records moving this epoch: mounted until they settle, wherever the viewport is. */
    pinned: ReadonlySet<string>;
    handles: RenderHandles;
    /** The component's nodes (badge and junction titles). */
    nodes: ReadonlyMap<NodeKey, TraceNode>;
    focusedKey?: string | null;
    onfocuskey?: (key: string) => void;
    onbadgehover?: (key: string | null) => void;
    ongridkey: (key: string, event: KeyboardEvent) => void;
    selected: ReadonlySet<NodeKey>;
    revision: number;
    /**
     * The window of this band's canvas to mount, in its own coordinates (StackGrid derives it from
     * the displayed viewport and where the band is displayed now; `scene-window.ts`), or null for all.
     */
    windowTop: number | null;
    windowBottom: number | null;
    onactivate: (key: NodeKey, event: MouseEvent) => void;
    onopen: (key: NodeKey) => void;
    onmenu: (key: NodeKey, event: MouseEvent) => void;
    onsaved: (key: NodeKey, path: string, select: boolean) => void;
    /** Selection lease for hover saves (see TraceImageActions). */
    captureSelection?: () => () => boolean;
    ondiscarded: (key: NodeKey) => void;
  }

  let { graph, records, presented, pinned, handles, nodes, selected, revision, windowTop, windowBottom, onactivate, onopen, onmenu, onsaved, ondiscarded, captureSelection, ongridkey, focusedKey, onfocuskey, onbadgehover }: Props = $props();

  /** Tile windowing only pays off for very large neighborhoods. */
  const WINDOW_MIN = 120;
  const uid = $props.id();
  const attached = $derived(graph.attached);
  const relative = $derived(new Map(attached.routes.map((route) => [route.id, route])));

  // Windowing: only tiles within the window are mounted, with the focus (or the tile carrying it as a badge), the keyboard
  // stop, the selection and whatever moves this epoch. The logical scene keeps every record; a tile mounted later shows its
  // target pose in its section and starts no motion. Small bands mount everything.
  const windowed = $derived(records.tiles.length + 1 > WINDOW_MIN);
  const bandTop = $derived(windowed ? windowTop : null), bandBottom = $derived(windowed ? windowBottom : null);
  const band = $derived(bandTop === null || bandBottom === null ? null : { top: bandTop, bottom: bandBottom });

  const focus = $derived(graph.plan.lineage.focus);
  const visibleTiles = $derived(records.tiles.filter((record) => {
    if (!band || record.tile.key === focus || record.tile.key === focusedKey || selected.has(record.tile.key) || pinned.has(record.id)
      || (focus !== null && record.badges.some((badge) => badge.key === focus))) return true;
    return record.placed.y + record.placed.height >= band.top && record.placed.y <= band.bottom;
  }));

  // With a focus, its lineage (the selected branch) is drawn with more contrast than the rest.
  const branch = $derived(focus !== null);
  // Each connector's vertical extent in band coordinates (its record bounds are in folder coordinates), so windowing can skip far-away ones too.
  const inBand = (top: number, bottom: number) => !band || (bottom >= band.top && top <= band.bottom);
  const routes = $derived(records.routes.flatMap((record) => {
    const route = relative.get(record.route.id);
    const top = record.rect.y - graph.origin.y, bottom = top + record.rect.height;
    return route && (inBand(top, bottom) || pinned.has(record.id)) ? [{ id: record.id, route, style: record.style }] : [];
  }));
  const junctions = $derived(records.junctions.flatMap((record) => {
    const junction = attached.junctions.get(record.junction.id);
    return junction && (inBand(junction.y, junction.y) || pinned.has(record.id)) ? [{ id: record.id, junction, highlighted: record.highlighted }] : [];
  }));
  // Motion layers: live connectors and junctions moving apart from their section, then retiring ones.
  type Layer = { key: string; record: RouteRecord | JunctionRecord; branch: boolean; opacity?: number };
  const layers = $derived<Layer[]>([
    ...[...records.routes, ...records.junctions].filter((record) => presented.layered.has(record.id)).map((record) => ({ key: layerKey(record.id), record, branch })),
    ...presented.retiring.flatMap((retiree) => retiree.record.kind === "route" || retiree.record.kind === "junction"
      ? [{ key: retiree.renderId, record: retiree.record, branch: retiree.branch, opacity: retiree.initial.opacity }] : []),
  ]);
  const retiringTiles = $derived(presented.retiring.filter((retiree) => retiree.record.kind === "tile"));
  const junctionTitle = (parents: readonly NodeKey[]) => `Combined inputs: ${parents.map((key) => {
    const node = nodes.get(key);
    return node ? promptTitles.labelFor(node.runId, node.prompt) || nodeTitle(node) : key;
  }).join(", ")}`;

  // Grid keys (arrows, Enter) belong to the folder grid, which navigates the whole scene.
  const keydown = (key: NodeKey, event: KeyboardEvent): void => ongridkey(key, event);
</script>

<div class="graph" data-orientation={graph.layout.orientation} style:width="{attached.width}px" style:height="{attached.height}px">
  <svg class="edges trace-edges" width={attached.width} height={attached.height} aria-hidden="true">
    <EdgeMarkers {uid} />
    {#each routes as { id, route, style } (route.id)}
      <EdgePath {route} d={route.path} {style} {branch} {uid} opacity={presented.layered.has(id) ? 0 : undefined} />
    {/each}
    {#each junctions as { id, junction, highlighted } (junction.id)}
      <circle class="junction" class:highlight={highlighted} style:opacity={presented.layered.has(id) ? 0 : undefined}
        data-junction={junction.id} cx={junction.x} cy={junction.y} r={JUNCTION_RADIUS}><title>{junctionTitle(junction.parents)}</title></circle>
    {/each}
  </svg>
  <!-- Exact connector geometry in native HTML layers: WebKit accelerates transforms and opacity on HTML layers, but not reliably on SVG children. -->
  {#each layers as layer (layer.key)}
    {@const rect = layer.record.rect}
    <div class="route-layer" data-motion-route-layer="" aria-hidden="true" inert {@attach handles.attach(layer.key)}
      style:left="{rect.x - graph.origin.x}px" style:top="{rect.y - graph.origin.y}px" style:width="{rect.width}px" style:height="{rect.height}px" style:opacity={layer.opacity}>
      <svg class="edges trace-edges" width={rect.width} height={rect.height} viewBox="{rect.x} {rect.y} {rect.width} {rect.height}">
        {#if layer.record.kind === "route"}
          <EdgePath route={layer.record.route} d={layer.record.route.path} style={layer.record.style} branch={layer.branch} {uid} ghost />
        {:else}
          <circle class="junction" class:highlight={layer.record.highlighted} data-motion-ghost="" data-motion-junction={layer.record.junction.id}
            cx={layer.record.junction.x} cy={layer.record.junction.y} r={JUNCTION_RADIUS} />
        {/if}
      </svg>
    </div>
  {/each}
  {#each retiringTiles as retiree (retiree.renderId)}
    {@const record = retiree.record as TileRecord}
    <RetiringTile {record} x={record.rect.x - graph.origin.x} y={record.rect.y - graph.origin.y} {revision} orientation={record.orientation ?? graph.layout.orientation} handle={handles.attach(retiree.renderId)} />
  {/each}
  {#each visibleTiles as record (record.tile.key)}
    <TraceTile tile={record.tile} badgeNodes={nodes} focused={focusedKey === undefined || focusedKey === record.tile.key} onfocus={() => onfocuskey?.(record.tile.key)} badges={record.badges} badgeSelection={selected} onbadge={onactivate} onbadgehover={(key) => onbadgehover?.(key)} placed={record.placed} orientation={graph.layout.orientation} selected={record.selected} {revision}
      handle={handles.attach(record.id)}
      onactivate={(event) => onactivate(record.tile.key, event)} onopen={() => onopen(record.tile.key)}
      onmenu={(event) => onmenu(record.tile.key, event)} onkey={(event) => keydown(record.tile.key, event)}
      {captureSelection} onsaved={(path, select) => onsaved(record.tile.key, path, select)} ondiscarded={() => ondiscarded(record.tile.key)} />
  {/each}
</div>

<style>
  .graph { position: relative; margin: 0; }
  .edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  .route-layer { position: absolute; overflow: visible; pointer-events: none; }
  .route-layer .edges { inset: auto; left: 0; top: 0; }
  /*
   * Line colours, one per tone, for every connector drawn (live bands, motion layers and exit
   * groups share them). Lines, their arrowheads and junction dots read the same property, so they
   * always match. Only tokens every host theme defines are used without a fallback (see
   * integration/plugin-sdk/theme-tokens.ts).
   */
  :global(.trace-edges) {
    --edge: var(--trace-edge, color-mix(in srgb, var(--text-secondary) 55%, transparent));
    --edge-subfolder: var(--trace-edge-subfolder, color-mix(in srgb, var(--accent) 45%, var(--text-secondary)));
    --edge-external: var(--trace-edge-external, color-mix(in srgb, var(--system-caution-text, var(--system-caution)) 70%, var(--text-secondary)));
    --edge-branch: var(--trace-edge-branch, color-mix(in srgb, var(--text-primary) 72%, transparent));
    --edge-highlight: var(--trace-edge-highlight, var(--accent));
  }
  :global(.trace-edges path) { fill: none; stroke: var(--edge); stroke-width: 1.35; }
  :global(.trace-edges path.subfolder) { stroke: var(--edge-subfolder); }
  :global(.trace-edges path.external) { stroke: var(--edge-external); stroke-dasharray: 4 3; }
  :global(.trace-edges path.branch) { stroke: var(--edge-branch); stroke-width: 1.6; }
  :global(.trace-edges path.highlight) { stroke: var(--edge-highlight); stroke-width: 2.3; }
  :global(.trace-edges path.unrelated) { opacity: .4; }
  :global(.trace-edges marker polygon) { fill: var(--edge); }
  :global(.trace-edges marker.subfolder polygon) { fill: var(--edge-subfolder); }
  :global(.trace-edges marker.external polygon) { fill: var(--edge-external); }
  :global(.trace-edges marker.branch polygon) { fill: var(--edge-branch); }
  :global(.trace-edges marker.highlight polygon) { fill: var(--edge-highlight); }
  :global(.trace-edges .junction) { fill: color-mix(in srgb, var(--text-secondary) 75%, transparent); stroke: var(--background-solid); stroke-width: 1; pointer-events: auto; }
  :global(.trace-edges .junction.highlight) { fill: var(--edge-highlight); }
  :global(.trace-edges [data-motion-ghost]) { pointer-events: none; }
</style>
