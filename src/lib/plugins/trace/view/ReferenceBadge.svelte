<script lang="ts">
  import type { ReferenceBadge } from "$lib/domain/trace-graph/projection";
  import type { TraceNode } from "$lib/domain/trace-graph/model";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import { onDestroy } from "svelte";
  import { tooltipTrigger } from "./tooltip/controller.svelte";
  import { tileTooltipContent } from "./tooltip/content";
  let { badge, node, revision, selected, onactivate, onhover }: {
    badge: ReferenceBadge; node?: TraceNode; revision: number; selected: boolean;
    onactivate: (key: string, event: MouseEvent) => void; onhover?: (key: string | null) => void;
  } = $props();
  // Hover is reported to the grid, which highlights this reference's lineage: a badge that goes away
  // under the pointer fires no mouseleave, so it must withdraw its own hover.
  let hovering = false;
  const hover = (on: boolean) => { hovering = on; onhover?.(on ? badge.key : null); };
  onDestroy(() => { if (hovering) onhover?.(null); });
  const tooltip = tooltipTrigger({ content: () => node ? tileTooltipContent(node) : { text: badge.path, isPrompt: false, details: [badge.scope] } });
</script>
<button type="button" class="badge" class:selected data-reference-key={badge.key} aria-pressed={selected}
  aria-label="{badge.path}, {badge.scope}" {@attach tooltip}
  onclick={(event) => onactivate(badge.key, event)} onmouseenter={() => hover(true)} onmouseleave={() => hover(false)}
  onfocus={() => hover(true)} onblur={() => hover(false)}>
  <TraceThumbnail path={badge.path} present={node ? node.state === "present" : true} {revision} label="" />
  <span class="scope" aria-hidden="true">{badge.scope === "external" ? "↗" : "▱"}</span>
</button>
<style>
  .badge { position: relative; pointer-events: auto; width: 24px; height: 24px; padding: 0; overflow: hidden; border: 1px solid var(--control-stroke); border-radius: 50%; background: var(--background-solid); color: var(--text-primary); cursor: pointer; }
  .badge :global(.thumbnail) { height: 100% !important; }
  .badge :global(img) { object-fit: cover !important; }
  .scope { position: absolute; right: 0; bottom: 0; font-size: 10px; line-height: 10px; background: var(--background-solid); }
  .selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .badge:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
</style>
