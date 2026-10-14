/**
 * Whole-input caching for any folder layout engine. Engines are pure, so a structurally equal
 * input (previous layout included) has a deep-equal output and the cached one is returned.
 * Keys are content keys, not object identities, so inputs rebuilt or cloned across a worker
 * boundary still hit. The cache is bounded (docs/scene-transactions.md §9: 48 entries, 16 MiB
 * estimated, keys included); a result larger than the budget is returned uncached. A throwing
 * input is not cached and throws again.
 */
import { createBoundedCache, estimateFolderLayoutBytes, type CacheBudget } from "./bounded-cache";
import { stableKey } from "./stable-key";
import type { FolderLayout, FolderLayoutEngine } from "./types";

export interface MemoizedEngine extends FolderLayoutEngine {
  /** Entries and estimated bytes currently held. */
  readonly stats: () => { readonly entries: number; readonly bytes: number };
  readonly clear: () => void;
}

export function memoizeEngine(engine: FolderLayoutEngine, options: CacheBudget = {}): MemoizedEngine {
  const cache = createBoundedCache<FolderLayout>(estimateFolderLayoutBytes, options);
  const memoized = ((input) => {
    const key = stableKey(input);
    const known = cache.get(key);
    if (known) return known;
    const layout = engine(input);
    cache.set(key, layout);
    return layout;
  }) as MemoizedEngine;
  return Object.assign(memoized, { stats: () => ({ entries: cache.size, bytes: cache.bytes }), clear: () => cache.clear() });
}
