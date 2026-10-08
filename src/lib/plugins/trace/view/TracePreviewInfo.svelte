<script lang="ts">
  /**
   * Trace's Preview-info section: prompt, generation parameters, input
   * references (clicking one focuses it in the owning pane) and collapsible Raw
   * metadata, for both real files and this plugin's Preview targets.
   */
  import type { PreviewSubject } from "../../../../../integration/plugin-sdk";
  import { traceForImage, traceRevisionStatus, traceRunDetails, type TraceRevisionStatus, type TraceRun } from "$lib/api/trace";
  import { parentDir } from "$lib/domain/path";
  import { traceOperationLabel } from "$lib/domain/trace-operation";
  import { traceInvalidation } from "../invalidation.svelte";
  import { promptTitles } from "../prompt-titles.svelte";
  import TraceThumbnail from "../TraceThumbnail.svelte";
  import { subjectNode } from "./preview-subject";
  import { tracePanes } from "./pane-registry.svelte";
  import { nodeStatus } from "./node-target";
  import { modelFromGraph, modelFromView, type PreviewInput, type PreviewModel } from "./preview-model";

  let { subject }: { subject: PreviewSubject } = $props();

  const view = $derived(tracePanes.get(subject.paneId));
  const node = $derived(subjectNode(subject));
  const revision = $derived(traceInvalidation.revision);

  // Built-in views have no Trace session; fall back to the per-image query.
  let fallback = $state.raw<PreviewModel | null>(null);
  $effect(() => {
    const path = !node && subject.kind === "file" ? subject.entry.path : null;
    void revision;
    fallback = null;
    if (!path) return;
    let live = true;
    void traceForImage(path).then((result) => { if (live && result.ok && result.data) fallback = modelFromGraph(result.data, parentDir(path)); });
    return () => { live = false; };
  });
  const model = $derived(node && view ? modelFromView(node, (key) => view.node(key)) : fallback);

  let run = $state.raw<TraceRun | null>(null);
  let revisionStatus = $state<TraceRevisionStatus | null>(null);
  let failure = $state("");

  $effect(() => {
    const runId = model?.runId ?? null;
    void revision;
    run = null; failure = "";
    if (runId === null) return;
    let live = true;
    void traceRunDetails([runId]).then((result) => {
      if (!live) return;
      if (result.ok) run = result.data.find((item) => item.id === runId) ?? null; else failure = result.error;
    });
    return () => { live = false; };
  });

  $effect(() => {
    const id = model && subject.kind === "file" ? model.artifactId : null;
    void revision;
    revisionStatus = null;
    if (id === null) return;
    let live = true;
    void traceRevisionStatus(id).then((result) => { if (live && result.ok) revisionStatus = result.data; });
    return () => { live = false; };
  });

  const prompt = $derived(typeof run?.parameters.prompt === "string" ? run.parameters.prompt : model?.prompt ?? "");
  const settings = $derived(run ? [
    ["Operation", traceOperationLabel(run.operation)],
    ["Resolution", typeof run.parameters.resolution === "string" ? run.parameters.resolution.toUpperCase() : run.parameters.resolution],
    ["Aspect ratio", run.parameters.aspect_ratio === "keep" ? "Keep the same" : run.parameters.aspect_ratio],
    ["Quality", run.parameters.quality],
    ["Seed", run.parameters.seed],
  ].filter(([, value]) => value != null && value !== "" && value !== "auto") : []);
  const actualSize = $derived.by(() => {
    const value = run?.details?.actual_size;
    if (!value || typeof value !== "object" || !("width" in value) || !("height" in value)) return null;
    const { width, height } = value as { width: unknown; height: unknown };
    return typeof width === "number" && typeof height === "number" && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : null;
  });
  const inputs = $derived(model?.inputs ?? []);
  const scopeLabel = (input: PreviewInput) => input.scope === "current" ? "This folder" : input.scope === "subfolder" ? "Subfolder" : "External";
  const inputTitle = (input: PreviewInput) => promptTitles.labelFor(input.runId, input.prompt) || input.title;
