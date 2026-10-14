<script lang="ts">
  /**
   * A retiring tile (docs/scene-transactions.md §6): the passive visual of a tile that left the
   * scene, drawn where it was displayed while its motion fades it out. Inert and hidden from
   * assistive technology; no tooltip, actions, badges or selection semantics, and absent from
   * every selection and navigation selector (it has no `data-tile-key` or `data-node-key`).
   */
  import type { Attachment } from "svelte/attachments";
  import type { TileRecord } from "$lib/domain/trace-graph/folder-scene";
  import type { Orientation } from "$lib/domain/trace-graph/layout";
  import TileVisual from "./TileVisual.svelte";

  let { record, x, y, opacity, revision, orientation = "down", handle }: {
    record: TileRecord;
    /** Position in the containing canvas. */
    x: number; y: number;
    /** Displayed opacity when it retired (exit group members, which move with their group). */
    opacity?: number;
    revision: number;
    orientation?: Orientation;
    handle?: Attachment<HTMLElement>;
  } = $props();
</script>

<div class="tile" class:unrelated={record.tile.tone === "unrelated"} class:foreign={record.tile.node.scope !== "current"}
  data-motion-ghost="" data-ghost-tile-key={record.tile.node.key} data-tone={record.tile.tone} inert aria-hidden="true" {@attach handle}
  style:left="{x}px" style:top="{y}px" style:width="{record.rect.width}px" style:height="{record.rect.height}px" style:opacity={opacity}>
  <TileVisual tile={record.tile} selected={record.selected} {revision} {orientation} />
</div>

<style>
  .tile { position: absolute; box-sizing: border-box; pointer-events: none; }
</style>
