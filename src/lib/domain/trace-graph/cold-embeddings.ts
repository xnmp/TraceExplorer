/**
 * Cold embedding generators (routing slice 5a). Each generator makes one
 * discrete choice, how a generation's tiles are distributed over display rows,
 * and hands it to the common layered solve (`layoutLayered`): the same junction
 * plan, corridor search, separation solve and emitter as every other cold
 * candidate. No generator routes, offsets lanes or repairs anything itself.
 * This follows ELK Layered's split of layering, ordering and node placement
 * ahead of one orthogonal router. Null means the solve found no topology
 * within its bound for this embedding; it is not a proof of infeasibility.
 */
import { layoutLayered, RoutingConflictError, type GraphLayout, type LayeredOptions, type LayoutRequest } from './layout';
import { withPaneBandBounds } from './band-geometry';
import { spacingFor } from './metrics';
import { inReach } from './coordinate-space';
import { corridorOutcome, type AttemptOutcome } from './layout-exhaustion';

/** Discrete embedding choice; the solve and its constraints are shared. */
export interface ColdEmbedding {
  readonly name: 'serial-rows' | 'grid-rows';
  /** Maximum tiles per display row of a generation. */
  readonly capacity: number;
  /**
   * The solve's row width, when it is not the pane's: tiles too large for the
   * pane, whose pane-fitting rows would leave the coordinate reach.
   */
  readonly width?: number;
}

/** The band's ordering and passing policy, and optionally the solve's work bound; spacing and routing style are the solve's own. */
export type EmbeddingPolicy = Pick<LayeredOptions, 'ordering' | 'passing' | 'work'>;

/** One embedding through the common solve: its drawing, or how it ended without one. */
export type EmbeddingAttempt = GraphLayout | AttemptOutcome;
export const drawn = (attempt: EmbeddingAttempt): GraphLayout | null => typeof attempt === 'string' ? null : attempt;

function solve(request: LayoutRequest, embedding: ColdEmbedding, policy: EmbeddingPolicy = {}): EmbeddingAttempt {
  const key = request.band?.key;
  if (!key || !request.items.some(item => item.key === key)) return 'not-applicable';
  try {
    const layout = layoutLayered({ ...request, history: undefined, band: undefined, orientation: 'down', maxWidth: embedding.width ?? request.maxWidth },
      { ordering: policy.ordering, passing: policy.passing, work: policy.work, channelStyle: 'orthogonal', rowCapacity: embedding.capacity });
    return { ...withPaneBandBounds(layout, key, request.maxWidth),
      decision: { candidate: embedding.name, stability: false, fallback: 'geometry-fallback' } };
  } catch (error) {
    if (error instanceof RoutingConflictError) return corridorOutcome(error.conflict);
    throw error;
  }
}

/**
 * The bounded grid: each generation in rows of at most `k` tiles, `k` the
 * near-square count for its widest generation that fits the pane. Replaces the
 * single-fan grid (`safe-grid.ts`) as an embedding of any DAG.
 */
export function gridEmbedding(request: LayoutRequest): ColdEmbedding | null {
  const key = request.band?.key, items = request.items.filter(item => item.key !== key);
  if (!items.length) return null;
  const space = spacingFor(request.tileWidth);
  const widest = Math.max(...items.map(item => item.width)), tallest = Math.max(...items.map(item => item.height));
  // Longest-path generations (Kahn order, iterative); the largest sets the capacity.
  const byKey = new Map(request.items.map(item => [item.key, item]));
  const children = new Map<string, string[]>(), waiting = new Map<string, number>(), depth = new Map<string, number>();
  for (const item of request.items) {
    const parents = [...new Set(item.parents)].filter(p => p !== item.key && byKey.has(p));
    waiting.set(item.key, parents.length);
    for (const p of parents) (children.get(p) ?? children.set(p, []).get(p)!).push(item.key);
  }
  const ready = request.items.filter(item => !waiting.get(item.key)).map(item => item.key);
  for (const id of ready) depth.set(id, 0);
  for (let i = 0; i < ready.length; i++) for (const child of children.get(ready[i]) ?? []) {
    depth.set(child, Math.max(depth.get(child) ?? 0, depth.get(ready[i])! + 1));
    const left = waiting.get(child)! - 1; waiting.set(child, left);
    if (!left) ready.push(child);
  }
  const sizes = new Map<number, number>();
  for (const item of items) { const d = depth.get(item.key) ?? 0; sizes.set(d, (sizes.get(d) ?? 0) + 1); }
  const largest = Math.max(...sizes.values());
  const square = Math.ceil(Math.sqrt(largest * (tallest + space.rowChannel) / (widest + space.column)));
  const fitting = Math.floor((request.maxWidth - 2 * space.margin + space.column) / (widest + space.column));
  const capacity = Math.max(1, Math.min(largest, square, Math.max(1, fitting)));
  if (capacity >= largest) return null;
  // Not even one tile fits the pane, and rows of one (each tile its own row)
  // would leave the coordinate reach: near-square rows overflow the pane, as
  // the only bounded drawing does.
  const serialHeight = items.reduce((sum, item) => sum + item.height + space.rowChannel, 0);
  if (fitting < 1 && !inReach(serialHeight) && square > capacity) {
    const wide = Math.min(largest, square);
    return { name: 'grid-rows', capacity: wide, width: 2 * space.margin + wide * widest + (wide - 1) * space.column };
  }
  return { name: 'grid-rows', capacity };
}

export const serialEmbedding = (_request: LayoutRequest): ColdEmbedding => ({ name: 'serial-rows', capacity: 1 });

/** Grid rows through the common solve, or how the attempt ended. */
export function gridRowsAttempt(request: LayoutRequest, policy?: EmbeddingPolicy): EmbeddingAttempt {
  const embedding = gridEmbedding(request);
  return embedding ? solve(request, embedding, policy) : 'not-applicable';
}

/** Grid rows through the common solve; null when it does not apply or is not found. */
export function gridRowsEmbedding(request: LayoutRequest, policy?: EmbeddingPolicy): GraphLayout | null {
  return drawn(gridRowsAttempt(request, policy));
}

/** Serial rows (one tile per display row) through the common solve, or how the attempt ended. */
export function serialRowsAttempt(request: LayoutRequest, policy?: EmbeddingPolicy): EmbeddingAttempt {
  return solve(request, serialEmbedding(request), policy);
}

/** Serial rows (one tile per display row) through the common solve. */
export function serialRowsEmbedding(request: LayoutRequest, policy?: EmbeddingPolicy): GraphLayout | null {
  return drawn(serialRowsAttempt(request, policy));
}
