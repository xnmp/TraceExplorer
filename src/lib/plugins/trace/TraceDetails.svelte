<script lang="ts">
  import type { TraceGraph } from "$lib/api/trace";
  import { traceOperationLabel } from "$lib/domain/trace-layout";
  import { basename } from "$lib/domain/path";
  let { graph, nodeKey }: { graph: TraceGraph; nodeKey: string } = $props();
  const id = $derived(Number(nodeKey.slice(2)));
  const artifact = $derived(nodeKey.startsWith("a:") ? graph.artifacts.find((item) => item.id === id) : undefined);
  const run = $derived(graph.runs.find((item) => item.id === (artifact?.generatingRun ?? (nodeKey.startsWith("r:") ? id : -1))));
  const prompt = $derived(typeof run?.parameters.prompt === "string" ? run.parameters.prompt : "");
  const settings = $derived(run ? [
    ["Resolution", run.parameters.resolution],
    ["Aspect ratio", run.parameters.aspect_ratio === "keep" ? "Keep the same" : run.parameters.aspect_ratio],
    ["Size", run.parameters.size],
    ["Quality", run.parameters.quality],
    ["Seed", run.parameters.seed],
  ].filter(([, value]) => value != null && value !== "auto") : []);
</script>

<section id="trace-node-details" class="details" aria-label="Trace details">
  <h2 aria-live="polite">{artifact ? basename(artifact.path) : run ? traceOperationLabel(run.operation) : ""}</h2>
  {#if prompt}<p class="prompt">{prompt}</p>{/if}
  {#if settings.length}
    <dl>{#each settings as [label, value]}<dt>{label}</dt><dd>{String(value)}</dd>{/each}</dl>
  {/if}
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
  h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
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
