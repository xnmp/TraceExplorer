<script lang="ts">
  import type { ReferenceBadge } from "$lib/domain/trace-graph/projection";
  import type { TraceNode } from "$lib/domain/trace-graph/model";
  import Badge from "./ReferenceBadge.svelte";
  let { badges, revision, selected, nodes, onactivate, onhover }: {
    nodes?: ReadonlyMap<string, TraceNode>; badges: readonly ReferenceBadge[]; revision: number; selected: ReadonlySet<string>;
    onactivate: (key: string, event: MouseEvent) => void; onhover?: (key: string | null) => void;
  } = $props();
  let expanded = $state(false);
  // A selected reference hidden behind "+n" is shown in its place, so choosing it elsewhere (Preview) reveals it.
  const visible = $derived(expanded ? badges : [...badges.slice(0, 3), ...badges.slice(3).filter((badge) => selected.has(badge.key))]);
  const hidden = $derived(badges.length - visible.length);
</script>
<div class="badges">
  {#each visible as badge (badge.key)}
    <Badge {badge} node={nodes?.get(badge.key)} {revision} selected={selected.has(badge.key)} {onactivate} {onhover} />
  {/each}
  {#if badges.length > 3 && (expanded || hidden > 0)}
    <button type="button" class="more" aria-label={expanded ? "Show fewer references" : `Show ${hidden} more references`}
      aria-expanded={expanded} onclick={() => expanded = !expanded}>{expanded ? "−" : `+${hidden}`}</button>
  {/if}
</div>
<style>
  /* The container's empty area (wrapped rows) must not cover the image: only the badges take the pointer. */
  .badges { position: absolute; right: -3px; top: -7px; display: flex; gap: 2px; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; z-index: 2; pointer-events: none; }
  .more { position: relative; pointer-events: auto; width: 24px; height: 24px; padding: 0; border: 1px solid var(--control-stroke); border-radius: 50%; background: var(--background-solid); color: var(--text-primary); cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .more { font: inherit; font-size: 10px; }
</style>
