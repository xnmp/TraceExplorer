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

<ul class="host-file-tiles" aria-label={label} data-host-file-tiles data-size={size ?? "default"}>
  {#each entries as entry (entry.path)}
    <li>
      <button type="button" data-entry-path={entry.path} aria-pressed={selected.has(entry.path)} style:width="{TILE_GRID_PX[preset]}px"
        onclick={(event) => onselect(entry, event)} ondblclick={() => onopen(entry)} oncontextmenu={(event) => onmenu(entry, event)}
        onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); onopen(entry); } }}>
        <span class="thumb" data-thumbnail style:width="{TILE_IMAGE_PX[preset]}px" style:height="{TILE_IMAGE_PX[preset]}px"></span>
        <span class="kind">{entry.kind}</span> {entry.name}
      </button>
    </li>
  {/each}
</ul>

<style>
  .host-file-tiles { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 10px 12px; list-style: none; }
  button { padding: 6px 10px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); }
  button[aria-pressed="true"] { border-color: var(--accent); }
  .kind { color: var(--text-secondary); font-size: 11px; }
  button { display: flex; flex-direction: column; align-items: center; box-sizing: border-box; overflow: hidden; }
  .thumb { display: block; flex: none; background: var(--subtle-fill-secondary, rgba(127,127,127,.15)); border-radius: 2px; }
</style>
