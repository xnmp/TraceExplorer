/** Incremental tree embedding: retained rectangles and routes are fixed obstacles. */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute, PlacedJunction } from "./layout";
import { ARROW, spacingFor, STACK_STEM_ROOM } from "./metrics";
import { bandExtent } from "./band-geometry";
import { intersectsTile, segments, type Segment } from "./layout-quality";
import { orthogonalRoute } from "./orthogonal-route";
import type { Point } from "./path-sampling";

const path = (points: readonly Point[]) => points.filter((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y)
  .map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
const point = (x: number, y: number): Point => ({ x, y });
const overlap = (a: PlacedNode, b: PlacedNode, gap: number) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** A bounded orthogonal route family, validated against the entire visible embedding. */
function routeTo(p: PlacedNode, t: PlacedNode, boxes: readonly PlacedNode[], width: number, lane: number, topOnly = false, bottomOnly = false): string | null {
  const bottom = point(p.x + p.width / 2, p.y + p.height), right = point(p.x + p.width, p.y + p.height / 2);
  const top = point(t.x + t.width / 2, t.y - ARROW.length), left = point(t.x - ARROW.length, t.y + t.height / 2);
  const paths: Point[][] = [];
  if (t.y >= p.y + p.height + 16) {
    const mid = (p.y + p.height + t.y - 16) / 2;
    paths.push([bottom, point(bottom.x, mid), point(top.x, mid), top]);
  }
  if (!bottomOnly && !topOnly && t.x >= p.x + p.width + 16) {
    const mid = (p.x + p.width + t.x - 16) / 2;
    paths.push([right, point(mid, right.y), point(mid, left.y), left]);
  }
  // Shelf returns and blocked direct approaches can use the visible outer gutters.
  const maxBottom = Math.max(...boxes.filter(n => n.y < t.y).map(n => n.y + n.height), p.y + p.height);
  for (const x of [lane, width - lane]) {
    const y = Math.max(p.y + p.height + lane, maxBottom + lane);
    if (!bottomOnly && t.y >= y + 16) paths.push([right, point(width - lane, right.y), point(width - lane, y), point(x, y), point(x, t.y - 16), point(top.x, t.y - 16), top]);
  }
  // A new edit below the entire visible scene can escape through its source's
  // side gap, then the cover header and an outer gutter. No hidden slots exist.
  const header = boxes.find(n => n.band === 0 && n.row === 0)?.height ?? 0;
  for (const outer of [8, width - 8]) {
    const sx = p.x + p.width + 4;
    const travelY = maxBottom + 6;
    if (!bottomOnly && sx <= width - 8 && t.y >= travelY + 16) paths.push([right, point(sx, right.y), point(sx, header + 6), point(outer, header + 6), point(outer, travelY), point(top.x, travelY), top]);
  }
  for (const outer of [8, width - 8]) {
    const exitY = bottom.y + 4, travelY = maxBottom + 6;
    if (t.y >= travelY + 16) paths.push([bottom, point(bottom.x, exitY), point(outer, exitY), point(outer, travelY), point(top.x, travelY), top]);
  }
  const plans = paths.map(points => {
    const d = path(points), ss = segments(d);
    return { d, ss, length: ss.reduce((sum, [a, b]) => sum + Math.hypot(a.x - b.x, a.y - b.y), 0) };
  }).sort((a, b) => a.length - b.length);
  for (const { d, ss } of plans) {
    const last = ss.at(-1);
    if (!last) continue;
    const [a, b] = last;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const tip = point(b.x + (b.x - a.x) / length * ARROW.length, b.y + (b.y - a.y) / length * ARROW.length);
    if ([...ss, [b, tip] as Segment].every(s => boxes.every(n => !intersectsTile(s, n)))) return d;
  }
  return null;
}

/** Placed connector segments bucketed by 64 px rows, so a probe tests only segments near it. */
class SegmentRows {
  private readonly all: Segment[] = [];
  private readonly rows = new Map<number, number[]>();
  add(list: readonly Segment[]): void {
    for (const segment of list) {
      const index = this.all.push(segment) - 1;
      const top = Math.floor(Math.min(segment[0].y, segment[1].y) / 64), bottom = Math.floor(Math.max(segment[0].y, segment[1].y) / 64);
      for (let row = top; row <= bottom; row++) { const bucket = this.rows.get(row); if (bucket) bucket.push(index); else this.rows.set(row, [index]); }
    }
  }
  /** Whether any segment passes through the tile (the exact test of `intersectsTile`). */
  hits(tile: PlacedNode): boolean {
    const top = Math.floor(tile.y / 64), bottom = Math.floor((tile.y + tile.height) / 64);
    for (let row = top; row <= bottom; row++) for (const index of this.rows.get(row) ?? []) if (intersectsTile(this.all[index], tile)) return true;
    return false;
  }
}

/**
 * Insertion probes every placed box per new tile, so work grows quadratically. Beyond this many
 * visible tiles the history candidate is skipped (the cold candidates and anchored translations
 * remain): its stability is not worth seconds of layout.
 */
export const INCREMENTAL_LIMIT = 256;

export function incrementalTree(request: LayoutRequest, previous: GraphLayout): GraphLayout | null {
  const key = request.band!.key, s = spacingFor(request.tileWidth), wanted = new Set(request.items.map(n => n.key));
  if (request.items.length > INCREMENTAL_LIMIT || !wanted.has(key)) return null;
  if (!previous.nodes.has(key) || request.items.some(n => n.key !== key && n.parents.length === 0 && !previous.nodes.has(n.key))) return null;
  const nodes = new Map([...previous.nodes].filter(([id]) => wanted.has(id)));
  const routes: PlacedRoute[] = previous.routes.filter(r => r.consumers.some(c => wanted.has(c.parent) && wanted.has(c.child)))
    .map(r => ({ ...r, consumers: r.consumers.filter(c => wanted.has(c.parent) && wanted.has(c.child)) }));
  const referenced = new Set(routes.flatMap(r => [r.from, r.to].filter(e => e.kind === "junction").map(e => e.id)));
  const joins = new Map<string, PlacedJunction>([...previous.junctions].filter(([id]) => referenced.has(id)));
  const oldSegments = new SegmentRows();
  for (const r of routes) oldSegments.add(segments(r.path));
  const remaining = request.items.filter(n => !nodes.has(n.key));
  if (!remaining.length) return null;
  const width = request.maxWidth;
  const baseBottom = Math.max(previous.height, ...[...nodes.values()].map(n => n.y + n.height));
  // Each node gets at most 96 primary placement probes; fallback uses visible row corners and up to 32 columns. Order is topological, with stable sibling ties.
  while (remaining.length) {
    const index = remaining.findIndex(n => n.parents.every(p => nodes.has(p)));
    if (index < 0) return null;
    const [item] = remaining.splice(index, 1), parents = item.parents.map(p => nodes.get(p)!), parent = parents.reduce((a, b) => a.y + a.height > b.y + b.height ? a : b), cover = nodes.get(key)!;
    const boxes = [...nodes.values()], bottom = Math.max(...boxes.map(n => n.y + n.height));
    const arrivalGap = parents.length > 1 ? 24 : 20;
    const xs = [...new Set([parent.x + parent.width + s.column, parent.x, 24, width - item.width - 24,
      ...boxes.flatMap(b => [b.x, b.x + b.width + s.column])])].filter(x => x >= 24 && x + item.width <= width - 24).slice(0, 32);
    const ys = [...new Set([Math.max(cover.height + STACK_STEM_ROOM, parent.y), Math.max(cover.height + STACK_STEM_ROOM, parent.y + parent.height + arrivalGap), bottom + arrivalGap])];
    const free = (n: PlacedNode) => parents.every(parent => n.x >= parent.x + parent.width || n.y >= parent.y + parent.height)
      && !boxes.some(b => overlap(n, b, s.clearance)) && !oldSegments.hits(n);
    // Rank every probe, then test freedom lazily: only probes up to the first routable one are checked.
    const ranked = xs.flatMap(x => ys.map(y => ({ key: item.key, x, y, width: item.width, height: item.height,
      row: y === parent.y ? parent.row : parent.row + 1, band: parent.band + 1 })))
      .sort((a, b) => Math.max(bottom, a.y + a.height) - Math.max(bottom, b.y + b.height) || a.y - b.y || a.x - b.x);
    let feasible: { node: PlacedNode; paths: string[]; id: string }[] = [];
    for (const n of ranked) {
      if (!free(n)) continue;
      const id = `incremental-join:${item.key}`;
      const join = { key: id, x: n.x + n.width / 2, y: n.y - ARROW.length, width: 0, height: 0, row: n.row, band: n.band };
      const paths = parents.map((p, i) => routeTo(p, parents.length > 1 ? join : n, [...boxes, n], width, s.clearance + 2 + i * 3, parents.length > 1, p.key === key));
      if (paths.every(Boolean)) { feasible = [{ node: n, paths: paths as string[], id }]; break; }
    }
    if (!feasible.length) {
      const rowYs = [...new Set([Math.max(baseBottom, ...parents.map(p => p.y + p.height)) + arrivalGap,
        ...boxes.filter(n => n.y > baseBottom).map(n => n.y), Math.max(bottom, previous.height) + arrivalGap])].sort((a, b) => a - b);
      const slotXs = Array.from({ length: Math.min(32, Math.max(1, Math.floor((width - 48 + s.column) / (item.width + s.column)))) }, (_, i) => 24 + i * (item.width + s.column));
      const slot = rowYs.flatMap(y => slotXs.map(x => ({ key: item.key, x, y, width: item.width, height: item.height, row: parent.row + 1, band: parent.band + 1 })))
        .find(n => parents.every(p => n.y >= p.y + p.height || n.x >= p.x + p.width) && !boxes.some(b => overlap(n, b, s.clearance)) && !oldSegments.hits(n));
      if (!slot) return null;
      const n = slot, x = n.x;
      if (x >= 0 && x + item.width <= width) {
        const joinX = x + item.width / 2, joinY = n.y - 2 * ARROW.length, multi = parents.length > 1;
        const paths = parents.map(p => {
          const start = point(p.x + p.width / 2, p.y + p.height + 2), goal = point(joinX, multi ? joinY : n.y - 16);
          const points = orthogonalRoute(start, goal, [...boxes, n], width);
          return points ? path([point(start.x, p.y + p.height), ...points, ...(multi ? [] : [point(joinX, n.y - ARROW.length)])]) : null;
        });
        if (paths.every(Boolean)) feasible = [{ node: n, paths: paths as string[], id: `incremental-join:${item.key}` }];
      }
    }
    const best = feasible[0];
    if (!best) return null;
    nodes.set(item.key, best.node);
    const multi = parents.length > 1;
    parents.forEach((p, i) => {
      const route: PlacedRoute = { id: `incremental:${p.key}:${item.key}`, from: { kind: "node", id: p.key },
        to: multi ? { kind: "junction", id: best.id } : { kind: "node", id: item.key },
        consumers: [{ parent: p.key, child: item.key }], terminal: !multi, path: best.paths[i] };
      routes.push(route); oldSegments.add(segments(route.path));
    });
    if (multi) {
      const x = best.node.x + best.node.width / 2, y = best.node.y - 2 * ARROW.length;
      joins.set(best.id, { id: best.id, x, y, parents: item.parents });
      const tail: PlacedRoute = { id: `${best.id}:tail`, from: { kind: "junction", id: best.id }, to: { kind: "node", id: item.key },
        consumers: item.parents.map(parent => ({ parent, child: item.key })), terminal: true, path: `M${x} ${y} L${x} ${best.node.y - ARROW.length}` };
      routes.push(tail); oldSegments.add(segments(tail.path));
    }
  }
  const provisional: GraphLayout = { ...previous, nodes, routes, junctions: joins, rows: [],
    height: Math.max(...[...nodes.values()].map(n => n.y + n.height)) + s.bottom,
    readingOrder: new Map(request.items.map((n, i) => [n.key, i])) };
  const extent = bandExtent({ ...provisional, bandBounds: undefined }, key);
  if (extent.left < 0 || extent.left + extent.width > width) return null;
  return { ...provisional, bandBounds: { left: extent.left, width: extent.width, top: nodes.get(key)!.height + (request.history?.attachment?.placement.stemRoom ?? STACK_STEM_ROOM) }, preferredX: extent.left };
}
