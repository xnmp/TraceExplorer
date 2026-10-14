/** Incremental tree embedding: retained rectangles and routes are fixed obstacles. */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute, PlacedJunction } from "./layout";
import { ARROW, spacingFor, STACK_STEM_ROOM } from "./metrics";
import { bandExtent } from "./band-geometry";
import { intersectsTile, segments, type Segment } from "./layout-quality";
import { orthogonalRoute } from "./orthogonal-route";
import type { Point } from "./path-sampling";

/** The M/L path through `points`, written once per run of repeated points. */
const path = (points: readonly Point[]) => {
  let out = "";
  for (let i = 0, written = 0; i < points.length; i++) {
    const p = points[i];
    if (i && p.x === points[i - 1].x && p.y === points[i - 1].y) continue;
    out += written++ ? ` L${p.x} ${p.y}` : `M${p.x} ${p.y}`;
  }
  return out;
};
const point = (x: number, y: number): Point => ({ x, y });
/** `overlap(a, b, gap)` = `overlapX(a, b, gap) && overlapY(a, b, gap)`; the halves let one row's vertical test be shared. */
const overlapX = (a: PlacedNode, b: PlacedNode, gap: number) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap;
const overlapY = (a: { y: number; height: number }, b: PlacedNode, gap: number) => a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/**
 * `segments` of the M/L path written through `points` (no deduplication), without printing
 * and re-parsing it. `String(number)` round-trips every finite number (−0 prints as 0); any
 * non-finite coordinate prints as a word, which the parser rejects, leaving no segments.
 */
function writtenSegments(points: readonly Point[]): Segment[] {
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
  const read = points.map(p => point(p.x === 0 ? 0 : p.x, p.y === 0 ? 0 : p.y)), out: Segment[] = [];
  for (let i = 1; i < read.length; i++) out.push([read[i - 1], read[i]]);
  return out;
}

/**
 * `writtenSegments` of the points `path` writes (dropping consecutive repeats), without
 * listing those points first.
 */
function pathSegments(points: readonly Point[]): Segment[] {
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
  const out: Segment[] = [];
  let previous: Point | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i && p.x === points[i - 1].x && p.y === points[i - 1].y) continue;
    const read = point(p.x === 0 ? 0 : p.x, p.y === 0 ? 0 : p.y);
    if (previous) out.push([previous, read]);
    previous = read;
  }
  return out;
}

/**
 * The length of `pathSegments(points)`, summed in path order, without building
 * the segments: zero if any coordinate is not finite. (Printing turns −0 into 0, which no
 * difference's magnitude, so no length, depends on.)
 */
function writtenLength(points: readonly Point[]): number {
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (a.x === b.x && a.y === b.y) continue;
    sum = sum + Math.hypot(a.x - b.x, a.y - b.y);
  }
  return sum;
}

/** Whether any segment passes through `boxes` or `extra` (the exact test of `intersectsTile`). */
function crossesAny(ss: readonly Segment[], boxes: readonly PlacedNode[], extra: PlacedNode): boolean {
  for (const s of ss) {
    if (intersectsTile(s, extra)) return true;
    for (const n of boxes) if (intersectsTile(s, n)) return true;
  }
  return false;
}

interface Route { readonly d: string; readonly ss: readonly Segment[] }

/**
 * A bounded orthogonal route family, validated against the entire visible embedding
 * (`boxes` plus the probed tile `extra`, which comes last in that order).
 */
