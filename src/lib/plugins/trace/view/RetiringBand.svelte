<script lang="ts">
  /**
   * A closed stack's band as it retires (docs/scene-transactions.md §6): one exit group, drawn
   * where it was displayed. Its tiles, connectors and junctions share the group's fade and clip
   * (the motion driver animates the container). Inert, hidden from assistive technology and
   * absent from selection and navigation. The container has no height of its own: its clip is an
   * absolute polygon from its top.
   */
  import type { JunctionRecord, RouteRecord, TileRecord } from "$lib/domain/trace-graph/folder-scene";
  import { JUNCTION_RADIUS } from "$lib/domain/trace-graph/folder-scene";
  import type { ExitGroupView } from "./presentation-view";
  import type { RenderHandles } from "./render-handles";
  import EdgeMarkers from "./EdgeMarkers.svelte";
  import EdgePath from "./EdgePath.svelte";
  import RetiringTile from "./RetiringTile.svelte";

  let { exit, handles, revision }: { exit: ExitGroupView; handles: RenderHandles; revision: number } = $props();
  const uid = $props.id();
  const rect = $derived(exit.group.record.rect);
</script>

<div class="exit" data-grid-exit={exit.group.record.graphId} inert aria-hidden="true" {@attach handles.attach(exit.group.renderId)}
  style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.width}px">
  <svg class="edges trace-edges" width={rect.width} height={rect.height} viewBox="{rect.x} {rect.y} {rect.width} {rect.height}" aria-hidden="true">
    <EdgeMarkers {uid} />
    {#each exit.routes as retiree (retiree.renderId)}
      {@const record = retiree.record as RouteRecord}
      <EdgePath route={record.route} d={record.route.path} style={record.style} branch={retiree.branch} {uid} ghost opacity={retiree.initial.opacity} />
    {/each}
    {#each exit.junctions as retiree (retiree.renderId)}
      {@const record = retiree.record as JunctionRecord}
      <circle class="junction" class:highlight={record.highlighted} data-motion-ghost="" data-motion-junction={record.junction.id}
        cx={record.junction.x} cy={record.junction.y} r={JUNCTION_RADIUS} style:opacity={retiree.initial.opacity} />
    {/each}
  </svg>
  {#each exit.tiles as retiree (retiree.renderId)}
    {@const record = retiree.record as TileRecord}
    <RetiringTile {record} x={record.rect.x - rect.x} y={record.rect.y - rect.y} opacity={retiree.initial.opacity} {revision} />
  {/each}
</div>

<style>
  /* Transient: zero height, and layout containment makes its contents ink overflow, so a retiring
     band never holds the view's scroll extent (scrolling clamps to the settled scene at once). */
  .exit { position: absolute; height: 0; contain: layout; pointer-events: none; }
  .exit svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
</style>
