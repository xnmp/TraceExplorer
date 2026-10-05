<script lang="ts">
  import { imageSaveSuggestion, saveGeneratedImage, type TraceGraph } from "$lib/api/trace";
  import { extractError } from "$lib/api/common";
  import { host } from "../../../sdk";
  import { traceInvalidation } from "./invalidation.svelte";
  import { onDestroy } from "svelte";
  import { traceOperationLabel } from "$lib/domain/trace-layout";
  import { basename } from "$lib/domain/path";
  let { graph, nodeKey, onSelectFile, captureSelection }: { graph: TraceGraph; nodeKey: string; onSelectFile: (path:string)=>Promise<void>; captureSelection?:()=>()=>boolean } = $props();
  let alive = true;
  onDestroy(()=>{alive=false;});
  let savingId = $state<number | null>(null);
  let saveFailure = $state<{id:number; message:string} | null>(null);
  const id = $derived(Number(nodeKey.slice(2)));
  const artifact = $derived(nodeKey.startsWith("a:") ? graph.artifacts.find((item) => item.id === id) : undefined);
  const run = $derived(graph.runs.find((item) => item.id === (artifact?.generatingRun ?? (nodeKey.startsWith("r:") ? id : -1))));
  const prompt = $derived(typeof run?.parameters.prompt === "string" ? run.parameters.prompt : "");
  const settings = $derived(run ? [
    ["Requested resolution", run.parameters.resolution],
    ["Aspect ratio", run.parameters.aspect_ratio === "keep" ? "Keep the same" : run.parameters.aspect_ratio],
    ["Size", run.parameters.size],
    ["Quality", run.parameters.quality],
    ["Seed", run.parameters.seed],
  ].filter(([, value]) => value != null && value !== "auto") : []);
  const actualSize=$derived.by(()=>{
    const value=run?.details?.actual_size;
    if(!value||typeof value!=="object"||!("width" in value)||!("height" in value))return null;
    return typeof value.width==="number"&&typeof value.height==="number"&&Number.isSafeInteger(value.width)&&Number.isSafeInteger(value.height)&&value.width>0&&value.height>0 ? {width:value.width,height:value.height} : null;
  });
  async function save() {
    const selected = artifact;
    if (!selected?.temporary || savingId !== null) return;
    const stillSelected=captureSelection?.() ?? (()=>true);
    savingId = selected.id;
    saveFailure = null;
    try {
      const suggestion = await imageSaveSuggestion(selected.id);
      const target = await host().pickSaveFile({...suggestion,title:"Save generated image"});
      if (!target) return;
      const result = await saveGeneratedImage(selected.id,target);
      traceInvalidation.bump();
      if (alive && artifact?.id === selected.id && stillSelected()) await onSelectFile(result.path);
    } catch (error) { saveFailure = {id:selected.id,message:extractError(error)}; }
    finally { savingId = null; }
  }
</script>

<section id="trace-node-details" class="details" aria-label="Trace details">
  <div class="heading">
    <h2 aria-live="polite">{artifact ? basename(artifact.path) : run ? traceOperationLabel(run.operation) : ""}</h2>
    {#if artifact?.temporary}
      <button type="button" class="save" title="Save image permanently" aria-label="Save image permanently" disabled={savingId !== null || artifact.pathState !== "present"} onclick={save}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>
      </button>
    {/if}
  </div>
  {#if savingId === artifact?.id}<p class="notice" role="status">Saving image…</p>{/if}
  {#if saveFailure?.id === artifact?.id && saveFailure}<p class="error" role="alert">{saveFailure.message}</p>{/if}
  {#if prompt}<p class="prompt">{prompt}</p>{/if}
  {#if settings.length}
    <dl>{#each settings as [label, value]}<dt>{label}</dt><dd>{String(value)}</dd>{/each}</dl>
  {/if}
  {#if actualSize?.width && actualSize?.height}<p class="notice">{actualSize.width} × {actualSize.height} px</p>{/if}
  {#if run && !artifact && run.status !== "running"}<p class="notice">No recorded output</p>{/if}
  {#if run?.error}<p class="error" role="status">{run.error}</p>{/if}
  {#if artifact?.pathState === "missing"}<p class="notice">Missing from recorded path</p>{/if}
  {#key nodeKey}
    <details>
      <summary>Raw</summary>
      <pre>{JSON.stringify({ ...(artifact ? { artifact } : {}), ...(run ? { run } : {}) }, null, 2)}</pre>
    </details>
  {/key}
</section>

<style>
  .details { border-top: 1px solid var(--surface-stroke); padding: 12px 2px 4px; color: var(--text-primary); }
  .heading { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 12px; }
  h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .save { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); color: var(--text-primary); background: var(--background-card-secondary); cursor: pointer; }
  .save:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .save:disabled { opacity: .5; cursor: default; }
  .save:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .prompt { margin: 0 0 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0 0 12px; font-size: 11px; line-height: 1.4; }
  dt { color: var(--text-secondary); }
  dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .error { color: var(--system-critical-text); overflow-wrap: anywhere; }
  .notice { color: var(--text-secondary); }
  summary { cursor: pointer; font-size: 11px; color: var(--text-secondary); padding: 4px 0; }
  summary:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  pre { box-sizing: border-box; max-height: 260px; overflow: auto; margin: 6px 0 0; padding: 8px; border-radius: var(--radius-sm); background: var(--background-card-secondary); color: var(--text-primary); font-size: 10px; line-height: 1.4; }
</style>
