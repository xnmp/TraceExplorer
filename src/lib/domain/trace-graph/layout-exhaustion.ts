/**
 * Typed exhaustion diagnostics (routing slice 6). When every bounded
 * construction for a request fails, the engine says why instead of failing
 * anonymously. The reasons are the incremental solve's own four:
 * - `budget-exhaustion`: a bounded search ran out of work before it found an
 *   embedding. More work might find one;
 * - `metric-conflict`: an embedding was found, but its coordinates violate a
 *   constraint (the solve's own, or the independent gate's);
 * - `topology-conflict`: no discrete embedding (rows, corridors, order, the
 *   request's pins) admits the request;
 * - `unsupported-input`: no construction applies to this input.
 * None of these is published: the last committed scene stays committed until a
 * complete certified result exists (the fallback boundary).
 */
import type { CorridorConflict } from './corridor-search';
import type { IncrementalConflictReason } from './incremental-routing';

export type ExhaustionReason = IncrementalConflictReason;

/** How one bounded construction ended without a publishable drawing. */
export type AttemptOutcome =
  /** The construction does not apply to this input (or does not fit it). */
  | 'not-applicable'
  /** A pinned state skipped a construction that ignores history. */
  | 'pinned-skip'
  /** The corridor search found no topology. */
  | 'topology'
  /** The separation solve found no coordinates for the chosen topology. */
  | 'metric'
  /** The search spent its work bound. */
  | 'search-exhausted'
  /** The search rejected its own input or budget. */
  | 'invalid'
  /** A completed drawing failed the independent gate. */
  | 'gate-rejected'
  /** A certified drawing moved a pinned rectangle. */
  | 'pins-lost';

export const corridorOutcome = (conflict: CorridorConflict): AttemptOutcome => conflict.kind;

/** The reason a corridor conflict alone gives. */
export function conflictReason(kind: CorridorConflict['kind']): ExhaustionReason {
  return kind === 'search-exhausted' ? 'budget-exhaustion' : kind === 'invalid' ? 'unsupported-input'
    : kind === 'metric' ? 'metric-conflict' : 'topology-conflict';
}

/**
 * The reason a whole failed ladder gives: the furthest stage any attempt
 * reached. A spent budget comes first, since more work is the one change that
 * could still succeed. Then a certified drawing that moved a pin: its
 * geometry was sound, so the pins conflict with the embedding's topology.
 * Then a drawing whose coordinates failed; then a topology that admitted no
 * drawing; otherwise nothing applied.
 */
export function exhaustionReason(outcomes: readonly AttemptOutcome[]): ExhaustionReason {
  if (outcomes.includes('search-exhausted')) return 'budget-exhaustion';
  if (outcomes.includes('pins-lost')) return 'topology-conflict';
  if (outcomes.some(outcome => outcome === 'metric' || outcome === 'gate-rejected')) return 'metric-conflict';
  if (outcomes.includes('topology')) return 'topology-conflict';
  return 'unsupported-input';
}

/**
 * Every bounded construction failed. A `RangeError`, as the anonymous failure
 * it replaces was, so callers that keep the last committed scene on an engine
 * error are unchanged; the reason also leads the message, which is what
 * crosses the worker boundary.
 */
export class LayoutExhaustedError extends RangeError {
  readonly reason: ExhaustionReason;
  constructor(readonly scope: 'band' | 'folder', readonly outcomes: readonly AttemptOutcome[], detail = '', cause?: unknown) {
    const reason = exhaustionReason(outcomes);
    super(`No certified ${scope} layout (${reason})${detail ? ': ' + detail : ''}`, cause === undefined ? undefined : { cause });
    this.reason = reason;
  }
}
