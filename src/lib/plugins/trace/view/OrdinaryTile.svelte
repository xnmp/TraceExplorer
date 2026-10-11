<script lang="ts">
  import type { FileTileProps } from "../../../../../integration/plugin-sdk";
  import type { TileMetrics } from "$lib/domain/trace-graph/metrics";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  let { entry, selected, focused, column, onfocus, onkeydown, onselect, onopen, onmenu, tile, revision }: FileTileProps & { tile: TileMetrics; revision: number } = $props();
  const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
</script>

<div style:--entry-image="{tile.image}px">
        <button type="button" class="entry" role="gridcell" aria-selected={selected} aria-colindex={column} tabindex={focused ? 0 : -1} {onfocus} {onkeydown} class:selected={selected} data-entry-path={entry.path}
          title={entry.name}
          onclick={(event) => onselect(entry, event)} ondblclick={() => onopen(entry)} oncontextmenu={(event) => onmenu(entry, event)}>
          <span class="icon">
            {#if entry.kind === "directory"}
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /></svg>
            {:else if IMAGE.test(entry.name)}
              <TraceThumbnail path={entry.path} present={true} {revision} label="" />
            {:else}
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6zM14 3v4h4" /></svg>
            {/if}
          </span>
          <span class="name">{entry.name}</span>
        </button>

</div>
<style>
  .entry { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; padding: 5px; font: inherit; color: var(--text-primary); background: none; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
  .entry:hover { background: var(--subtle-fill-secondary); }
  .entry.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
  .entry:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .icon { display: grid; place-items: center; width: 100%; height: var(--entry-image, 51px); overflow: hidden; border-radius: 2px; }
  .icon :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .icon :global(img) { object-fit: cover !important; }
  .icon svg { width: 30px; height: 30px; fill: none; stroke: var(--text-secondary); stroke-width: 1.4; stroke-linejoin: round; }
  .name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
</style>