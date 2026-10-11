<script lang="ts">
  /**
   * Stand-in for the host's `ui/file-tiles` module (capability `fileTiles`),
   * honouring its contract: one tile per entry with `data-entry-path`, the
   * given selection, and select/open/menu callbacks (Enter opens, as in the
   * host's Tiles view), at the `size` preset given, or the global setting
   * (small, the host's default) without one: each tile is the host's column
   * width for the preset, around a thumbnail of the preset's edge.
   */
  import type { FileTilesProps } from "../../integration/plugin-sdk";
  import { TILE_GRID_PX, TILE_IMAGE_PX } from "./tile-presets";
  let { entries, selected, onselect, onopen, onmenu, label, size }: FileTilesProps = $props();
  const preset = $derived(size ?? "small");
</script>

<!-- Mirrors the host's FileTiles DOM and ARIA contract: grid > row > focusable gridcell with aria-selected. -->
<div class="host-file-tiles" role="grid" aria-label={label} aria-multiselectable={true} data-host-file-tiles data-size={size ?? "default"}>
  <div role="row" class="row">
    {#each entries as entry, index (entry.path)}
      <div role="gridcell" class="tile-item" aria-selected={selected.has(entry.path)} aria-colindex={index + 1}
        tabindex={index === 0 ? 0 : -1} data-entry-path={entry.path} style:width="{TILE_GRID_PX[preset]}px"
        onclick={(event) => onselect(entry, event)} ondblclick={() => onopen(entry)}
        oncontextmenu={(event) => { event.preventDefault(); onmenu(entry, event); }}
        onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); onopen(entry); } }}>
        <span class="thumb" data-thumbnail style:width="{TILE_IMAGE_PX[preset]}px" style:height="{TILE_IMAGE_PX[preset]}px"></span>
        <span class="kind">{entry.kind}</span> {entry.name}
      </div>
    {/each}
  </div>
</div>

<style>
  .host-file-tiles { padding: 10px 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  .tile-item { padding: 6px 10px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm);
    display: flex; flex-direction: column; align-items: center; box-sizing: border-box; overflow: hidden; }
  .tile-item[aria-selected="true"] { border-color: var(--accent); }
  .kind { color: var(--text-secondary); font-size: 11px; }
  .thumb { display: block; flex: none; background: var(--subtle-fill-secondary, rgba(127,127,127,.15)); border-radius: 2px; }
</style>
