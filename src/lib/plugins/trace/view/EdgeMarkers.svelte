<svelte:options namespace="svg" />
<script lang="ts">
  /**
   * Arrowhead markers for one SVG's connectors (ids scoped by `uid`). Sized in canvas pixels (not
   * stroke widths), so a highlighted line's arrowhead is no bigger than any other. Its base sits
   * on the route's end and its tip one ARROW.length further on, on the tile's edge (layout.ts ends
   * each route that far short of it); `orient="auto"` follows the route's straight final stem.
   */
  import { ARROW } from "$lib/domain/trace-graph/metrics";
  import { MARKER_TONES, markerId } from "./edge-tones";

  let { uid }: { uid: string } = $props();
</script>

<defs>
  {#each MARKER_TONES as tone (tone)}
    <marker id={markerId(uid, tone)} class={tone} markerUnits="userSpaceOnUse" viewBox="0 0 {ARROW.length} {ARROW.width}"
      refX="0" refY={ARROW.width / 2} markerWidth={ARROW.length} markerHeight={ARROW.width} orient="auto">
      <polygon points="0,0 {ARROW.length},{ARROW.width / 2} 0,{ARROW.width}" />
    </marker>
  {/each}
</defs>
