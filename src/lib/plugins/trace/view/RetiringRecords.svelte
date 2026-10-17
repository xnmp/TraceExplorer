<script lang="ts">
  import { JUNCTION_STROKE_WIDTH } from "$lib/domain/trace-graph/connector-ink";
  /**
   * Retirees drawn by the grid, in folder coordinates (docs/scene-transactions.md §6): in-band
   * departures and old connector paths whose band a later publication closed while they still
   * faded (`presentationView(...).orphans`). Each keeps its own track to its end; the motion
   * driver animates it relative to nothing. Inert, hidden from assistive technology and absent
   * from selection and navigation, like every retiree.
   */
  import { JUNCTION_RADIUS, type TileRecord } from "$lib/domain/trace-graph/folder-scene";
  import type { RetiringRecord } from "./presentation";
  import type { RenderHandles } from "./render-handles";
  import EdgeMarkers from "./EdgeMarkers.svelte";
  import EdgePath from "./EdgePath.svelte";
  import RetiringTile from "./RetiringTile.svelte";

  let { plane, retirees, handles, revision }: { plane: "routes" | "tiles"; retirees: readonly RetiringRecord[]; handles: RenderHandles; revision: number } = $props();
  const uid = $props.id();
</script>

<div class="retiring" data-grid-retiring="" inert aria-hidden="true">
<svg class="markers" width="0" height="0" aria-hidden="true"><EdgeMarkers {uid} /></svg>
{#each retirees as retiree (retiree.renderId)}
  {@const record = retiree.record}
  {#if record.kind === "tile" && plane === "tiles"}
    <RetiringTile record={record as TileRecord} x={record.rect.x} y={record.rect.y} {revision} orientation={record.orientation} handle={handles.attach(retiree.renderId)} />
  {:else if plane === "routes" && (record.kind === "route" || record.kind === "junction")}
    {@const rect = record.rect}
    <div class="route-layer" data-motion-route-layer="" aria-hidden="true" inert {@attach handles.attach(retiree.renderId)}
      style:left="{rect.x}px" style:top="{rect.y}px" style:width="{rect.width}px" style:height="{rect.height}px" style:opacity={retiree.initial.opacity}>
      <svg class="edges trace-edges" width={rect.width} height={rect.height} viewBox="{rect.x} {rect.y} {rect.width} {rect.height}">
        {#if record.kind === "route"}
          <EdgePath route={record.route} d={record.route.path} style={record.style} branch={retiree.branch} {uid} ghost />
        {:else}
          <circle class="junction" class:highlight={record.highlighted} data-motion-ghost="" data-motion-junction={record.junction.id}
            cx={record.junction.x} cy={record.junction.y} r={JUNCTION_RADIUS} style:stroke-width={JUNCTION_STROKE_WIDTH} />
        {/if}
      </svg>
    </div>
  {/if}
{/each}
</div>

<style>
  /* Transient: zero size, and layout containment makes its contents ink overflow, so retirees never
     hold the view's scroll extent (as RetiringBand). */
  .retiring { --trace-tile-surface: color-mix(in srgb, var(--accent) 3%, var(--background-solid)); position: absolute; left: 0; top: 0; width: 0; height: 0; contain: layout; pointer-events: none; }
  .markers { position: absolute; overflow: hidden; pointer-events: none; }
  .route-layer { position: absolute; overflow: visible; pointer-events: none; }
  .route-layer .edges { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
</style>
