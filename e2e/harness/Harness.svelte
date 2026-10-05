<script lang="ts">
  import TraceInspector from "$lib/plugins/trace/TraceInspector.svelte";
  import { clearTraceCache } from "$lib/plugins/trace/view-cache";
  import { traceInvalidation } from "$lib/plugins/trace/invalidation.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { paths } from "./fixture";
  const entry = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "file", size: 32, modified: "2026-10-05T00:00:00Z" });
  let entries = $state([entry(paths.source)]);
  let mountRevision = $state(0);
  let remountOnFolderChange = true;
  let leaseEnabled = $state(false);
  let selectionVersion = 0;
  const selections: string[] = [];
  const folder = (path: string) => path.slice(0, path.lastIndexOf("/"));
  export function select(path: string, forceRemount = false) {
    const crossFolder = folder(path) !== folder(entries[0].path);
    entries = [entry(path)];
    selectionVersion += 1;
    if ((crossFolder && remountOnFolderChange) || forceRemount) mountRevision += 1;
  }
  export function reset(path = paths.source) { clearTraceCache(); entries = [entry(path)]; mountRevision += 1; }
  export function remount() { mountRevision += 1; }
  export function refresh() { traceInvalidation.bump(); }
  export function keepInspectorMounted() { remountOnFolderChange = false; }
  export function enableSelectionLease() { leaseEnabled = true; }
  export function invalidateSelectionLease() { selectionVersion += 1; }
  export function selectionCalls() { return [...selections]; }
  function captureSelection() { const version=selectionVersion; return () => version===selectionVersion; }
  async function onSelectFile(path: string) { selections.push(path); select(path); }
</script>
<main>
  <h1>Trace cache browser fixture</h1>
  <p data-explorer-selection>{entries[0].path}</p>
  <nav aria-label="Fixture Explorer">
    {#each Object.entries(paths) as [name, path]}
      <button type="button" onclick={() => select(path)}>Explorer: {name}</button>
    {/each}
    <button type="button" onclick={remount}>Remount inspector</button>
    <button type="button" onclick={refresh}>Refresh trace</button>
  </nav>
  <section class="inspector" aria-label="Inspector fixture">
    {#key mountRevision}<TraceInspector {entries} {onSelectFile} captureSelection={leaseEnabled ? captureSelection : undefined} />{/key}
  </section>
</main>
<style>
  :global(body) { margin: 0; background: #f5f6f7; font: 13px system-ui; --text-primary: #20252e; --text-secondary: #68717e; --background-card-secondary: #fff; --background-solid: #fff; --control-stroke: #cbd1d8; --surface-stroke: #d9dfe5; --radius-sm: 6px; --subtle-fill-secondary: #edf2fd; --accent-text: #175dd8; --focus-stroke-outer: #175dd8; }
  main { max-width: 850px; margin: 20px auto; padding: 0 18px; }
  h1 { font-size: 20px; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
  nav button { padding: 8px; border: 1px solid #bdc5d0; border-radius: 5px; background: white; cursor: pointer; }
  .inspector { width: 380px; min-height: 560px; border: 1px solid #d9dfe5; background: white; border-radius: 8px; }
</style>
