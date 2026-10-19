import type { GraphLayout, LayoutItem, PlacedNode } from './layout';
/** A declined semantic frame is recoverable; unrelated runtime failures are not. */
export class HintRoutingError extends Error {
  constructor(message: string, readonly reason: 'unsupported-input' | 'topology-conflict' = 'topology-conflict') {
    super(message);
    this.name = 'HintRoutingError';
  }
}
/** Validated request facts, before a membership projection can hide malformed entries. */
export function validItems(items: unknown): items is readonly LayoutItem[] {
  const keys = new Set<string>();
  return Array.isArray(items) && Array.from(items).every(item => !!item && typeof item === 'object'
    && typeof item.key === 'string' && !keys.has(item.key) && !!keys.add(item.key) && Number.isFinite(item.width) && item.width > 0
    && Number.isFinite(item.height) && item.height > 0 && Number.isFinite(item.order)
    && Array.isArray(item.parents) && Array.from(item.parents).every(parent => typeof parent === 'string'));
}
export function hintChanges(before: GraphLayout, heights: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  if (!(heights instanceof Map))
    throw new HintRoutingError('hint height map', 'unsupported-input');
  const changed = new Map<string, number>();
  for (const [key, height] of heights) {
    if (typeof key !== 'string' || !Number.isFinite(height) || height <= 0)
      throw new HintRoutingError('hint height entry', 'unsupported-input');
    const old = before.nodes.get(key);
    if (!old || Object.is(old.height, height))
      continue;
    if (Math.abs(height - old.height) !== 16)
      throw new HintRoutingError('hint change must be exactly16', 'unsupported-input');
    changed.set(key, height);
  }
  return changed;
}
export const overlapsColumn = (a: PlacedNode, b: PlacedNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width;
export const eligibleDescent = (node: PlacedNode, growing: readonly PlacedNode[]): boolean => growing.some(source => source.key !== node.key
  && node.y >= source.y + source.height && overlapsColumn(node, source));
/** Identity is an empty recipe; adding zero would destroy a retained -0. */
export const translated = (value: number, delta: number): number => delta ? value + delta : value;
export const translatedBy = (value: number, operations: readonly number[]): number => operations.reduce(translated, value);
