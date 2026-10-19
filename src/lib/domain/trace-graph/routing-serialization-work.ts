/** Bound the unchanged gate's JSON key without serializing an unbounded alias
 * expansion. Memoized subtree sizes count every occurrence in the final key. */
import type { GraphLayout, LayoutItem } from './layout';
import { geometrySignature } from './layout-signature';
import type { Charge } from './routing-admission-work';

const MAX_SERIALIZATION_DEPTH = 128;

interface Visit {
  readonly value: unknown;
  keys?: readonly string[];
  count?: number;
  index: number;
  total: number;
  depth: number;
}

export function prepayRoutingSerialization(value: unknown, charge: Charge): boolean {
  const sizes = new Map<object, { readonly bytes: number; readonly depth: number }>(), active = new Set<object>();
  const pending: Visit[] = [{ value, index: 0, total: 0, depth: 1 }];
  let bytes = 0;
  const excessive = () => { charge(Number.MAX_SAFE_INTEGER, 'unsupported serialization expansion'); return false; };
  const finish = (size: number, depth = 1) => {
    pending.pop();
    if (pending.length) {
      const parent = pending[pending.length - 1];
      parent.total += size;
      parent.depth = Math.max(parent.depth, depth + 1);
    }
    else bytes = size;
  };
  while (pending.length) {
    charge(1, 'routing serialization preflight');
    if (pending.length > MAX_SERIALIZATION_DEPTH) return false;
    const visit = pending[pending.length - 1], current = visit.value;
    if (!current || typeof current !== 'object') {
      if (typeof current === 'bigint' || typeof current === 'function' || typeof current === 'symbol') return false;
      if (typeof current === 'string') charge(current.length, 'routing serialization string inspection');
      finish(typeof current === 'string' ? 6 * current.length + 2 : 32);
      continue;
    }
    if (visit.count === undefined) {
      const cached = sizes.get(current);
      if (cached !== undefined) {
        if (pending.length - 1 + cached.depth > MAX_SERIALIZATION_DEPTH) return false;
        finish(cached.bytes, cached.depth); continue;
      }
      const prototype = Object.getPrototypeOf(current);
      if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null
        && !(current instanceof Map) && !(current instanceof Set)) return false;
      if (active.has(current) || typeof (current as { toJSON?: unknown }).toJSON === 'function') return false;
      active.add(current);
      const keys = Array.isArray(current) ? undefined : Object.keys(current);
      const count = Array.isArray(current) ? current.length : keys!.length;
      charge(count + 1, 'routing serialization fields');
      visit.keys = keys;
      visit.count = count;
      visit.total = 2 + count;
      for (const key of keys ?? []) {
        charge(key.length + 1, 'routing serialization property inspection');
        visit.total += 6 * key.length + 3;
      }
    }
    if (!Number.isSafeInteger(visit.total)) return excessive();
    if (visit.index < visit.count!) {
      const index = visit.index++;
      pending.push({ value: Array.isArray(current) ? current[index]
        : (current as Record<string, unknown>)[visit.keys![index]], index: 0, total: 0, depth: 1 });
      continue;
    }
    active.delete(current);
    sizes.set(current, { bytes: visit.total, depth: visit.depth });
    finish(visit.total, visit.depth);
  }
  if (!Number.isSafeInteger(2 * bytes)) return excessive();
  charge(2 * bytes, 'independent gate serialization bytes');
  return true;
}

export function prepayRoutingGateSerialization(drawing: GraphLayout, items: readonly LayoutItem[], cover: string,
  width: number, charge: Charge): boolean {
  charge(4 * (drawing.nodes.size + drawing.junctions.size + drawing.routes.length + drawing.rows.length + items.length + 1),
    'independent gate key preparation');
  for (const item of items) charge(item.parents.length + 1, 'independent gate parent key');
  return prepayRoutingSerialization([cover, width, items.map(item => [item.key, item.width, item.height, item.parents]),
    geometrySignature(drawing)], charge);
}
