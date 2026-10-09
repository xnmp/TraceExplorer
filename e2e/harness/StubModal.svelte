<script lang="ts">
  /** The host's `ui/modal`, reduced to what plugin dialogs rely on: an overlay that renders its content while open. */
  import type { Snippet } from "svelte";
  let { open, onClose, overlayClass = "", labelledby, children }: { open: boolean; onClose: () => void; overlayClass?: string; labelledby?: string; children: Snippet } = $props();
</script>

<svelte:window onkeydown={(event) => { if (open && event.key === "Escape") onClose(); }} />
{#if open}
  <div class="stub-overlay {overlayClass}" role="dialog" aria-modal="true" aria-labelledby={labelledby}>{@render children()}</div>
{/if}

<style>
  .stub-overlay { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.3); }
</style>