function routeTo(p: PlacedNode, t: PlacedNode, boxes: readonly PlacedNode[], extra: PlacedNode, width: number, lane: number, topOnly = false, bottomOnly = false): Route | null {
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
  // (Math.max is order-free, so folding it equals the original spread over the filtered boxes.)
  let maxBottom = p.y + p.height;
  for (const n of boxes) if (n.y < t.y) maxBottom = Math.max(maxBottom, n.y + n.height);
  if (extra.y < t.y) maxBottom = Math.max(maxBottom, extra.y + extra.height);
  for (const x of [lane, width - lane]) {
    const y = Math.max(p.y + p.height + lane, maxBottom + lane);
    if (!bottomOnly && t.y >= y + 16) paths.push([right, point(width - lane, right.y), point(width - lane, y), point(x, y), point(x, t.y - 16), point(top.x, t.y - 16), top]);
  }
  // A new edit below the entire visible scene can escape through its source's
  // side gap, then the cover header and an outer gutter. No hidden slots exist.
  let header: number | undefined;
  for (const outer of [8, width - 8]) {
    const sx = p.x + p.width + 4;
    const travelY = maxBottom + 6;
    if (!bottomOnly && sx <= width - 8 && t.y >= travelY + 16) {
      header ??= (boxes.find(n => n.band === 0 && n.row === 0) ?? (extra.band === 0 && extra.row === 0 ? extra : undefined))?.height ?? 0;
      paths.push([right, point(sx, right.y), point(sx, header + 6), point(outer, header + 6), point(outer, travelY), point(top.x, travelY), top]);
    }
  }
  for (const outer of [8, width - 8]) {
    const exitY = bottom.y + 4, travelY = maxBottom + 6;
    if (t.y >= travelY + 16) paths.push([bottom, point(bottom.x, exitY), point(outer, exitY), point(outer, travelY), point(top.x, travelY), top]);
  }
  // Lengths are summed over the segments the written path parses back to, in path order.
  // Plans are tried shortest first, ties in listed order (a stable sort by length: lengths are
  // never NaN, so that order is total), each picked when its turn comes; segments are built
  // only for the plans tried.
  const lengths = paths.map(writtenLength);
  for (let turn = 0; turn < paths.length; turn++) {
    let pick = -1;
    for (let i = 0; i < paths.length; i++) if (lengths[i] === lengths[i] && (pick < 0 || lengths[i] < lengths[pick])) pick = i;
    const points = paths[pick];
    lengths[pick] = NaN;
    const ss = pathSegments(points);
    const last = ss.at(-1);
    if (!last) continue;
    const [a, b] = last;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const tip = point(b.x + (b.x - a.x) / length * ARROW.length, b.y + (b.y - a.y) / length * ARROW.length);
    if (!crossesAny(ss, boxes, extra) && !crossesAny([[b, tip]], boxes, extra)) return { d: path(points), ss };
  }
  return null;
}

/**
 * `segments(route.path)`, memoized per retained route object: a committed history layout is
 * re-embedded by every layout request made against it. The path is compared on each lookup,
 * so a mutated route is re-parsed; the cached segments are never exposed or mutated.
 */
const parsedRoutes = new WeakMap<PlacedRoute, { readonly path: string; readonly ss: readonly Segment[] }>();
function retainedSegments(route: PlacedRoute): readonly Segment[] {
  const cached = parsedRoutes.get(route);
  if (cached && cached.path === route.path) return cached.ss;
  const ss = segments(route.path);
  parsedRoutes.set(route, { path: route.path, ss });
  return ss;
}

/**
 * The retained routes' segments, bucketed, memoized per previous layout for the last list of
 * routes kept from it (the same routes, with the same paths, give the same segments).
 */
const retainedBuckets = new WeakMap<GraphLayout, { readonly routes: readonly PlacedRoute[]; readonly paths: readonly string[]; readonly rows: SegmentRows }>();
function retainedRows(previous: GraphLayout, kept: readonly PlacedRoute[]): SegmentRows {
  const cached = retainedBuckets.get(previous);
  if (cached && cached.routes.length === kept.length && kept.every((r, i) => r === cached.routes[i] && r.path === cached.paths[i])) return cached.rows;
  const rows = new SegmentRows();
  for (const r of kept) rows.add(retainedSegments(r));
  retainedBuckets.set(previous, { routes: kept, paths: kept.map((r) => r.path), rows });
  return rows;
}

/**
 * Placed connector segments bucketed by 64 px rows, so a probe tests only segments near it.
 * A `base` (never modified once built) holds segments shared by many searches.
 */
