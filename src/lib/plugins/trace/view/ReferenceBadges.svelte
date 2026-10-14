<script lang="ts">
  import { BADGES_SHOWN, visibleBadges, type ReferenceBadge } from "$lib/domain/trace-graph/projection";
  import type { TraceNode } from "$lib/domain/trace-graph/model";
  import Badge from "./ReferenceBadge.svelte";
  import { onDestroy, tick } from "svelte";
  import { traceThumbnails } from "../thumbnail-cache";
  import { badgeThumbnails } from "./scene-media";
  import { createMediaGate } from "./media-gate";
  import { MEDIA_DEADLINE_MS } from "./scene-controller.svelte";
  let { badges, revision, selected, nodes, onactivate, onhover }: {
    nodes?: ReadonlyMap<string, TraceNode>; badges: readonly ReferenceBadge[]; revision: number; selected: ReadonlySet<string>;
    onactivate: (key: string, event: MouseEvent) => void; onhover?: (key: string | null) => void;
  } = $props();
  let expanded = $state(false);
  // The scene prepares the images of the same badges (scene-media.ts).
  const visible = $derived(visibleBadges(badges, selected, expanded));
  const hidden = $derived(badges.length - visible.length);
  // Opening "+n" draws the hidden badges in the frame their images are decoded (media-gate.ts):
  // until then the tile keeps its look. Closing is immediate, and a click while opening withdraws it.
  const gate = createMediaGate({ hold: traceThumbnails.hold, rendered: tick, deadline: MEDIA_DEADLINE_MS });
  onDestroy(() => gate.cancel());
  function toggle(): void {
    if (gate.cancel()) return;
    if (expanded) { expanded = false; return; }
    gate.request(badgeThumbnails(visibleBadges(badges, selected, true), nodes), revision, () => { expanded = true; });
  }
</script>
<div class="badges">
  {#each visible as badge (badge.key)}
    <Badge {badge} node={nodes?.get(badge.key)} {revision} selected={selected.has(badge.key)} {onactivate} {onhover} />
  {/each}
  {#if badges.length > BADGES_SHOWN && (expanded || hidden > 0)}
    <button type="button" class="more" aria-label={expanded ? "Show fewer references" : `Show ${hidden} more references`}
      aria-expanded={expanded} onclick={toggle}>{expanded ? "−" : `+${hidden}`}</button>
  {/if}
</div>
<style>
  /* The container's empty area (wrapped rows) must not cover the image: only the badges take the pointer. */
  .badges { position: absolute; right: -3px; top: -7px; display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; z-index: 2; pointer-events: none; }
  .more { position: relative; pointer-events: auto; width: 24px; height: 24px; padding: 0; border: 1px solid var(--control-stroke); border-radius: 50%; background: var(--background-solid); color: var(--text-primary); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .more { font: inherit; font-size: 10px; }
</style>
