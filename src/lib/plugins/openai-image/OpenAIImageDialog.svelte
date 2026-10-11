<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import OpenAIImageForm from "./OpenAIImageForm.svelte";
  import type { ComponentProps } from "svelte";
  let props: ComponentProps<typeof OpenAIImageForm> = $props();
</script>
<Modal open={props.open} onClose={props.onClose} overlayClass="dialog-overlay ai-image-overlay" labelledby="openai-image-title">
  <div class="dialog plugin-dialog">
    <OpenAIImageForm {...props}>
      {#snippet header(editing)}
        <header class="dialog-header">
          <h2 id="openai-image-title">{editing ? "Edit with AI" : "Generate image with AI"}</h2>
          <button class="close-btn" type="button" onclick={props.onClose} aria-label="Close">×</button>
        </header>
      {/snippet}
    </OpenAIImageForm>
  </div>
</Modal>
<style>
  /* WebKitGTK can drop a blurred surface for a frame when opacity/transform
     animations on it or its children finish (host #1066). Open this keyboard
     dialog immediately, keeping both the host backdrop and our card opaque.
     The extra class and role beat the host's scoped overlay rule without
     changing other dialogs or depending on its internal class name. */
  :global(.dialog-overlay.ai-image-overlay[role="dialog"]) { animation: none; }
  .dialog { width: min(680px, 96%); max-width: 96%; max-height: 96%; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; animation: none; }
  .dialog-header { flex-shrink: 0; }
</style>