class SegmentRows {
  constructor(private readonly base?: SegmentRows) {}
  private readonly all: Segment[] = [];
  /** Segment indices by 64 px row (an index property for a negative row; NaN rows are never visited). */
  private readonly rows: number[][] = [];
  add(list: readonly Segment[]): void {
    for (const segment of list) {
      const index = this.all.push(segment) - 1;
      const top = Math.floor(Math.min(segment[0].y, segment[1].y) / 64), bottom = Math.floor(Math.max(segment[0].y, segment[1].y) / 64);
      for (let row = top; row <= bottom; row++) { const bucket = this.rows[row]; if (bucket) bucket.push(index); else this.rows[row] = [index]; }
    }
  }
  /** Whether any segment passes through the tile (the exact test of `intersectsTile`). */
  hits(tile: PlacedNode): boolean {
    if (this.base?.hits(tile)) return true;
    const top = Math.floor(tile.y / 64), bottom = Math.floor((tile.y + tile.height) / 64);
    for (let row = top; row <= bottom; row++) {
      const bucket = this.rows[row];
      if (bucket) for (const index of bucket) if (intersectsTile(this.all[index], tile)) return true;
    }
    return false;
  }
}

/**
 * Insertion probes every placed box per new tile, so work grows quadratically. Beyond this many
 * visible tiles the history candidate is skipped (the cold candidates and anchored translations
 * remain): its stability is not worth seconds of layout.
 */
export const INCREMENTAL_LIMIT = 256;

/**
 * Probes `x * ys.length + y` (indices into `xs` and `ys`, both free of repeats) sorted by the
 * row bottom they reach, `Math.max(bottom, y + height)`, then y, then x. With every key
 * finite that order is strict and depends on y before x, so it is each row (by bottom, then
 * y) with its columns left to right; otherwise the probes are sorted as listed (x-major).
 */
function rankProbes(xs: readonly number[], ys: readonly number[], bottom: number, height: number): number[] {
  const ny = ys.length, reach = (y: number) => Math.max(bottom, y + height), ranked: number[] = [];
  let finite = true;
  for (const y of ys) if (!Number.isFinite(y) || !Number.isFinite(reach(y))) finite = false;
  for (const x of xs) if (!Number.isFinite(x)) finite = false;
  if (!finite) {
    for (let p = 0; p < xs.length * ny; p++) ranked.push(p);
    return ranked.sort((a, b) => reach(ys[a % ny]) - reach(ys[b % ny]) || ys[a % ny] - ys[b % ny] || xs[(a - a % ny) / ny] - xs[(b - b % ny) / ny]);
  }
  const rows: number[] = [], columns: number[] = [];
  for (let y = 0; y < ny; y++) rows.push(y);
  for (let x = 0; x < xs.length; x++) columns.push(x);
  rows.sort((a, b) => reach(ys[a]) - reach(ys[b]) || ys[a] - ys[b]);
  columns.sort((a, b) => xs[a] - xs[b]);
  for (const y of rows) for (const x of columns) ranked.push(x * ny + y);
  return ranked;
}

/** `[...new Set([a, b, c])]`: the distinct values (SameValueZero), in order. */
function distinctValues3(a: number, b: number, c: number): number[] {
  const same = (x: number, y: number) => x === y || (x !== x && y !== y);
  const out = [a];
  if (!same(b, a)) out.push(b);
  if (!same(c, a) && !same(c, b)) out.push(c);
  return out;
}

