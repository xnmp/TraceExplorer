/** Production adoption of constrained incremental routing (slice 4).
 *
 * On the incremental path the constrained construction runs first. Its result is
 * published only when the unchanged geometry gates certified it (inside the
 * constructor) and the product contracts below hold; otherwise the legacy
 * constructors run in the same request, so no intermediate frame exists. Every
 * attempt is counted by site and outcome. Pure apart from the profile counters. */
import { countLayoutWork } from './layout-profile';
import type { IncrementalConflictReason } from './incremental-routing';
import type { GraphLayout } from './layout';
import { createBoundedCache, estimateLayoutBytes } from './folder-layout/bounded-cache';

/** Why the constrained path declined and legacy ran instead. */
export type AdoptionFallback = 'topology' | 'metric' | 'unsupported' | 'budget' | 'contract';
/** Folder world placement is not adopted: see docs/routing-consolidation.md. */
export type AdoptionSite = 'band-insertion';

/** Interactive limits for band insertion, set from measured click latency so the
 * attempt plus any legacy fallback stays near the legacy baseline
 * (docs/routing-consolidation.md). Work units are not uniform in time (measured
 * p50 about 15 ns, up to about 100 ns each), so this bounds latency by measurement,
 * not by construction; capture and construction grow with the drawing, so the allowance
 * grows with the band: `perItem` work per band item up to `work`.
 *
 * The constructor's local pools scale with the allowance (`poolsPerWork`) and are
 * reserved up front: a family runs only if its pools fit the remaining work.
 * Successes rarely spend their pools (nine in ten spend none), but the
 * reservation competes with construction's other charges, so 1/32M pools
 * declined requests that certify with 1/48M. Smaller pools let a decline spend
 * more of the allowance, so a decline is predicted early instead: a capture
 * costing more than `captureShare` of the allowance stops the attempt before
 * construction. On the production inventory, 145 of the 146 attempts above that
 * share declined anyway. A band of more than `maximumItems` declines as budget
 * before spending any work: larger bands can certify within the ceiling (a
 * 61-item fan does), but their declines added up to 190 ms per click on the eval
 * tours.
 *
 * The anchored repack and the ladder after it re-embed every unanchored tile
 * around the click's ancestry (the `repack` site). Their attempts run only for
 * at most `maximumRepackItems` new tiles: on the production inventory, 205 of
 * the 210 such attempts certify, while more new tiles certify less than half
 * the time and their declines cost a further 14 s over the inventory, taking
 * adopted clicks to 1.6x their legacy p95. Coverage beyond these limits stays
 * with legacy as budget fallbacks. */
export const PRODUCTION_ROUTING_WORK = {
  'band-insertion': { work: 6_000_000, perItem: 375_000, maximumItems: 47, maximumRepackItems: 4, poolsPerWork: 1 / 48_000_000, captureShare: 1 / 20 },
} as const;

/** Where band insertion runs: the incremental insertion around the committed
 * drawing, or the anchored repack around the click's ancestry alone. */
export type InsertionSite = 'insertion' | 'repack';

export interface InteractiveAllowance { readonly work: number; readonly pools: number; readonly captureLimit: number }

/** The band insertion allowance for a band of `items` tiles of which `placed`
 * are new, or null above the interactive size limits (an early budget decline). */
export function bandInsertionAllowance(items: number, site: InsertionSite = 'insertion', placed = 1): InteractiveAllowance | null {
  const { work: ceiling, perItem, maximumItems, maximumRepackItems, poolsPerWork, captureShare } = PRODUCTION_ROUTING_WORK['band-insertion'];
  if (!(items > 0) || items > maximumItems) return null;
  if (site === 'repack' && !(placed <= maximumRepackItems)) return null;
  const work = Math.min(ceiling, perItem * items);
  return { work, pools: work * poolsPerWork, captureLimit: Math.floor(work * captureShare) };
}

export const adoptionFallback = (reason: IncrementalConflictReason): AdoptionFallback =>
  reason === 'topology-conflict' ? 'topology' : reason === 'metric-conflict' ? 'metric'
    : reason === 'budget-exhaustion' ? 'budget' : 'unsupported';

interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The first key whose rectangle is missing or differs in any coordinate, else null.
 * Exact equality: a retained rectangle is a pin, not a preference. */
export function movedRectangle(before: ReadonlyMap<string, Rect>, after: ReadonlyMap<string, Rect>,
  keys: Iterable<string>): string | null {
  for (const key of keys) {
    const a = before.get(key), b = after.get(key);
    if (!a || !b || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return key;
  }
  return null;
}

export function recordAdoption(site: AdoptionSite, outcome: 'success' | AdoptionFallback, work = 0): void {
  countLayoutWork(`adoption:${site}:attempt`);
  countLayoutWork(outcome === 'success' ? `adoption:${site}:success` : `adoption:${site}:fallback:${outcome}`);
  if (work > 0) countLayoutWork(`adoption:${site}:work`, work);
}

/** The constrained drawing won ranking and is the one published. A success
 * only made it a candidate; band ranking may still prefer another embedding. */
export const recordPublication = (site: AdoptionSite): void => countLayoutWork(`adoption:${site}:published`);

export interface AdoptionAttempt { readonly drawing: GraphLayout | null; readonly outcome: 'success' | AdoptionFallback; readonly work: number }
const attempts = createBoundedCache<AdoptionAttempt>(entry => 64 + (entry.drawing ? estimateLayoutBytes(entry.drawing) : 0));

/** Run one counted attempt, reusing an identical earlier one. The key must cover
 * every input of `run`; the attempt is a pure function of them, so a hit returns
 * exactly what recomputation would (worker and main thread alike). Cached values
 * stay private: callers receive a clone. */
export function adoptOnce(site: AdoptionSite, key: string, run: () => AdoptionAttempt): GraphLayout | null {
  const known = attempts.get(key);
  if (known) {
    recordAdoption(site, known.outcome);
    countLayoutWork(`adoption:${site}:cache-hit`);
    return known.drawing && structuredClone(known.drawing);
  }
  const attempt = run();
  recordAdoption(site, attempt.outcome, attempt.work);
  attempts.set(key, { ...attempt, drawing: attempt.drawing && structuredClone(attempt.drawing) });
  return attempt.drawing;
}
