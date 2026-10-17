/**
 * Where the Trace view runs the folder layout engine: the registered default engine, with one
 * band cache shared by every pane. Inline runs are decided by Phase 2's workload rule
 * (`canLayoutInline`) applied to construction, restore decoding and certification. Cached
 * bands still need packing and certification; heavier runs go to the layout worker, whose bands are then
 * remembered here so the next inline run reuses them.
 *
 * The engine is not wrapped in a whole-input cache (`memoizeEngine`): the scene controller
 * reuses a committed or recent layout whose basis is unchanged, and a repeated input finds
 * every band in the band cache, so a whole-input key would only add a walk of the input and
 * its previous layout to every request (a quarter to a third of a typical one). The inline
 * check and the run that follows it plan the input once.
 */
import { folderBandRequests } from "$lib/domain/trace-graph/folder-layout/default-engine";
import { layoutWorkload, withinInlineBudget } from "$lib/domain/trace-graph/layout-workload";
import { createBoundedCache, createDefaultEngine, estimateLayoutBytes, rememberBands,
  type FolderLayout, type FolderLayoutEngine, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";

export interface FolderLayoutRuntime {
  readonly engine: FolderLayoutEngine;
  /** Whether running the engine on `input` here is within the inline budget. */
  inline(input: FolderLayoutInput): boolean;
  /** Keeps the bands of a layout computed off the main thread. */
  remember(layout: FolderLayout): void;
}

export function createFolderLayoutRuntime(): FolderLayoutRuntime {
  const bands = createBoundedCache(estimateLayoutBytes);
  const engine = createDefaultEngine({ bandCache: bands });
  return {
    engine,
    inline(input) {
      try {
        // A cache hit still decodes and certifies the committed folder. Check the
        // retained drawing before planning, so large refreshes dispatch cheaply.
        const retained = { tiles: input.items.length, edges: 0, pathBytes: 0 };
        for (const graph of input.previous?.graphs.values() ?? []) {
          retained.tiles += graph.attached.nodes.size;
          retained.edges += graph.attached.routes.length;
          if (!withinInlineBudget(retained)) return false;
          for (const route of graph.attached.routes) retained.pathBytes += 2 * route.path.length;
        }
        // Serialized snapshots also have a decoding cost. Use the largest entry
        // as a cheap upper bound before the state key has been planned.
        for (const entry of input.previous?.displays?.entries ?? []) {
          if (Array.isArray(entry) && typeof entry[1] === 'string') retained.pathBytes = Math.max(retained.pathBytes, 2 * entry[1].length);
        }
        if (!withinInlineBudget(retained)) return false;
        return withinInlineBudget(folderBandRequests(input).reduce((sum,request)=>{
        const work=layoutWorkload(request);
        return {tiles:sum.tiles+work.tiles,edges:sum.edges+work.edges,pathBytes:sum.pathBytes+work.pathBytes};
      },retained)); }
      catch { return true; } // Invalid geometry fails the same way inline, at once.
    },
    remember: (layout) => rememberBands(layout, bands),
  };
}

let shared: FolderLayoutRuntime | null = null;
/** The runtime every Trace pane shares (one band cache, bounded). */
export const folderLayoutRuntime = (): FolderLayoutRuntime => (shared ??= createFolderLayoutRuntime());
