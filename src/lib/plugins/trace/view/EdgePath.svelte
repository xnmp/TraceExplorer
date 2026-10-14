<svelte:options namespace="svg" />
<script lang="ts">
  /**
   * One connector's path. Live connectors carry their identity (`data-route`); motion copies
   * (layers and retirees) carry it as `data-motion-*` and are never content.
   */
  import type { PlacedRoute } from "$lib/domain/trace-graph/layout";
  import type { RouteStyle } from "$lib/domain/trace-graph/scene";
  import { endpointKey } from "$lib/domain/trace-graph/junctions";
  import { lineTone, markerId } from "./edge-tones";

  let { route, d, style, branch, uid, ghost = false, opacity }: {
    route: PlacedRoute; d: string; style: RouteStyle; branch: boolean; uid: string;
    /** A motion copy rather than the live connector. */
    ghost?: boolean;
    /** Inline opacity (a live source hidden under its layer, a retiree's displayed opacity). */
    opacity?: number;
  } = $props();
  const tone = $derived(lineTone(style, branch));
  const from = $derived(endpointKey(route.from)), to = $derived(endpointKey(route.to));
</script>

<path class={style.kind} class:unrelated={!style.related} class:branch={branch && style.related} class:highlight={style.highlighted}
  data-route={ghost ? undefined : route.id} data-from={ghost ? undefined : from} data-to={ghost ? undefined : to}
  data-motion-ghost={ghost ? "" : undefined} data-motion-route={ghost ? route.id : undefined} data-motion-from={ghost ? from : undefined} data-motion-to={ghost ? to : undefined}
  marker-end={route.terminal ? `url(#${markerId(uid, tone)})` : undefined} {d} style:opacity={opacity} />
