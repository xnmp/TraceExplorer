/** Registered folder layout engines; the contract suite and `layout-eval` run every one. */
import { createDefaultEngine, defaultFolderLayout } from "./default-engine";
import { BAND_PHASE3 } from "../band-layout";
import type { FolderLayoutEngine } from "./types";

/** `default` is production; `phase3` is the engine as merged in #79 (history expires on growth), kept for A/B. */
export const engines: Readonly<Record<string, FolderLayoutEngine>> = Object.freeze({ default: defaultFolderLayout, phase3: createDefaultEngine({ band: BAND_PHASE3 }) });

export type * from "./types";
export { memoizeEngine, type MemoizedEngine } from "./memoize";
export { defaultFolderLayout, createDefaultEngine, uncachedBandRequests, rememberBands, type DefaultEngineOptions } from "./default-engine";
export { CACHE_BYTES, CACHE_ENTRIES, createBoundedCache, estimateLayoutBytes, type BoundedCache, type CacheBudget } from "./bounded-cache";
