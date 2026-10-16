/**
 * Bounded least-recently-used caches for layout results, and the conservative byte estimates
 * that bound them. The budget follows docs/scene-transactions.md §9: at most 48 entries and
 * 16 MiB estimated, keys included; a result larger than the whole budget is returned uncached.
 */
import type { GraphLayout } from "../layout";
import type { BandScenePlan } from "../scene";
import type { FolderLayout } from "./types";

export const CACHE_ENTRIES = 48;
export const CACHE_BYTES = 16 * 1024 * 1024;

export interface CacheBudget {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface BoundedCache<V> {
  get(key: string): V | undefined;
  /** Stores `value` unless it alone exceeds the budget; evicts least recently used entries to fit. */
  set(key: string, value: V): void;
  readonly size: number;
  /** Estimated bytes held, keys included. */
  readonly bytes: number;
  clear(): void;
}

const budgetValue = (value: number | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
};

export function createBoundedCache<V>(estimate: (value: V) => number, budget: CacheBudget = {}): BoundedCache<V> {
  const maxEntries = budgetValue(budget.maxEntries, CACHE_ENTRIES, "maxEntries");
  const maxBytes = budgetValue(budget.maxBytes, CACHE_BYTES, "maxBytes");
  const entries = new Map<string, { readonly value: V; readonly bytes: number }>();
  let bytes = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Most recently used last.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      remove(key);
      const size = 2 * key.length + estimate(value);
      if (!(size <= maxBytes) || maxEntries < 1) return;
      while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) remove(entries.keys().next().value!);
      entries.set(key, { value, bytes: size });
      bytes += size;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
    clear() { entries.clear(); bytes = 0; },
  };
}

/** Rough heap sizes: generous per-object overheads, two bytes per string character. */
const OBJECT = 64, ENTRY = 32;
const text = (value: string | undefined) => 2 * (value?.length ?? 0);

export function estimateLayoutBytes(layout: GraphLayout): number {
  let total = OBJECT * 4;
  for (const node of layout.nodes.values()) total += ENTRY + OBJECT + text(node.key);
  for (const junction of layout.junctions.values()) total += ENTRY + OBJECT + text(junction.id) + 16 * junction.parents.length;
  const tables = new Set<readonly unknown[]>();
  for (const route of layout.routes) {
    total += OBJECT * 3 + text(route.id) + text(route.path);
    const c = route.consumers;
    const entries = Array.isArray(c) ? c : (c as { entries: readonly unknown[] }).entries;
    if (!tables.has(entries)) { tables.add(entries); total += OBJECT * entries.length; }
  }
  for (const row of layout.rows) total += OBJECT + 16 * row.keys.length;
  total += ENTRY * layout.readingOrder.size;
  return total;
}

/** Plans hold the request, whose history refers to two more layouts. */
function estimatePlanBytes(plan: BandScenePlan): number {
  const request = plan.request;
  let total = OBJECT * 4 + (OBJECT + ENTRY) * plan.tiles.size + ENTRY * plan.lineage.related.size + ENTRY * plan.badges.size;
  total += (OBJECT + 16) * (request.items.length + (request.band?.items.length ?? 0));
  for (const item of request.items) total += 16 * item.parents.length;
  for (const item of request.band?.items ?? []) total += 16 * item.parents.length;
  if (request.hint) total += ENTRY * request.hint.size;
  if (request.history) total += estimateLayoutBytes(request.history.layout) + estimateLayoutBytes(request.history.placed) + text(request.history.signature);
  return total;
}

export function estimateFolderLayoutBytes(layout: FolderLayout, seen = new Set<object>()): number {
  if (seen.has(layout)) return 0;
  seen.add(layout);
  let total = OBJECT * 4 + (ENTRY + OBJECT) * (layout.cells.size + layout.bands.length + layout.rowBands.length);
  for (const graph of layout.graphs.values()) {
    total += OBJECT * 3 + estimatePlanBytes(graph.plan) + estimateLayoutBytes(graph.layout) + estimateLayoutBytes(graph.attached);
    if (graph.canonical) total += estimatePlanBytes({ ...graph.plan, request: graph.canonical.request }) + estimateLayoutBytes(graph.canonical.layout);
  }
  for (const arrival of layout.arrivals?.values() ?? []) {
    total += OBJECT + text(arrival.contents);
    if (arrival.history) total += text(arrival.history.signature) + estimateLayoutBytes(arrival.history.layout) + estimateLayoutBytes(arrival.history.placed);
  }
  if (layout.arrivalPlacement) total += OBJECT + text(layout.arrivalPlacement.basis) + estimateFolderLayoutBytes(layout.arrivalPlacement.layout, seen);
  return total;
}
