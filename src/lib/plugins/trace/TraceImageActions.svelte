<script lang="ts">
  import { onDestroy } from "svelte";
  import { imageSaveSuggestion, saveGeneratedImage, discardGeneratedImage, type TraceArtifact } from "$lib/api/trace";
  import { extractError } from "$lib/api/common";
  import { host } from "../../../sdk";
  import { traceInvalidation } from "./invalidation.svelte";
  import { imageActionState } from "./image-actions.svelte";
  let { artifact, onSelectFile, captureSelection, selectAfterSave = true, onDiscard }: { artifact: TraceArtifact; onSelectFile:(path:string)=>Promise<void>; captureSelection?:()=>()=>boolean; selectAfterSave?:boolean; onDiscard?:(artifact:TraceArtifact,viewPath:string|null)=>void } = $props();
  let alive = true;
  let error = $state("");
  let operation = $state("");
  onDestroy(()=>{alive=false;});
  const busy = $derived(imageActionState.busy(artifact.id));
  async function act(action: "save" | "save-as" | "delete") {
    const selected = artifact;
    if (!selected.temporary || selected.discarded || !imageActionState.begin(selected.id)) return;
    const stillSelected = captureSelection?.() ?? (()=>true);
    const navigateAfterSave = selectAfterSave;
    error = "";
    operation = action === "delete" ? "Deleting image…" : "Saving image…";
    try {
      if (action === "delete") {
        const result = await discardGeneratedImage(selected.id);
        if (alive) onDiscard?.(selected,result.viewPath);
      } else {
        let target: string | undefined;
        if (action === "save-as") {
          const suggestion = await imageSaveSuggestion(selected.id);
          const picked = await host().pickSaveFile({...suggestion,title:"Save generated image"});
          if (!picked) return;
          target = picked;
        }
        const result = await saveGeneratedImage(selected.id,target);
        if (alive && artifact.id === selected.id && navigateAfterSave && stillSelected()) await onSelectFile(result.path);
      }
      traceInvalidation.bump();
    } catch (cause) { error = extractError(cause); }
    finally { operation = ""; imageActionState.end(selected.id); }
  }
</script>
{#if artifact.temporary && !artifact.discarded}
  <div class="image-actions" role="group" aria-label="Image actions">
    <button type="button" aria-label="Save image permanently" title="Save with the default filename" disabled={busy || artifact.pathState !== "present"} onclick={()=>act("save")}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
    </button>
    <button type="button" aria-label="Delete unsaved image" title="Delete unsaved image" disabled={busy} onclick={()=>act("delete")}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>
    </button>
    <button type="button" aria-label="Save image as…" title="Choose a filename and folder" disabled={busy || artifact.pathState !== "present"} onclick={()=>act("save-as")}>…</button>
  </div>
  {#if operation}<p role="status">{operation}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
{/if}
<style>
  .image-actions { display: flex; gap: 4px; flex: none; }
  button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; font: inherit; background: var(--control-fill, var(--background-card-secondary)); color: var(--text-primary); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  button:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  p { font-size: 11px; overflow-wrap: anywhere; margin: 4px 0; }
  .error { color: var(--system-critical-text); }
</style>
