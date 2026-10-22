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

/** Limits for band insertion. Reach comes first: the allowance is sized so
 * that the constrained path, not the legacy repairs (T24, T25, T28), certifies
 * the clicks it can certify at all (docs/routing-consolidation.md, "Capture
 * pass"). Work units are not uniform in time (measured p50 about 15 ns, up to
 * about 100 ns each), so latency is checked by measurement, not by
 * construction. Capture and construction grow with the drawing, so the
 * allowance grows with the band: `perItem` work per band item up to `work`.
 *
 * The constructor's local pools scale with the allowance (`poolsPerWork`) and
 * are reserved up front: a family runs only if its pools fit the remaining
 * work. At the ceiling they equal the automatic pools (four legacy budgets),
 * which the crowded insertions of the legacy ladder need: on the production
 * inventory, 137 of the 157 insertion inputs that reached legacy certify at
 * 256M with them, 70 at 64M with one budget. A capture costing more than
 * `captureShare` of the allowance still stops the attempt before construction
 * (early decline prediction); capture is now charged for what it reads, so the
 * prediction fires only on very large retained drawings.
 *
 * The anchored repack and the ladder after it re-embed every unanchored tile
 * around the click's ancestry (the `repack` site). They are attempted for any
 * number of new tiles: a size limit there left the legacy repack, and its T24
 * and T28 repairs, as the only path for those clicks, even after the
 * insertion itself had certified. */
export const PRODUCTION_ROUTING_WORK = {
  'band-insertion': { work: 256_000_000, perItem: 8_000_000, poolsPerWork: 1 / 64_000_000, captureShare: 1 / 20 },
  // The anchor-loss escalation: run only for a click whose anchor no other
  // candidate holds, after the ordinary attempt declined for budget alone.
  // The click's own tile would otherwise move. The ceiling bounds the whole
  // request (all its escalated attempts share it), so an escalated click stays
  // within a few seconds of extra work; it helps only bands whose ordinary
  // allowance is below the ceiling.
  'band-insertion-anchor': { work: 256_000_000, perItem: 32_000_000, poolsPerWork: 1 / 64_000_000, captureShare: 1 / 20 },
} as const;

/** Which allowance an attempt runs under: the ordinary interactive one, or the
 * escalation for a click whose anchor would otherwise move. */
export type AllowanceTier = 'interactive' | 'anchor';

export interface InteractiveAllowance { readonly work: number; readonly pools: number; readonly captureLimit: number }

/** The band insertion allowance for a band of `items` tiles, or null for a
 * malformed size (an early budget decline). */
export function bandInsertionAllowance(items: number, tier: AllowanceTier = 'interactive', remaining = Infinity): InteractiveAllowance | null {
  const { work: ceiling, perItem, poolsPerWork, captureShare } = PRODUCTION_ROUTING_WORK[tier === 'anchor' ? 'band-insertion-anchor' : 'band-insertion'];
  if (!(items > 0) || !Number.isSafeInteger(items) || !(remaining > 0)) return null;
  const work = Math.min(ceiling, perItem * items, remaining);
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
/** An attempt's drawing (null on a decline) and why it ended. */
export interface AdoptionResult { readonly drawing: GraphLayout | null; readonly outcome: 'success' | AdoptionFallback; readonly work: number }
const attempts = createBoundedCache<AdoptionAttempt>(entry => 64 + (entry.drawing ? estimateLayoutBytes(entry.drawing) : 0));

/** Run one counted attempt, reusing an identical earlier one. The key must cover
 * every input of `run`; the attempt is a pure function of them, so a hit returns
 * exactly what recomputation would (worker and main thread alike). Cached values
 * stay private: callers receive a clone. */
export function adoptOnce(site: AdoptionSite, key: string, run: () => AdoptionAttempt): AdoptionResult {
  const known = attempts.get(key);
  if (known) {
    recordAdoption(site, known.outcome);
    countLayoutWork(`adoption:${site}:cache-hit`);
    return { drawing: known.drawing && structuredClone(known.drawing), outcome: known.outcome, work: known.work };
  }
  const attempt = run();
  recordAdoption(site, attempt.outcome, attempt.work);
  attempts.set(key, { ...attempt, drawing: attempt.drawing && structuredClone(attempt.drawing) });
  return { drawing: attempt.drawing, outcome: attempt.outcome, work: attempt.work };
}
