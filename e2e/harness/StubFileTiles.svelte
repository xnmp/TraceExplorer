<script lang="ts">
  /**
   * Stand-in for the host's `ui/file-tiles` module (capability `fileTiles`),
   * honouring its contract: one tile per entry with `data-entry-path`, the
   * given selection, and select/open/menu callbacks (Enter opens, as in the
   * host's Tiles view).
   */
  import type { FileTilesProps } from "../../integration/plugin-sdk";
  let { entries, selected, onselect, onopen, onmenu, label }: FileTilesProps = $props();
</script>

<ul class="host-file-tiles" aria-label={label} data-host-file-tiles>
  {#each entries as entry (entry.path)}
    <li>
      <button type="button" data-entry-path={entry.path} aria-pressed={selected.has(entry.path)}
        onclick={(event) => onselect(entry, event)} ondblclick={() => onopen(entry)} oncontextmenu={(event) => onmenu(entry, event)}
        onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); onopen(entry); } }}>
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
</style>
