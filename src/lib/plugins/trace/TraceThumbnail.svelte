<script lang="ts">
  import { untrack } from "svelte";
  import { traceThumbnails } from "./thumbnail-cache";
  let { path, present, revision, label, prompt = "" }: { path: string; present: boolean; revision: number; label: string; prompt?:string } = $props();
  let url = $state(untrack(() => present ? traceThumbnails.peek(path) : ""));
  $effect(() => {
    if (!present) { url = ""; return; }
    return traceThumbnails.subscribe(path, revision, (value) => { url = value; });
  });
</script>
<span class="thumbnail">
  {#if url}<img src={url} alt="" draggable={false} title={prompt || undefined} />
  {:else}<span class="placeholder" aria-hidden="true">▧</span>{/if}
  {#if label}<small>{label}</small>{/if}
</span>
<style>
  .thumbnail { display: grid; place-items: center; position: relative; flex: 0 0 78px; height: 78px; width: 100%; background: var(--background-card-secondary); overflow: hidden; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
  small { position: absolute; bottom: 0; left: 0; right: 0; background: var(--background-solid); color: var(--text-secondary); font-size: 9px; text-align: center; padding: 2px; }
  .placeholder { color: var(--text-secondary); font-size: 24px; }
</style>
