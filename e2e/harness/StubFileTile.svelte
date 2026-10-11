<script lang="ts">
  import type { FileTileProps } from "../../integration/plugin-sdk";
  import { TILE_IMAGE_PX } from "./tile-presets";
  let { entry, selected, focused = false, column, size, onfocus, onkeydown, onselect, onopen, onmenu }: FileTileProps = $props();
</script>
<div role="gridcell" class="host-tile" class:selected data-size={size ?? "default"} data-host-file-tile data-entry-path={entry.path}
  aria-selected={selected} aria-colindex={column} tabindex={focused ? 0 : -1} {onfocus} {onkeydown}
  onclick={(event) => onselect(entry, event)} ondblclick={() => onopen(entry)} oncontextmenu={(event) => { event.preventDefault(); onmenu(entry, event); }}>
  <span class="icon" style:height="{TILE_IMAGE_PX[size ?? 'medium']}px">{entry.kind === "directory" ? "▱" : "▧"}</span>
  <span>{entry.name}</span>
</div>
<style>
  .host-tile { box-sizing: border-box; width: 100%; padding: 12px 8px 10px; border: 1px solid transparent; border-radius: var(--radius-sm); display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; }
  .selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .host-tile:focus-visible { outline: 2px solid var(--focus-stroke-outer); }
  .icon { display: grid; place-items: center; width: 100%; }
</style>
