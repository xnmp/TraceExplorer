<script lang="ts">
  import { getThumbnailData } from "$lib/api/thumbnails";
  let { path, present, revision, label }: { path: string; present: boolean; revision: number; label: string } = $props();
  let url = $state("");
  $effect(() => {
    const selectedPath = path;
    void revision;
    url = "";
    if (!present) return;
    let cancelled = false;
    let ownedUrl = "";
    void getThumbnailData(selectedPath, 256).then((result) => {
      if (!result.ok) return;
      if (cancelled) URL.revokeObjectURL(result.data);
      else { ownedUrl = result.data; url = result.data; }
    });
    return () => { cancelled = true; if (ownedUrl) URL.revokeObjectURL(ownedUrl); };
  });
</script>
<span class="thumbnail">
  {#if url}<img src={url} alt="" title="Preview of the file at its recorded path" />
  {:else}<span class="placeholder" aria-hidden="true">▧</span>{/if}
  {#if label}<small>{label}</small>{/if}
</span>
<style>
  .thumbnail { display: grid; place-items: center; position: relative; height: 78px; width: 100%; background: var(--background-card-secondary); overflow: hidden; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
  small { position: absolute; bottom: 0; left: 0; right: 0; background: var(--background-solid); color: var(--text-secondary); font-size: 9px; text-align: center; padding: 2px; }
  .placeholder { color: var(--text-secondary); font-size: 24px; }
</style>
