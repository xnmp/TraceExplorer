<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import OpenAIImageForm from "./OpenAIImageForm.svelte";
  import type { ComponentProps } from "svelte";
  let props: ComponentProps<typeof OpenAIImageForm> = $props();
</script>
<Modal open={props.open} onClose={props.onClose} overlayClass="dialog-overlay" labelledby="openai-image-title">
  <div class="dialog plugin-dialog">
    <header class="dialog-header">
      <h2 id="openai-image-title">{props.sourcePath ? "Edit with OpenAI" : "Generate image with OpenAI"}</h2>
      <button class="close-btn" type="button" onclick={props.onClose} aria-label="Close">×</button>
    </header>
    <OpenAIImageForm {...props} />
  </div>
</Modal>
<style>
  .dialog { width: 520px; max-height: 90vh; display: flex; flex-direction: column; overflow: auto; }
  .dialog-header { flex-shrink: 0; }
</style>
