/** Exact revisit snapshots remain authoritative bytes. A legacy snapshot can
 * nevertheless contradict this click's committed ancestry: report that conflict
 * explicitly rather than calling restoration a successful pinned solve. */
import type { GraphLayout, LayoutItem } from './layout';
import type { RoutingMetricConflict } from './routing-components';
import { routingCoordinate } from './routing-problem';

export function retainedAncestry(items: readonly LayoutItem[], anchor: string | undefined): readonly string[] {
  const byKey = new Map(items.map(n => [n.key, n])), found = new Set<string>();
  const pending = anchor ? [anchor] : [];
  for (let at = 0; at < pending.length; at++) {
    const key = pending[at], item = byKey.get(key);
    if (!item || found.has(key)) continue;
    found.add(key); pending.push(...item.parents);
  }
  return [...found];
}

export function revisitRoutingConflict(committed: GraphLayout, saved: GraphLayout,
  items: readonly LayoutItem[], anchor?: string): RoutingMetricConflict | null {
  for (const key of retainedAncestry(items, anchor)) {
    const before = committed.nodes.get(key), after = saved.nodes.get(key);
    if (!before) continue;
    if (!after) return { kind: 'equality', variable: key, constraints: ['committed ancestry', 'missing saved tile'] };
    for (const axis of ['x', 'y', 'width', 'height'] as const) if (!Object.is(before[axis], after[axis]))
      return { kind: 'equality', variable: routingCoordinate('committed', 'tile', key, axis),
        constraints: ['committed:' + String(before[axis]), 'saved-revisit:' + String(after[axis])] };
  }
  return null;
}
