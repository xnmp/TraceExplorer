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
import { layoutLayered, RoutingConflictError, type GraphLayout, type LayoutRequest } from './layout';
import { withPaneBandBounds } from './band-geometry';
import { spacingFor } from './metrics';

/** Discrete embedding choice; the solve and its constraints are shared. */
export interface ColdEmbedding {
  readonly name: 'serial-rows' | 'grid-rows';
  /** Maximum tiles per display row of a generation. */
  readonly capacity: number;
}

function solve(request: LayoutRequest, embedding: ColdEmbedding): GraphLayout | null {
  const key = request.band?.key;
  if (!key || !request.items.some(item => item.key === key)) return null;
  try {
    const layout = layoutLayered({ ...request, history: undefined, band: undefined, orientation: 'down' },
      { channelStyle: 'orthogonal', rowCapacity: embedding.capacity });
    return { ...withPaneBandBounds(layout, key, request.maxWidth),
      decision: { candidate: embedding.name, stability: false, fallback: 'geometry-fallback' } };
  } catch (error) {
    if (error instanceof RoutingConflictError) return null;
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
  // Generation sizes bound the useful capacity; the deepest generation sets it.
  const depth = new Map<string, number>(), byKey = new Map(request.items.map(item => [item.key, item]));
  const level = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const value = Math.max(-1, ...(byKey.get(id)?.parents ?? []).filter(p => byKey.has(p) && p !== id).map(p => level(p, seen))) + 1;
    depth.set(id, value);
    return value;
  };
  const sizes = new Map<number, number>();
  for (const item of items) { const d = level(item.key); sizes.set(d, (sizes.get(d) ?? 0) + 1); }
  const largest = Math.max(...sizes.values());
  const square = Math.ceil(Math.sqrt(largest * (tallest + space.rowChannel) / (widest + space.column)));
  const fitting = Math.floor((request.maxWidth - 2 * space.margin + space.column) / (widest + space.column));
  const capacity = Math.max(1, Math.min(largest, square, Math.max(1, fitting)));
  return capacity >= largest ? null : { name: 'grid-rows', capacity };
}

export const serialEmbedding = (_request: LayoutRequest): ColdEmbedding => ({ name: 'serial-rows', capacity: 1 });

/** Grid rows through the common solve; null when it does not apply or is not found. */
export function gridRowsEmbedding(request: LayoutRequest): GraphLayout | null {
  const embedding = gridEmbedding(request);
  return embedding && solve(request, embedding);
}

/** Serial rows (one tile per display row) through the common solve. */
export function serialRowsEmbedding(request: LayoutRequest): GraphLayout | null {
  return solve(request, serialEmbedding(request));
}
