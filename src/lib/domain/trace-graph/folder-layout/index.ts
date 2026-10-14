/** Registered folder layout engines; the contract suite and `layout-eval` run every one. */
import { defaultFolderLayout } from "./default-engine";
import type { FolderLayoutEngine } from "./types";

export const engines: Readonly<Record<string, FolderLayoutEngine>> = Object.freeze({ default: defaultFolderLayout });

export type * from "./types";
export { memoizeEngine, type MemoizedEngine } from "./memoize";
export { defaultFolderLayout, createDefaultEngine, uncachedBandRequests, rememberBands, type DefaultEngineOptions } from "./default-engine";
export { CACHE_BYTES, CACHE_ENTRIES, createBoundedCache, estimateLayoutBytes, type BoundedCache, type CacheBudget } from "./bounded-cache";
