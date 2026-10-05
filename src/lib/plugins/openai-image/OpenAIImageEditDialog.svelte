<script lang="ts">
  import { untrack } from "svelte";
  import ImageCropEditor from "$lib/components/ImageCropEditor.svelte";
  import { basename } from "$lib/domain/path";
  let { open, sourcePath, referencePaths = [], onClose }: { open: boolean; sourcePath: string; referencePaths?: string[]; onClose: () => void } = $props();
  const inputs = untrack(() => [sourcePath, ...referencePaths]);
  let selectedSource = $state(untrack(() => sourcePath));
</script>
{#if open}
  {#key selectedSource}
    <ImageCropEditor path={selectedSource} name={basename(selectedSource)} referencePaths={inputs.filter((path) => path !== selectedSource)} initialTool="openai-image"
      onSelectSource={(path) => { if (inputs.includes(path)) selectedSource = path; }} onclose={onClose} />
  {/key}
{/if}
