/** Last-resort orthogonal construction: one tile row, one source lane, distinct join rows. */
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedJunction, PlacedNode, PlacedRoute, RowBox } from './layout';
import type { Consumer, Endpoint } from './junctions';
import { ARROW } from './metrics';

export function safeLayout(request: LayoutRequest): GraphLayout {
  const items = [...request.items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const byKey = new Map(items.map(n => [n.key, n]));
  const children = new Map<string, string[]>(), pending = new Map<string, number>();
  for (const n of items) {
    const parents = [...new Set(n.parents)].filter(p => byKey.has(p));
    pending.set(n.key, parents.length);
    for (const parent of parents) { const list = children.get(parent); if (list) list.push(n.key); else children.set(parent, [n.key]); }
  }
  const ready = items.filter(n => !pending.get(n.key)).map(n => n.key).sort((a, b) => Number(b === request.band?.key) - Number(a === request.band?.key)), ordered: LayoutItem[] = [];
  for (let i = 0; i < ready.length; i++) {
    const key = ready[i]; ordered.push(byKey.get(key)!);
    for (const child of children.get(key) ?? []) { const left = pending.get(child)! - 1; pending.set(child, left); if (!left) ready.push(child); }
  }
  const widest = ordered.reduce((max, n) => Math.max(max, n.width), 1);
  const center = Math.max(widest / 2 + 8, request.pinned?.x ?? widest / 2 + 8);
  const lanes = new Map(ordered.filter(n => children.has(n.key)).map((n, i) => [n.key, center + widest / 2 + 24 + i * 12]));
  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [], rows: RowBox[] = [];
  const readingOrder = new Map<string, number>();
  let bottom = 0;
  for (const [i, item] of ordered.entries()) {
    const count = pending.has(item.key) ? item.parents.filter(p => byKey.has(p)).length : 0;
    const y = i ? bottom + 64 + Math.max(0, count - 1) * 24 : 0;
    nodes.set(item.key, { key: item.key, x: center - item.width / 2, y, width: item.width, height: item.height, row: i, band: i });
    rows.push({ index: i, band: i, top: y, bottom: y + item.height, keys: [item.key] });
    readingOrder.set(item.key, i); bottom = y + item.height;
  }
  const nodeEnd = (id: string): Endpoint => ({ kind: 'node', id });
  const add = (from: Endpoint, to: Endpoint, consumers: readonly Consumer[], points: readonly (readonly [number, number])[], terminal = false) => {
    routes.push({ id: JSON.stringify(['safe', from.kind, from.id, to.kind, to.id]), from, to, consumers, terminal,
      path: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') });
  };
  for (const item of ordered) {
    const target = nodes.get(item.key)!, parents = [...new Set(item.parents)].filter(p => nodes.has(p));
    if (!parents.length) continue;
    const all = parents.map(parent => ({ parent, child: item.key }));
    const branch = (parent: string, y: number): [number, number][] => {
      const source = nodes.get(parent)!, exit = source.y + source.height;
      return [[center, exit], [center, exit + 12], [lanes.get(parent)!, exit + 12], [lanes.get(parent)!, y], [center, y]];
    };
    if (parents.length === 1) {
      add(nodeEnd(parents[0]), nodeEnd(item.key), all, [...branch(parents[0], target.y - 24), [center, target.y - ARROW.length]], true);
      continue;
    }
    let previous: Endpoint | null = null, previousY = 0;
    for (let i = 1; i < parents.length; i++) {
      const y = target.y - 32 - (parents.length - 1 - i) * 24;
      const id = JSON.stringify(['safe-join', item.key, i]), join: Endpoint = { kind: 'junction', id };
      junctions.set(id, { id, x: center, y, parents: parents.slice(0, i + 1) });
      if (previous) add(previous, join, all.slice(0, i), [[center, previousY], [center, y]]);
      else add(nodeEnd(parents[0]), join, [all[0]], [...branch(parents[0], y - 12), [center, y]]);
      add(nodeEnd(parents[i]), join, [all[i]], branch(parents[i], y));
      previous = join; previousY = y;
    }
    add(previous!, nodeEnd(item.key), all, [[center, previousY], [center, target.y - ARROW.length]], true);
  }
  return { orientation: 'down', width: Math.max(request.maxWidth, center + widest / 2 + 24 + lanes.size * 12), height: bottom + 14,
    nodes, junctions, routes, rows, readingOrder, preferredX: 0, decision: { candidate: 'safe-rows', stability: false, fallback: 'geometry-fallback' } };
}