</script>

{#if model}
  <section class="trace-info" aria-label="Trace">
    <h3>Trace</h3>
    {#if prompt}<p class="prompt" data-testid="trace-prompt">{prompt}</p>{/if}
    {#if settings.length || actualSize}
      <dl>
        {#each settings as [label, value]}<dt>{label}</dt><dd>{String(value)}</dd>{/each}
        {#if actualSize}<dt>Actual size</dt><dd>{actualSize.width} × {actualSize.height} px</dd>{/if}
      </dl>
    {/if}
    {#if revisionStatus === "changed"}<p class="notice">This file changed after it was recorded.</p>{/if}
    {#if node && nodeStatus(node) && subject.kind === "file"}<p class="notice">{nodeStatus(node)}</p>{/if}
    {#if run?.error}<p class="error" role="status">{run.error}</p>{/if}
    {#if failure}<p class="error" role="status">{failure}</p>{/if}
    {#if inputs.length}
      <h4>Inputs</h4>
      <ul class="inputs">
        {#each inputs as input (input.key)}
          <li>
            <button type="button" class="input" aria-label="Preview input {inputTitle(input)}" title={[input.prompt, input.location].filter(Boolean).join("\n")}
              disabled={!model.focusable} onclick={() => view?.focus(input.key)}>
              <span class="thumb">
                {#if input.path && input.present}<TraceThumbnail path={input.path} present={true} {revision} label="" />{:else}<span aria-hidden="true">▧</span>{/if}
              </span>
              <span class="description">
                <span class="title">{inputTitle(input)}</span>
                <span class="location {input.scope}">{scopeLabel(input)} · {input.location}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#key model.artifactId ?? model.runId}
      <details>
        <summary>Raw</summary>
        <pre>{JSON.stringify({ ...(node ? { node } : {}), ...(run ? { run } : {}) }, null, 2)}</pre>
      </details>
    {/key}
  </section>
{/if}

<style>
  .trace-info { padding: 8px 0 4px; color: var(--text-primary); font-size: 12px; }
  h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
  h4 { margin: 10px 0 4px; font-size: 11px; font-weight: 600; color: var(--text-secondary); }
  .prompt { margin: 0 0 10px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; margin: 0 0 10px; font-size: 11px; line-height: 1.4; }
  dt { color: var(--text-secondary); }
  dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .error { color: var(--system-critical-text, var(--system-critical)); overflow-wrap: anywhere; }
  .notice { color: var(--text-secondary); }
  .inputs { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .input { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px; font: inherit; text-align: left; color: var(--text-primary); background: none; border: 1px solid transparent; border-radius: var(--radius-sm); cursor: pointer; }
  .input:disabled { cursor: default; color: var(--text-primary); }
  .input:hover:not(:disabled) { background: var(--subtle-fill-secondary); }
  .input:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 1px; }
  .thumb { display: grid; place-items: center; flex: none; width: 40px; height: 28px; overflow: hidden; border-radius: 2px; color: var(--text-secondary); }
  .thumb :global(.thumbnail) { height: 100% !important; flex-basis: auto !important; }
  .thumb :global(img) { object-fit: cover !important; }
  .description { display: flex; flex-direction: column; min-width: 0; }
  .title, .location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title { font-size: 11px; }
  .location { font-size: 10px; color: var(--text-secondary); }
  .location.subfolder { color: var(--accent-text, var(--accent)); }
  .location.external { color: var(--system-caution-text, var(--system-caution)); }
  summary { cursor: pointer; font-size: 11px; color: var(--text-secondary); padding: 4px 0; margin-top: 8px; }
  summary:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  pre { box-sizing: border-box; max-height: 260px; overflow: auto; margin: 6px 0 0; padding: 8px; border-radius: var(--radius-sm); background: var(--background-card-secondary); color: var(--text-primary); font-size: 10px; line-height: 1.4; }
</style>
