<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { traceForImage, type TraceArtifact, type TraceGraph } from "$lib/api/trace";
  import { layoutTraceGraph, traceOperationLabel } from "$lib/domain/trace-layout";
  import { traceInvalidation } from "./invalidation.svelte";
  import { traceVisibility } from "./visibility.svelte";
  import { cachedTrace, rememberTrace, lastTracePath, noteTracePath, hasTraceSnapshot, rememberEmptyTrace } from "./view-cache";
  import { samePath } from "$lib/domain/path";
  import TraceThumbnail from "./TraceThumbnail.svelte";
  import TraceDetails from "./TraceDetails.svelte";

  function artifactCaption(artifact: TraceArtifact, graph: TraceGraph): string {
    if (artifact.pathState === "missing") return "Missing";
    if (artifact.id !== graph.currentArtifactId) return "";
    return graph.selectedRevisionStatus === "matched" ? "" : "Last recorded";
  }

  function previewLabel(artifact: TraceArtifact, graph: TraceGraph, earlierRevision: boolean): string {
    if (earlierRevision) return "Earlier revision";
    if (artifact.id !== graph.currentArtifactId) return "";
    if (graph.selectedRevisionStatus === "changed") return "Modified file preview";
    if (graph.selectedRevisionStatus === "unverified") return "Unverified file preview";
    return "";
  }

  let { entries, onSelectFile, captureSelection }: { entries: FileEntry[]; onSelectFile: (path: string) => Promise<void>; captureSelection?:()=>()=>boolean } = $props();
  let graph = $state<TraceGraph | null>(untrack(() => cachedTrace(entries[0]?.path || lastTracePath())));
  let viewedPath=$state(untrack(()=>entries[0]?.path||lastTracePath()));
  let settledPath=$state(untrack(()=>hasTraceSnapshot(viewedPath)?viewedPath:""));
  let loading = $state(false);
  let error = $state("");
  let focusedKey = $state("");
  let explicitFocus = $state<{key:string; path:string} | null>(null);
  const path = $derived(entries[0]?.path || viewedPath);
  const hasView=$derived(graph!==null || (!!path&&settledPath===path));
  const layout = $derived.by(() => {
    const snapshot = graph;
    return snapshot ? layoutTraceGraph({ ...snapshot, artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact, hasCaption: !!artifactCaption(artifact, snapshot) })) }) : null;
  });
  const selectedKey = $derived(graph && layout?.nodes.some((node) => node.key === focusedKey)
    ? focusedKey : graph ? `a:${graph.currentArtifactId}` : "");
  const verificationApplies = $derived(graph?.selectedPath ? samePath(graph.selectedPath,path) : graph?.artifacts.some((artifact) => artifact.id === graph?.currentArtifactId && samePath(artifact.path, path)) ?? false);

  $effect(() => {
    const selectedPath = path;
    if(!selectedPath)return;
    untrack(() => {
      const currentGraph = graph;
      if (explicitFocus && samePath(explicitFocus.path,selectedPath)) return;
      explicitFocus = null;
      // Before verification finishes, choose the newest cached revision at
      // this path. The response below then selects its authoritative revision.
      const artifact = currentGraph?.artifacts.filter((item) => samePath(item.path, selectedPath)).reduce<TraceArtifact | undefined>((latest,item)=>!latest||item.id>latest.id?item:latest,undefined);
      focusedKey = artifact ? `a:${artifact.id}` : "";
    });
  });

  onMount(() => {
    traceVisibility.opened();
    const refresh = () => traceInvalidation.bump();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  });

  $effect(() => {
    const selectedPath = path;
    if(!selectedPath){loading=false;return;}
    viewedPath=selectedPath;
    noteTracePath(selectedPath);
    void entries[0]?.modified;
    void entries[0]?.size;
    void traceInvalidation.revision;
    let cancelled = false;
    untrack(() => {
      if (!samePath(graph?.selectedPath ?? "",selectedPath) && !graph?.artifacts.some((artifact) => samePath(artifact.path, selectedPath))) graph = cachedTrace(selectedPath);
      settledPath=hasTraceSnapshot(selectedPath)?selectedPath:"";
    });
    error = "";
    loading = true;
    void traceForImage(selectedPath).then((result) => {
      if (cancelled) return;
      loading = false;
      if (result.ok) {
        graph = result.data;
        settledPath=selectedPath;
        if (!explicitFocus || !samePath(explicitFocus.path,selectedPath) || !layoutTraceGraph(result.data ?? {artifacts:[],runs:[]}).nodes.some((node)=>node.key===explicitFocus?.key)) {
          explicitFocus = null;
          focusedKey = result.data ? `a:${result.data.currentArtifactId}` : "";
        }
        if (result.data) rememberTrace(result.data);
        else rememberEmptyTrace(selectedPath);
      }
      else error = result.error;
    });
    return () => { cancelled = true; };
  });
