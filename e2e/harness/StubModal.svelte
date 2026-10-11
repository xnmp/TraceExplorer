<script lang="ts">
  /** The host's `ui/modal`, including backdrop blur/fade so dialog entrance regressions remain observable. */
  import { getContext, type Snippet } from "svelte";
  const dialogScope = getContext<(() => "pane" | "window") | undefined>("harness-dialog-scope");
  let { open, onClose, overlayClass = "", labelledby, children }: { open: boolean; onClose: () => void; overlayClass?: string; labelledby?: string; children: Snippet } = $props();
</script>

<svelte:window onkeydown={(event) => { if (open && event.key === "Escape") onClose(); }} />
{#if open}
  <div class="stub-overlay {overlayClass}" class:pane-scoped={dialogScope?.() === "pane"} role="dialog" aria-modal={dialogScope?.() !== "pane" ? "true" : undefined} aria-labelledby={labelledby}>{@render children()}</div>
{/if}

<style>
  .stub-overlay { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.3); backdrop-filter: blur(4px); z-index: var(--z-modal, 1000); animation: modal-overlay-in 150ms cubic-bezier(0, 0, 0, 1); }
  .stub-overlay.pane-scoped { right: auto; width: min(var(--view-width), 100%); }
  @keyframes modal-overlay-in { from { opacity: 0; } to { opacity: 1; } }
</style>