export function incrementalTree(request: LayoutRequest, previous: GraphLayout): GraphLayout | null {
  const key = request.band!.key, s = spacingFor(request.tileWidth), wanted = new Set(request.items.map(n => n.key));
  if (request.items.length > INCREMENTAL_LIMIT || !wanted.has(key)) return null;
  if (!previous.nodes.has(key) || request.items.some(n => n.key !== key && n.parents.length === 0 && !previous.nodes.has(n.key))) return null;
  const nodes = new Map<string, PlacedNode>();
  previous.nodes.forEach((node, id) => { if (wanted.has(id)) nodes.set(id, node); });
  // Retained routes carry only their visible consumers; the junctions they touch stay.
  const visible = (c: { readonly parent: string; readonly child: string }) => wanted.has(c.parent) && wanted.has(c.child);
  const kept: PlacedRoute[] = [], routes: PlacedRoute[] = [], referenced = new Set<string>();
  for (const r of previous.routes) {
    if (!r.consumers.some(visible)) continue;
    kept.push(r);
    routes.push({ ...r, consumers: r.consumers.filter(visible) });
    if (r.from.kind === "junction") referenced.add(r.from.id);
    if (r.to.kind === "junction") referenced.add(r.to.id);
  }
  const joins = new Map<string, PlacedJunction>();
  previous.junctions.forEach((join, id) => { if (referenced.has(id)) joins.set(id, join); });
  const oldSegments = new SegmentRows(retainedRows(previous, kept));
  const remaining = request.items.filter(n => !nodes.has(n.key));
  if (!remaining.length) return null;
  const width = request.maxWidth;
  // Placed boxes in `nodes` order and their lowest edge, kept in step with `nodes` below.
  // (Math.max is order-free, NaN and signed zeros included, so folding it equals the spread.)
  let boxes = [...nodes.values()], bottom = -Infinity;
  for (const n of boxes) bottom = Math.max(bottom, n.y + n.height);
  const baseBottom = Math.max(previous.height, bottom);
  // Each node gets at most 96 primary placement probes; fallback uses visible row corners and up to 32 columns. Order is topological, with stable sibling ties.
  while (remaining.length) {
    const index = remaining.findIndex(n => n.parents.every(p => nodes.has(p)));
    if (index < 0) return null;
    const [item] = remaining.splice(index, 1), parents = item.parents.map(p => nodes.get(p)!), parent = parents.reduce((a, b) => a.y + a.height > b.y + b.height ? a : b), cover = nodes.get(key)!;
    const arrivalGap = parents.length > 1 ? 24 : 20;
    // Up to 32 distinct in-bounds columns, in candidate order (dedupe, filter, then truncate).
    const xs: number[] = [], seen = new Set<number>();
    const column = (x: number) => {
      if (xs.length >= 32 || seen.has(x)) return;
      seen.add(x);
      if (x >= 24 && x + item.width <= width - 24) xs.push(x);
    };
    column(parent.x + parent.width + s.column); column(parent.x); column(24); column(width - item.width - 24);
    for (const b of boxes) { column(b.x); column(b.x + b.width + s.column); }
    const ys = distinctValues3(Math.max(cover.height + STACK_STEM_ROOM, parent.y), Math.max(cover.height + STACK_STEM_ROOM, parent.y + parent.height + arrivalGap), bottom + arrivalGap);
    // Every probe and slot has the item's height, so the boxes a row's tiles can overlap depend only on its y.
    const rows = new Map<number, PlacedNode[]>();
    const clear = (n: PlacedNode) => {
      let near = rows.get(n.y);
      if (!near) { const row = { y: n.y, height: n.height }; near = boxes.filter(b => overlapY(row, b, s.clearance)); rows.set(n.y, near); }
      for (const b of near) if (overlapX(n, b, s.clearance)) return false;
      return !oldSegments.hits(n);
    };
    const free = (n: PlacedNode) => parents.every(parent => n.x >= parent.x + parent.width || n.y >= parent.y + parent.height) && clear(n);
    // Rank every probe (x-major, as listed), then test freedom lazily: only probes up to the
    // first routable one are checked, and only those are built. Probe p is (xs[p / ny], ys[p % ny]).
    const ny = ys.length, ranked = rankProbes(xs, ys, bottom, item.height);
    const multi = parents.length > 1, id = `incremental-join:${item.key}`;
    let best: { node: PlacedNode; paths: Route[] } | undefined;
    for (const probe of ranked) {
      const x = xs[(probe - probe % ny) / ny], y = ys[probe % ny];
      const n: PlacedNode = { key: item.key, x, y, width: item.width, height: item.height, row: y === parent.y ? parent.row : parent.row + 1, band: parent.band + 1 };
      if (!free(n)) continue;
      const join = { key: id, x: n.x + n.width / 2, y: n.y - ARROW.length, width: 0, height: 0, row: n.row, band: n.band };
      // routeTo is pure, so the first unroutable parent settles the probe.
      const paths: Route[] = [];
      for (let i = 0; i < parents.length; i++) {
        const p = parents[i], route = routeTo(p, multi ? join : n, boxes, n, width, s.clearance + 2 + i * 3, multi, p.key === key);
        if (!route) break;
        paths.push(route);
      }
      if (paths.length === parents.length) { best = { node: n, paths }; break; }
    }
    if (!best) {
      const rowYs = [...new Set([Math.max(baseBottom, ...parents.map(p => p.y + p.height)) + arrivalGap,
        ...boxes.filter(n => n.y > baseBottom).map(n => n.y), Math.max(bottom, previous.height) + arrivalGap])].sort((a, b) => a - b);
      const slotXs = Array.from({ length: Math.min(32, Math.max(1, Math.floor((width - 48 + s.column) / (item.width + s.column)))) }, (_, i) => 24 + i * (item.width + s.column));
      let slot: PlacedNode | undefined;
      search: for (const y of rowYs) for (const x of slotXs) {
        const n = { key: item.key, x, y, width: item.width, height: item.height, row: parent.row + 1, band: parent.band + 1 };
        if (parents.every(p => n.y >= p.y + p.height || n.x >= p.x + p.width) && clear(n)) { slot = n; break search; }
      }
      if (!slot) return null;
      const n = slot, x = n.x;
      if (!(x >= 0 && x + item.width <= width)) return null;
      const joinX = x + item.width / 2, joinY = n.y - 2 * ARROW.length, obstacles = [...boxes, n];
      const paths: Route[] = [];
      for (const p of parents) {
        const start = point(p.x + p.width / 2, p.y + p.height + 2), goal = point(joinX, multi ? joinY : n.y - 16);
        const points = orthogonalRoute(start, goal, obstacles, width);
        // orthogonalRoute is pure, so the first failure settles the slot.
        if (!points) return null;
        const written = [point(start.x, p.y + p.height), ...points, ...(multi ? [] : [point(joinX, n.y - ARROW.length)])];
        paths.push({ d: path(written), ss: pathSegments(written) });
      }
      best = { node: n, paths };
    }
    const placed = best.node;
    if (nodes.has(item.key)) { nodes.set(item.key, placed); boxes = [...nodes.values()]; bottom = Math.max(...boxes.map(n => n.y + n.height)); }
    else { nodes.set(item.key, placed); boxes.push(placed); bottom = Math.max(bottom, placed.y + placed.height); }
    parents.forEach((p, i) => {
      const route: PlacedRoute = { id: `incremental:${p.key}:${item.key}`, from: { kind: "node", id: p.key },
        to: multi ? { kind: "junction", id } : { kind: "node", id: item.key },
        consumers: [{ parent: p.key, child: item.key }], terminal: !multi, path: best.paths[i].d };
      routes.push(route); oldSegments.add(best.paths[i].ss);
    });
    if (multi) {
      const x = placed.x + placed.width / 2, y = placed.y - 2 * ARROW.length, end = placed.y - ARROW.length;
      joins.set(id, { id, x, y, parents: item.parents });
      const tail: PlacedRoute = { id: `${id}:tail`, from: { kind: "junction", id }, to: { kind: "node", id: item.key },
        consumers: item.parents.map(parent => ({ parent, child: item.key })), terminal: true, path: `M${x} ${y} L${x} ${end}` };
      routes.push(tail); oldSegments.add(writtenSegments([point(x, y), point(x, end)]));
    }
  }
  const readingOrder = new Map<string, number>();
  for (let i = 0; i < request.items.length; i++) readingOrder.set(request.items[i].key, i);
  const provisional: GraphLayout = { ...previous, nodes, routes, junctions: joins, rows: [],
    height: bottom + s.bottom,
    readingOrder };
  const extent = bandExtent({ ...provisional, bandBounds: undefined }, key);
  if (extent.left < 0 || extent.left + extent.width > width) return null;
  return { ...provisional, bandBounds: { left: extent.left, width: extent.width, top: nodes.get(key)!.height + (request.history?.attachment?.placement.stemRoom ?? STACK_STEM_ROOM) }, preferredX: extent.left };
}
