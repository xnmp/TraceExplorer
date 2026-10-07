<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { selectedTraceImage } from "$lib/domain/trace-selection";
  import { traceForImage, traceForJob, type TraceArtifact, type TraceGraph } from "$lib/api/trace";
  import { layoutTraceGraph, traceOperationLabel } from "$lib/domain/trace-layout";
  import { traceBatch, traceBatchGroups } from "$lib/domain/trace-batch";
  import { traceInvalidation } from "./invalidation.svelte";
  import { traceVisibility } from "./visibility.svelte";
  import { cachedTrace, cachedTraceJob, rememberTrace, lastTracePath, noteTracePath, hasTraceSnapshot, rememberEmptyTrace } from "./view-cache";
  import { traceViewTarget } from "./view-target.svelte";
  import { samePath } from "$lib/domain/path";
  import TraceThumbnail from "./TraceThumbnail.svelte";
  import TraceDetails from "./TraceDetails.svelte";
  import TraceImageActions from "./TraceImageActions.svelte";
  import { promptTitles } from "./prompt-titles.svelte";

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
  let viewedImage = $state.raw<FileEntry | null>(untrack(() => selectedTraceImage(entries)));
  let graph = $state<TraceGraph | null>(untrack(() => traceViewTarget.jobId !== null ? cachedTraceJob(traceViewTarget.jobId) : cachedTrace(viewedImage?.path || lastTracePath())));
  let selectedImagePath = untrack(()=>viewedImage?.path || "");
  const activeJobId = $derived(traceViewTarget.jobId);
  let viewedPath=$state(untrack(()=>viewedImage?.path||lastTracePath()));
  let settledPath=$state(untrack(()=>hasTraceSnapshot(viewedPath)?viewedPath:""));
  let loading = $state(false);
  let error = $state("");
  let focusedKey = $state("");
  let explicitFocus = $state<{key:string; path:string} | null>(null);
  let focusRevision = 0;
  function captureImageActionSelection() {
    const current = focusRevision;
    const focused = selectedKey;
    const viewCurrent = traceViewTarget.capture();
    const workspaceCurrent = captureSelection?.() ?? (()=>true);
    return ()=>current===focusRevision && focused===selectedKey && viewCurrent() && workspaceCurrent();
  }
  let treeHeight = $state<number | null>(null);
  let viewportHeight = $state(800);
  let resizeStart: { pointerId: number; y: number; height: number; scale: number } | null = null;
  const maximumTreeHeight = $derived(Math.max(96, Math.min(720, Math.floor(viewportHeight * .65))));
  function resizeTree(height: number) { treeHeight = Math.max(96, Math.min(maximumTreeHeight, height)); }
  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const scale = handle.getBoundingClientRect().height / parseFloat(getComputedStyle(handle).height);
    resizeStart = { pointerId: event.pointerId, y: event.clientY, height: displayedTreeHeight, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
    handle.setPointerCapture(event.pointerId);
  }
  function moveResize(event: PointerEvent) {
    if (resizeStart?.pointerId === event.pointerId) resizeTree(resizeStart.height + (event.clientY - resizeStart.y) / resizeStart.scale);
  }
  function endResize() { resizeStart = null; }
  function resizeKey(event: KeyboardEvent) {
    const height = event.key === "ArrowDown" ? displayedTreeHeight + 16 : event.key === "ArrowUp" ? displayedTreeHeight - 16 : event.key === "Home" ? 96 : event.key === "End" ? maximumTreeHeight : null;
    if (height !== null) { event.preventDefault(); resizeTree(height); }
  }
  function onDiscard(artifact: TraceArtifact, viewPath: string | null) {
    if (activeJobId !== null) { explicitFocus = null; return; }
    if (!samePath(path,artifact.path)) return;
    viewedImage = null;
    viewedPath = viewPath || "";
    noteTracePath(viewedPath);
    explicitFocus = null;
    if (!viewedPath) { graph = null; settledPath = ""; }
  }
  async function selectPermanentFile(path: string) {
    traceViewTarget.clear();
    viewedImage = null;
    viewedPath = path;
    noteTracePath(path);
    await onSelectFile(path);
  }
  function selectTemporaryImage(artifact: TraceArtifact, key: string) {
    focusRevision += 1;
    traceViewTarget.clear();
    viewedImage = null;
    viewedPath = artifact.path;
    noteTracePath(artifact.path);
    explicitFocus = {key,path:artifact.path};
    focusedKey = key;
  }
  const path = $derived(activeJobId !== null ? graph?.selectedPath || "" : viewedImage?.path || viewedPath);
  const hasView=$derived(graph!==null || (!!path&&settledPath===path));
  const layout = $derived.by(() => {
    const snapshot = graph;
    return snapshot ? layoutTraceGraph({ ...snapshot,
      artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact, groupId: traceBatch(snapshot.runs.find(run=>run.id===artifact.generatingRun))?.id, hasCaption: !!artifactCaption(artifact, snapshot) })),
      runs: snapshot.runs.map(run=>({...run,groupId:traceBatch(run)?.id})),
    }) : null;
  });
  const batches = $derived(graph && layout ? traceBatchGroups(graph,layout) : []);
  const selectedKey = $derived(graph && layout?.nodes.some((node) => node.key === focusedKey)
    ? focusedKey : graph ? graph.currentArtifactId > 0 ? `a:${graph.currentArtifactId}` : layout?.nodes.at(-1)?.key || "" : "");
  const displayedTreeHeight = $derived(Math.max(96, Math.min(treeHeight ?? layout?.height ?? 240, maximumTreeHeight)));
  const verificationApplies = $derived(graph?.selectedPath ? samePath(graph.selectedPath,path) : graph?.artifacts.some((artifact) => artifact.id === graph?.currentArtifactId && samePath(artifact.path, path)) ?? false);

  $effect(() => {
    const image = selectedTraceImage(entries);
    const selectedPath = image?.path || "";
    const changed = selectedPath !== selectedImagePath;
    selectedImagePath = selectedPath;
    if (image) {
      if (changed) { traceViewTarget.clear(); viewedImage = image; }
      else if (untrack(()=>traceViewTarget.jobId) === null && samePath(untrack(()=>viewedImage?.path || viewedPath),image.path)) viewedImage = image;
    }
  });
  $effect(() => { const snapshot = graph; if (snapshot && promptTitles.configured) untrack(()=>snapshot.runs.forEach(run=>promptTitles.load(run))); });

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
    const measureViewport = () => { viewportHeight = window.innerHeight; };
    measureViewport();
    window.addEventListener("resize", measureViewport);
    const refresh = () => traceInvalidation.bump();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("resize", measureViewport); };
  });

  $effect(() => {
    const jobId = activeJobId;
    const selectedPath = jobId === null ? path : "";
    if(jobId === null && !selectedPath){loading=false;return;}
    if (jobId === null) {
      viewedPath=selectedPath;
      noteTracePath(selectedPath);
      void viewedImage?.modified;
      void viewedImage?.size;
    }
    void traceInvalidation.revision;
    let cancelled = false;
    untrack(() => {
      if (jobId !== null) {
        if (graph?.jobId !== jobId) graph = cachedTraceJob(jobId);
      } else if (!samePath(graph?.selectedPath ?? "",selectedPath) && !graph?.artifacts.some((artifact) => samePath(artifact.path, selectedPath))) graph = cachedTrace(selectedPath);
      settledPath=hasTraceSnapshot(selectedPath)?selectedPath:"";
    });
    error = "";
    loading = true;
    void (jobId !== null ? traceForJob(jobId) : traceForImage(selectedPath)).then((result) => {
      if (cancelled) return;
      loading = false;
      if (result.ok) {
        graph = result.data;
        settledPath=selectedPath;
        if (!explicitFocus || (jobId === null && !samePath(explicitFocus.path,selectedPath)) || !layoutTraceGraph(result.data ?? {artifacts:[],runs:[]}).nodes.some((node)=>node.key===explicitFocus?.key)) {
          explicitFocus = null;
          focusedKey = result.data && result.data.currentArtifactId > 0 ? `a:${result.data.currentArtifactId}` : "";
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
  {:else if !graph || !layout || !layout.nodes.length}
    {#if error}<p class="changed-notice" role="alert">Could not refresh trace: {error}</p>{/if}
    <p>{activeJobId !== null ? "No generated images remain." : path ? "No recorded edits for this image." : "Select an image to view its trace."}</p>
  {:else}

    {#if error}<p class="changed-notice" role="alert">Could not refresh trace: {error}</p>{/if}

    {#if verificationApplies && graph.selectedRevisionStatus === "changed"}
      <p class="changed-notice" role="status">This file changed since it was recorded. Showing its last recorded revision.</p>
    {:else if verificationApplies && graph.selectedRevisionStatus === "unverified"}
      <p class="changed-notice" role="status">This file exceeds the 200 MiB verification limit. Showing its last recorded revision; its current bytes were not checked.</p>
    {/if}
    <div id="trace-tree" class="trace-scroll" style:height={`${displayedTreeHeight}px`}>
      <div class="trace-canvas" style={`width:${layout.width}px;height:${layout.height}px`} role="list" aria-label="Image provenance">
        {#each batches as batch (batch.id)}
          <div class="batch-frame" role="group" aria-label={`${batch.count} image batch`} style={`left:${batch.x}px;top:${batch.y}px;width:${batch.width}px;height:${batch.height}px`}><span>{batch.count} images</span></div>
        {/each}
        <svg class="trace-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          {#each layout.edges as edge (`${edge.from}-${edge.to}`)}
            <path d={edge.path} />
          {/each}
        </svg>
        {#each layout.nodes as node (node.key)}
          {#if node.kind === "artifact"}
            {@const artifact = graph.artifacts.find((item) => item.id === node.id)}
            {#if artifact}
              {@const generatingRun = graph.runs.find((run)=>run.id===artifact.generatingRun)}
              {@const prompt = generatingRun?.parameters.prompt}
              {@const tooltip = typeof prompt === "string" && prompt.trim() ? prompt : undefined}
              {@const earlierRevision = artifact.id !== graph.currentArtifactId && graph.artifacts.some((item) => item.id !== artifact.id && item.path === artifact.path)}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                {#if artifact.discarded}
                  <div class="discarded-ancestor" title={tooltip}><strong>{promptTitles.label(generatingRun) || "Image"}</strong><small>Deleted</small></div>
                {:else}
                <button type="button" class="artifact" data-path={artifact.path} class:current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched"}
                  title={tooltip}
                  aria-current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched" ? "true" : undefined}
                  aria-pressed={selectedKey === node.key}
                  aria-controls="trace-node-details"
                  onclick={() => {
                    if (artifact.temporary && artifact.pathState === "present") selectTemporaryImage(artifact,node.key);
                    else { explicitFocus={key:node.key,path:artifact.path}; focusedKey=node.key; if(artifact.pathState==="present")void selectPermanentFile(artifact.path); }
                  }}>
                  <TraceThumbnail path={artifact.path} present={artifact.pathState === "present" && !earlierRevision} label={previewLabel(artifact, graph, earlierRevision)} revision={traceInvalidation.revision} prompt={tooltip} />
                  <span class="artifact-text"><span class="artifact-label"><strong>{promptTitles.label(generatingRun) || artifact.path.split(/[\\/]/).at(-1)}</strong>{#if generatingRun && promptTitles.pending(generatingRun.id)}<span class="title-spinner" role="status" aria-label="Generating title"></span>{/if}</span>{#if artifactCaption(artifact, graph)}<small>{artifactCaption(artifact, graph)}</small>{/if}</span>
                </button>
                {#if artifact.temporary && !artifact.discarded}<span class="unsaved-badge">Unsaved</span>{/if}
                {#if artifact.temporary && !artifact.discarded}
                  <div class="node-actions"><TraceImageActions {artifact} onSelectFile={selectPermanentFile} captureSelection={captureImageActionSelection} {onDiscard} selectAfterSave={selectedKey === node.key}/></div>
                {/if}
                {/if}
              </div>
            {/if}
          {:else}
            {@const run = graph.runs.find((item) => item.id === node.id)}
            {#if run}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="operation" title={typeof run.parameters.prompt === "string" ? run.parameters.prompt : undefined} aria-pressed={selectedKey === node.key} aria-controls="trace-node-details" onclick={() => {focusRevision+=1;explicitFocus={key:node.key,path};focusedKey = node.key;}}>
                  {#if run.status === "running"}<span class="spinner" aria-hidden="true"></span>{/if}
                  <strong>{promptTitles.label(run) || (run.status === "running" ? "Generating…" : traceOperationLabel(run.operation))}</strong>
                  {#if promptTitles.pending(run.id)}<span class="title-spinner" role="status" aria-label="Generating title"></span>{/if}
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
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator -->
    <div class="trace-divider" role="separator" tabindex="0" aria-label="Resize trace tree" aria-orientation="horizontal" aria-controls="trace-tree"
      aria-valuemin={96} aria-valuemax={maximumTreeHeight} aria-valuenow={displayedTreeHeight}
      onpointerdown={startResize} onpointermove={moveResize} onpointerup={endResize} onpointercancel={endResize} onlostpointercapture={endResize} onkeydown={resizeKey}>
      <span></span>
    </div>
    <TraceDetails {graph} nodeKey={selectedKey} onSelectFile={selectPermanentFile} captureSelection={captureImageActionSelection} {onDiscard} />
  {/if}
</div>

<style>
  .trace-body { padding: 10px 14px; color: var(--text-secondary); font: inherit; font-size: 12px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .changed-notice { margin-bottom: 12px; }
  .trace-scroll { overflow: auto; min-height: 96px; }
  .trace-divider { box-sizing: border-box; display: grid; place-items: center; height: 13px; margin: 4px -14px 0; border-top: 1px solid var(--surface-stroke); cursor: row-resize; touch-action: none; }
  .trace-divider span { width: 32px; height: 3px; border-radius: 2px; background: var(--control-stroke); }
  .trace-divider:hover span, .trace-divider:focus-visible span { background: var(--accent-text); }
  .trace-divider:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
  .trace-canvas { position: relative; margin: 0 auto; }
  .batch-frame { position: absolute; box-sizing: border-box; border: 1px solid var(--surface-stroke); border-radius: var(--radius-sm); pointer-events: none; }
  .batch-frame span { position: absolute; top: 1px; left: 6px; font-size: 10px; line-height: 14px; color: var(--text-secondary); }
  .trace-edges { position: absolute; inset: 0; pointer-events: none; }
  .trace-edges path { fill: none; stroke: var(--control-stroke); stroke-width: 1.5; }
  .node-frame { position: absolute; }
  .discarded-ancestor { display: flex; flex-direction: column; box-sizing: border-box; height: 100%; padding: 6px 8px; background: var(--background-card-secondary); border: 1px dashed var(--control-stroke); border-radius: var(--radius-sm); }
  .node-actions { position: absolute; top: 4px; right: 4px; max-width: calc(100% - 8px); background: var(--background-solid); border-radius: var(--radius-sm); visibility: hidden; pointer-events: none; }
  .node-actions :global(button) { pointer-events: auto; }
  .unsaved-badge { position: absolute; top: 4px; left: 4px; padding: 2px 4px; font-size: 9px; line-height: 12px; color: var(--text-primary); background: var(--background-solid); border: 1px solid var(--control-stroke); border-radius: 3px; pointer-events: none; }
  .node-frame:hover .node-actions, .node-frame:focus-within .node-actions { visibility: visible; }
  @media (hover: none) { .node-actions { visibility: visible; } }
  button { box-sizing: border-box; width: 100%; height: 100%; font: inherit; cursor: pointer; background: var(--control-fill, var(--background-card-secondary)); color: var(--text-primary); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); }
  button:hover { background: var(--subtle-fill-secondary); }
  button[aria-pressed="true"] { border-color: var(--accent-text); box-shadow: inset 0 0 0 1px var(--accent-text); background: color-mix(in srgb, var(--accent-text) 14%, var(--background-card-secondary)); }
  button:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .artifact { display: flex; flex-direction: column; overflow: hidden; padding: 0; text-align: left; }
  .artifact-text { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; width: 100%; box-sizing: border-box; }
  .artifact-label { display: flex; align-items: center; gap: 5px; min-width: 0; }
  .artifact-label strong { flex: 1; min-width: 0; }
  .title-spinner { width: 8px; height: 8px; flex: none; border: 1px solid var(--control-stroke); border-top-color: var(--accent-text); border-radius: 50%; animation: spin 800ms linear infinite; }
  strong { font-size: 11px; line-height: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  small { color: var(--text-secondary); font-size: 10px; line-height: 12px; }
  .operation { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 6px; }
  .operation strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .operation .spinner, .operation .title-spinner { flex-shrink: 0; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--divider); border-top-color: var(--accent); border-radius: 50%; animation: spin 800ms linear infinite; flex-shrink: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner, .title-spinner { animation: none; } }
</style>
