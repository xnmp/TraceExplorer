<script lang="ts">
  import { JUNCTION_STROKE_WIDTH } from "$lib/domain/trace-graph/connector-ink";
  /**
   * A closed stack's band as it retires (docs/scene-transactions.md §6): one exit group, drawn
   * where it was displayed. Its tiles, connectors and junctions share the group's fade, clip and slide
   * (the motion driver animates the container). Inert, hidden from assistive technology and
   * absent from selection and navigation. The container has no height of its own: its clip is an
   * absolute polygon from its top.
   */
  import type { JunctionRecord, RouteRecord, TileRecord } from "$lib/domain/trace-graph/folder-scene";
  import { JUNCTION_RADIUS } from "$lib/domain/trace-graph/folder-scene";
  import type { ExitGroupView } from "./presentation-view";
  import { exitBodyKey, type RenderHandles } from "./render-handles";
  import { exitsFromCover } from "./presentation";
  import EdgeMarkers from "./EdgeMarkers.svelte";
  import EdgePath from "./EdgePath.svelte";
  import RetiringTile from "./RetiringTile.svelte";

  let { plane, exit, handles, revision }: { plane: "routes" | "tiles"; exit: ExitGroupView; handles: RenderHandles; revision: number } = $props();
  const uid = $props.id();
  const rect = $derived(exit.group.record.rect);
  const header = $derived(exit.group.bodyFloor === undefined ? [] : exit.routes.filter(r => exitsFromCover(r.record)));
  const body = $derived(exit.routes.filter(r => !header.includes(r)));
</script>

<div class="exit" data-grid-exit={plane === "tiles" ? exit.group.record.graphId : undefined} data-route-exit={plane === "routes" ? exit.group.record.graphId : undefined} inert aria-hidden="true" {@attach handles.attach(exit.group.renderId)}
  style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.width}px">
  {#if plane === "routes"}
  <svg class="edges trace-edges" width={rect.width} height={rect.height} viewBox="{rect.x} {rect.y} {rect.width} {rect.height}" aria-hidden="true">
    <EdgeMarkers {uid} />
    {#each header as retiree (retiree.renderId)}
      {@const record = retiree.record as RouteRecord}
      <EdgePath route={record.route} d={record.route.path} style={record.style} branch={retiree.branch} {uid} ghost opacity={retiree.initial.opacity} />
    {/each}
  </svg>
  {/if}
  <div class="body" {@attach handles.attach(exitBodyKey(exit.group.renderId))}>
    {#if plane === "routes"}
    <svg class="edges trace-edges" width={rect.width} height={rect.height} viewBox="{rect.x} {rect.y} {rect.width} {rect.height}" aria-hidden="true">
      {#each body as retiree (retiree.renderId)}
        {@const record = retiree.record as RouteRecord}
        <EdgePath route={record.route} d={record.route.path} style={record.style} branch={retiree.branch} {uid} ghost opacity={retiree.initial.opacity} />
      {/each}
      {#each exit.junctions as retiree (retiree.renderId)}
        {@const record = retiree.record as JunctionRecord}
        <circle class="junction" class:highlight={record.highlighted} data-motion-ghost="" data-motion-junction={record.junction.id}
          cx={record.junction.x} cy={record.junction.y} r={JUNCTION_RADIUS} style:stroke-width={JUNCTION_STROKE_WIDTH} style:opacity={retiree.initial.opacity} />
      {/each}
    </svg>
    {:else}
    {#each exit.tiles as retiree (retiree.renderId)}
      {@const record = retiree.record as TileRecord}
      <RetiringTile {record} x={record.rect.x - rect.x} y={record.rect.y - rect.y} opacity={retiree.initial.opacity} {revision} orientation={record.orientation} />
    {/each}
    {/if}
  </div>
</div>

<style>
  /* Transient: zero height, and layout containment makes its contents ink overflow, so a retiring
     band never holds the view's scroll extent (scrolling clamps to the settled scene at once). */
  .exit { --trace-tile-surface: color-mix(in srgb, var(--accent) 3%, var(--background-solid)); position: absolute; height: 0; contain: layout; pointer-events: none; }
  .body { position: absolute; inset: 0; }
  .exit svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
</style>
