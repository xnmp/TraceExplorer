/** Wide fallback: topological tile columns, one upper channel per source, local binary joins. */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedJunction, PlacedRoute } from './layout';
import type { Endpoint } from './junctions';
import { ARROW, STACK_STEM_ROOM } from './metrics';

export function safeColumns(request: LayoutRequest): GraphLayout {
  const items = [...request.items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const byKey = new Map(items.map(n => [n.key, n]));
  const parents = new Map(items.map(n => [n.key, [...new Set(n.parents)].filter(p => byKey.has(p)).sort()]));
  const children = new Map<string, string[]>(), degrees = new Map<string, number>();
  for (const item of items) {
    degrees.set(item.key, parents.get(item.key)!.length);
    for (const p of parents.get(item.key)!) { const list = children.get(p); if (list) list.push(item.key); else children.set(p, [item.key]); }
  }
  const order = items.filter(n => !degrees.get(n.key)).map(n => n.key).sort((a, b) => Number(b === request.band?.key) - Number(a === request.band?.key));
  for (let i = 0; i < order.length; i++) for (const c of children.get(order[i]) ?? []) { const d = degrees.get(c)! - 1; degrees.set(c, d); if (!d) order.push(c); }
  const cover = byKey.get(request.band!.key)!;
  const top = cover.height + STACK_STEM_ROOM;
  const lanes = new Map(order.filter(k => children.has(k)).map((key, i) => [key, top + 12 + i * 12]));
  const tallest = items.reduce((height, n) => Math.max(height, n.height), 0);
  const centerY = top + 12 * lanes.size + 32 + tallest / 2;
  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [];
  let right = 0;
  for (const [i, key] of order.entries()) {
    const item = byKey.get(key)!;
    const x = key === cover.key ? Math.max(0, (request.pinned?.x ?? cover.width / 2) - cover.width / 2) : right + 64 + 24 * parents.get(key)!.length;
    const y = key === cover.key ? 0 : centerY - item.height / 2;
    nodes.set(key, { key, x, y, width: item.width, height: item.height, row: i, band: i });
    right = x + item.width;
  }
  const node = (id: string): Endpoint => ({ kind: 'node', id });
  const add = (from: Endpoint, to: Endpoint, consumers: PlacedRoute['consumers'], points: readonly (readonly [number, number])[], terminal = false) => {
    routes.push({ id: JSON.stringify(['safe-columns', from.kind, from.id, to.kind, to.id]), from, to, consumers, terminal,
      path: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') });
  };
  for (const key of order) {
    const ps = parents.get(key)!, target = nodes.get(key)!;
    if (!ps.length) continue;
    const all = ps.map(parent => ({ parent, child: key }));
    const approach = (parent: string, x: number): [number, number][] => {
      const n = nodes.get(parent)!, y = lanes.get(parent)!;
      return parent === cover.key ? [[n.x + n.width / 2, n.height], [n.x + n.width / 2, y], [x, y], [x, centerY]]
        : [[n.x + n.width, centerY], [n.x + n.width + 12, centerY], [n.x + n.width + 12, y], [x, y], [x, centerY]];
    };
    if (ps.length === 1) {
      add(node(ps[0]), node(key), all, [...approach(ps[0], target.x - 24), [target.x - ARROW.length, centerY]], true);
      continue;
    }
    let previous: Endpoint | undefined, previousX = 0;
    for (let i = 1; i < ps.length; i++) {
      const x = target.x - 24 - 24 * (ps.length - 1 - i), id = JSON.stringify(['safe-column-join', key, i]);
      const join: Endpoint = { kind: 'junction', id };
      junctions.set(id, { id, x, y: centerY, parents: ps.slice(0, i + 1) });
      if (previous) add(previous, join, { entries: all, start: 0, end: i }, [[previousX, centerY], [x, centerY]]);
      else add(node(ps[0]), join, [all[0]], [...approach(ps[0], x - 12), [x, centerY]]);
      add(node(ps[i]), join, [all[i]], approach(ps[i], x));
      previous = join; previousX = x;
    }
    add(previous!, node(key), all, [[previousX, centerY], [target.x - ARROW.length, centerY]], true);
  }
  return { orientation: 'right', nodes, junctions, routes, readingOrder: new Map(order.map((key, i) => [key, i])),
    rows: [...nodes.values()].map(n => ({ index: n.row, band: n.band, top: n.x, bottom: n.x + n.width, keys: [n.key] })),
    width: Math.max(request.maxWidth, right + 24), height: centerY + tallest / 2 + 16,
    bandBounds: { left: 0, top, width: right + 24 }, preferredX: 0,
    decision: { candidate: 'safe-columns', stability: false, fallback: 'geometry-fallback' } };
}
