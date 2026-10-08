<script lang="ts">
  /**
   * Hover actions for an unsaved output: Save and Delete as small icon
   * buttons on one opaque chip, so they stay legible over any image. Labels
   * come from the Trace tooltip. Save as… lives in Preview's actions.
   */
  import { onDestroy } from "svelte";
  import { saveGeneratedImage, discardGeneratedImage, type TraceArtifact } from "$lib/api/trace";
  import { extractError } from "$lib/api/common";
  import { traceInvalidation } from "./invalidation.svelte";
  import { imageActionState } from "./image-actions.svelte";
  import { tooltipTrigger } from "./view/tooltip/controller.svelte";
  let { artifact, onSelectFile, captureSelection, selectAfterSave = true, onDiscard }: { artifact: TraceArtifact; onSelectFile:(path:string)=>Promise<void>; captureSelection?:()=>()=>boolean; selectAfterSave?:boolean; onDiscard?:(artifact:TraceArtifact,viewPath:string|null)=>void } = $props();
  let alive = true;
  let error = $state("");
  let operation = $state("");
  onDestroy(()=>{alive=false;});
  const busy = $derived(imageActionState.busy(artifact.id));
  const saveTooltip = tooltipTrigger({ content: () => ({ text: "Save", isPrompt: false, details: [] }) });
  const deleteTooltip = tooltipTrigger({ content: () => ({ text: "Delete", isPrompt: false, details: [] }) });
  async function act(action: "save" | "delete") {
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
        const result = await saveGeneratedImage(selected.id);
        if (alive && artifact.id === selected.id && navigateAfterSave && stillSelected()) await onSelectFile(result.path);
      }
      traceInvalidation.bump();
    } catch (cause) { error = extractError(cause); }
    finally { operation = ""; imageActionState.end(selected.id); }
  }
</script>
{#if artifact.temporary && !artifact.discarded}
  <div class="image-actions" role="group" aria-label="Image actions">
    <button type="button" aria-label="Save image permanently" disabled={busy || artifact.pathState !== "present"} onclick={()=>act("save")} {@attach saveTooltip}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11.5L21 7.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/></svg>
    </button>
    <button type="button" class="delete" aria-label="Delete unsaved image" disabled={busy} onclick={()=>act("delete")} {@attach deleteTooltip}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14h10l1-14M10 10.5v6M14 10.5v6"/></svg>
    </button>
  </div>
  {#if operation}<p role="status">{operation}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
{/if}
<style>
  /* One opaque chip (the host's tooltip surface) so the icons read the same over bright and dark images. */
  .image-actions {
    display: flex; gap: 1px; flex: none; padding: 2px;
    background: var(--background-solid); border: 1px solid var(--control-stroke-secondary); border-radius: var(--radius-sm);
    box-shadow: var(--shadow-tooltip);
  }
  button {
    display: grid; place-items: center; width: 20px; height: 20px; padding: 0; font: inherit;
    color: var(--text-primary); background: transparent; border: 0; border-radius: calc(var(--radius-sm) - 3px); cursor: pointer;
  }
  svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  button:hover:not(:disabled) { background: color-mix(in srgb, var(--text-primary) 9%, transparent); }
  button:active:not(:disabled) { background: color-mix(in srgb, var(--text-primary) 16%, transparent); }
  button:active:not(:disabled) svg { transform: scale(.92); }
  button.delete:hover:not(:disabled) { color: var(--system-critical-text, var(--system-critical)); }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -1px; }
  p {
    margin: 4px 0 0; padding: 2px 6px; width: max-content; max-width: 200px; font-size: var(--font-size-caption); line-height: 1.35; overflow-wrap: anywhere;
    color: var(--text-primary); background: var(--background-solid); border: 1px solid var(--control-stroke-secondary); border-radius: calc(var(--radius-sm) - 2px);
    box-shadow: var(--shadow-tooltip);
  }
  .error { color: var(--system-critical-text, var(--system-critical)); }
  @media (prefers-reduced-motion: no-preference) { button { transition: background-color var(--transition-fast), color var(--transition-fast); } svg { transition: transform var(--transition-fast); } }
</style>