</script>

<div class="trace-body" aria-busy={loading}>
  {#if loading && !hasView}
    <p role="status">Loading trace…</p>
  {:else if error && !hasView}
    <p role="alert">{error}</p>
  {:else if !graph || !layout}
    {#if error}<p class="changed-notice" role="alert">Could not refresh trace: {error}</p>{/if}
    <p>{path ? "No recorded edits for this image." : "Select an image to view its trace."}</p>
  {:else}

    {#if error}<p class="changed-notice" role="alert">Could not refresh trace: {error}</p>{/if}

    {#if verificationApplies && graph.selectedRevisionStatus === "changed"}
      <p class="changed-notice" role="status">This file changed since it was recorded. Showing its last recorded revision.</p>
    {:else if verificationApplies && graph.selectedRevisionStatus === "unverified"}
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
              {@const prompt = graph.runs.find((run)=>run.id===artifact.generatingRun)?.parameters.prompt}
              {@const tooltip = typeof prompt === "string" && prompt.trim() ? prompt : undefined}
              {@const earlierRevision = artifact.id !== graph.currentArtifactId && graph.artifacts.some((item) => item.id !== artifact.id && item.path === artifact.path)}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="artifact" class:current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched"}
                  title={tooltip}
                  aria-current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched" ? "true" : undefined}
                  aria-pressed={selectedKey === node.key}
                  aria-controls="trace-node-details"
                  onclick={() => { explicitFocus={key:node.key,path:artifact.path}; focusedKey = node.key; if (artifact.pathState === "present") void onSelectFile(artifact.path); }}>
                  <TraceThumbnail path={artifact.path} present={artifact.pathState === "present" && !earlierRevision} label={previewLabel(artifact, graph, earlierRevision)} revision={traceInvalidation.revision} prompt={tooltip} />
                  <span class="artifact-text"><strong>{artifact.path.split(/[\\/]/).at(-1)}</strong>{#if artifactCaption(artifact, graph)}<small>{artifactCaption(artifact, graph)}</small>{/if}</span>
                </button>
              </div>
            {/if}
          {:else}
            {@const run = graph.runs.find((item) => item.id === node.id)}
            {#if run}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="operation" aria-pressed={selectedKey === node.key} aria-controls="trace-node-details" onclick={() => {explicitFocus={key:node.key,path};focusedKey = node.key;}}>
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
    <TraceDetails {graph} nodeKey={selectedKey} {onSelectFile} {captureSelection} />
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
  button[aria-pressed="true"] { border-color: var(--accent-text); box-shadow: inset 0 0 0 1px var(--accent-text); background: color-mix(in srgb, var(--accent-text) 14%, var(--background-card-secondary)); }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .artifact { display: flex; flex-direction: column; overflow: hidden; padding: 0; text-align: left; }
  .artifact-text { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; width: 100%; box-sizing: border-box; }
  strong { font-size: 11px; line-height: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { color: var(--text-secondary); font-size: 10px; line-height: 12px; }
  .operation { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
