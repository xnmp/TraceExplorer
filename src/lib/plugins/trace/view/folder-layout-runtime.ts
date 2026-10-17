/**
 * Where the Trace view runs the folder layout engine: the registered default engine, with one
 * band cache shared by every pane. Inline runs use separate construction and drawing budgets
 * (`canLayoutFolderInline`) for construction, restore decoding and certification. Cached
 * bands still need packing and certification; heavier runs go to the layout worker, whose bands are then
 * remembered here so the next inline run reuses them.
 *
 * The engine is not wrapped in a whole-input cache (`memoizeEngine`): the scene controller
 * reuses a committed or recent layout whose basis is unchanged, and a repeated input finds
 * every band in the band cache, so a whole-input key would only add a walk of the input and
 * its previous layout to every request (a quarter to a third of a typical one). The inline
 * check and the run that follows it plan the input once.
 */
import { folderBandWork } from "$lib/domain/trace-graph/folder-layout/default-engine";
import { canLayoutFolderInline, canRetainFolderInline } from "$lib/domain/trace-graph/layout-workload";
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
        return canRetainFolderInline(input) && canLayoutFolderInline(input.items, folderBandWork(input, bands));
      }
      catch { return true; } // Invalid geometry fails the same way inline, at once.
    },
    remember: (layout) => rememberBands(layout, bands),
  };
}

let shared: FolderLayoutRuntime | null = null;
/** The runtime every Trace pane shares (one band cache, bounded). */
export const folderLayoutRuntime = (): FolderLayoutRuntime => (shared ??= createFolderLayoutRuntime());
