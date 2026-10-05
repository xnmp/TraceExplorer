<script lang="ts">
  import { onMount } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { traceForImage, type TraceArtifact, type TraceGraph } from "$lib/api/trace";
  import { layoutTraceGraph, traceOperationLabel } from "$lib/domain/trace-layout";
  import { traceInvalidation } from "./invalidation.svelte";
  import TraceThumbnail from "./TraceThumbnail.svelte";
  import TraceDetails from "./TraceDetails.svelte";

  function artifactCaption(artifact: TraceArtifact, graph: TraceGraph): string {
    if (artifact.pathState === "missing") return "Missing";
    if (artifact.id !== graph.currentArtifactId) return "";
    return graph.selectedRevisionStatus === "matched" ? "Current" : "Last recorded";
  }

  let { entries, onSelectFile }: { entries: FileEntry[]; onSelectFile: (path: string) => Promise<void> } = $props();
  let graph = $state<TraceGraph | null>(null);
  let loading = $state(false);
  let error = $state("");
  let focusedKey = $state("");
  const path = $derived(entries[0]?.path ?? "");
  const layout = $derived(graph ? layoutTraceGraph(graph) : null);
  const selectedKey = $derived(graph && layout?.nodes.some((node) => node.key === focusedKey)
    ? focusedKey : graph ? `a:${graph.currentArtifactId}` : "");

  $effect(() => {
    void path;
    focusedKey = "";
  });

  onMount(() => {
    const refresh = () => traceInvalidation.bump();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  });

  $effect(() => {
    const selectedPath = path;
    void entries[0]?.modified;
    void entries[0]?.size;
    void traceInvalidation.revision;
    let cancelled = false;
    graph = null;
    error = "";
    loading = true;
    void traceForImage(selectedPath).then((result) => {
      if (cancelled) return;
      loading = false;
      if (result.ok) graph = result.data;
      else error = result.error;
    });
    return () => { cancelled = true; };
  });
</script>

<div class="trace-body">
  {#if loading}
    <p role="status">Loading trace…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if !graph || !layout}
    <p>No recorded edits for this image.</p>
  {:else}

    {#if graph.selectedRevisionStatus === "changed"}
      <p class="changed-notice" role="status">This file changed since it was recorded. Showing its last recorded revision.</p>
    {:else if graph.selectedRevisionStatus === "unverified"}
      <p class="changed-notice" role="status">This file exceeds the 200 MiB verification limit. Showing its last recorded revision; its current bytes were not checked.</p>
    {/if}
    <div class="trace-scroll">
      <div class="trace-canvas" style={`width:${layout.width}px;height:${layout.height}px`} role="list" aria-label="Image provenance">
        <svg class="trace-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          {#each layout.edges as edge (`${edge.from}-${edge.to}`)}
            <path d={edge.path} />
          {/each}
        </svg>
        {#each layout.nodes as node (node.key)}
          {#if node.kind === "artifact"}
            {@const artifact = graph.artifacts.find((item) => item.id === node.id)}
            {#if artifact}
              {@const earlierRevision = artifact.id !== graph.currentArtifactId && graph.artifacts.some((item) => item.id !== artifact.id && item.path === artifact.path)}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="artifact" class:current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched"}
                  aria-current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched" ? "true" : undefined}
                  aria-pressed={selectedKey === node.key}
                  aria-controls="trace-node-details"
                  onclick={() => { focusedKey = node.key; if (artifact.pathState === "present") void onSelectFile(artifact.path); }}>
                  <TraceThumbnail path={artifact.path} present={artifact.pathState === "present" && !earlierRevision} label={earlierRevision ? "Earlier revision" : artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched" ? "" : "Current file preview"} revision={traceInvalidation.revision} />
                  <span class="artifact-text"><strong>{artifact.path.split(/[\\/]/).at(-1)}</strong><small>{artifactCaption(artifact, graph)}</small></span>
                </button>
              </div>
            {/if}
          {:else}
            {@const run = graph.runs.find((item) => item.id === node.id)}
            {#if run}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="operation" aria-pressed={selectedKey === node.key} aria-controls="trace-node-details" onclick={() => focusedKey = node.key}>
                  {#if run.status === "running"}<span class="spinner" aria-hidden="true"></span>{/if}
                  <strong>{run.status === "running" ? "Generating…" : traceOperationLabel(run.operation)}</strong>
                  {#if run.parameters.rect}
                    <small>{run.parameters.rect.right - run.parameters.rect.left} × {run.parameters.rect.bottom - run.parameters.rect.top}</small>
                  {/if}
                  {#if run.status !== "succeeded" && run.status !== "running"}<small class="run-status">{run.status}</small>{/if}
                </button>
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    </div>
    <TraceDetails {graph} nodeKey={selectedKey} />
  {/if}
</div>

<style>
  .trace-body { padding: 12px; color: var(--text-secondary); font-size: 12px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .changed-notice { margin-bottom: 12px; }
  .trace-scroll { overflow: auto; margin-bottom: 12px; }
  .trace-canvas { position: relative; margin: 0 auto; }
  .trace-edges { position: absolute; inset: 0; pointer-events: none; }
  .trace-edges path { fill: none; stroke: var(--control-stroke); stroke-width: 1.5; }
  .node-frame { position: absolute; }
  button { box-sizing: border-box; width: 100%; height: 100%; font: inherit; cursor: pointer; background: var(--background-card-secondary); color: var(--text-primary); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); }
  button:hover { background: var(--subtle-fill-secondary); }
  button[aria-pressed="true"] { border-color: var(--accent-text); }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .artifact { display: flex; flex-direction: column; overflow: hidden; padding: 0; text-align: left; }
  .artifact-text { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; width: 100%; box-sizing: border-box; }
  strong { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { color: var(--text-secondary); font-size: 10px; }
  .operation { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
