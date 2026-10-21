/** Conservative admission prepayment; the independent gate remains unchanged.
* Charge units are array/map entry visits or a bounded scalar/grid-range query.
* Returned work includes this helper and conservative prepaid oracle visits. */
import type { GraphLayout, LayoutItem } from './layout';
import { AXIS_SLACK, collinearOverlap, NEAR_RUN, segments } from './layout-quality';
import { LANE_SEPARATION } from './metrics';
export interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}
export type Charge = (work: number, reason?: string) => void;
interface Range {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cells: number;
}
const box = (a: {
  x: number;
  y: number;
}, b = a): Box => ({ minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
const expanded = (b: Box, margin: number): Box => ({ minX: b.minX - margin, maxX: b.maxX + margin, minY: b.minY - margin, maxY: b.maxY + margin });
const range = (b: Box, size: number, margin: number): Range | null => {
  if (![b.minX, b.maxX, b.minY, b.maxY].every(Number.isFinite) || b.minX > b.maxX || b.minY > b.maxY)
    return null;
  const x0 = Math.floor((b.minX - margin) / size), x1 = Math.floor((b.maxX + margin) / size), y0 = Math.floor((b.minY - margin) / size), y1 = Math.floor((b.maxY + margin) / size);
  if (![x0, x1, y0, y1].every(Number.isSafeInteger) || x0 <= -2147483648 || x1 >= 2147483648 || y0 <= -1048576 || y1 >= 1048576)
    return null;
  return { x0, x1, y0, y1, cells: (x1 - x0 + 1) * (y1 - y0 + 1) };
};
export function prepayBins(entries: readonly Box[], queries: readonly Box[], size: number, margin: number, charge: Charge, mode: 'spatial' | 'grid-pairs' = 'spatial') {
  const label = `admission ${mode} ${size}/${margin}`;
  let work = 0;
  const spend = (n: number, why: string) => { charge(n, `${label} ${why}`); work += n; };
  spend(3 * (entries.length + queries.length + 1), 'range table');
  const ranges = entries.flatMap(b => { const r = range(b, size, margin); return r ? [r] : []; }), qranges = queries.flatMap(b => { const r = range(b, size, mode === 'grid-pairs' ? margin : 0); return r ? [r] : []; });
  if (ranges.length !== entries.length || qranges.length !== queries.length)
    return { unsupported: true, work };
  let memberships = 0, wide = 0, gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
  for (const r of ranges) {
    if (r.cells > 4096) {
      wide++;
      continue;
    }
    memberships += r.cells;
    gx0 = Math.min(gx0, r.x0);
    gx1 = Math.max(gx1, r.x1);
    gy0 = Math.min(gy0, r.y0);
    gy1 = Math.max(gy1, r.y1);
  }
  const rectangle = gx1 >= gx0 ? (gx1 - gx0 + 1) * (gy1 - gy0 + 1) : 0;
  // gridPairs declines before allocation for any wide entry or >1M global cells;
  // caller's P^2 sweep allowance then covers the unchanged fallback branch.
  if (mode === 'grid-pairs' && (wide || rectangle > 1 << 20))
    return { unsupported: false, mode, work, memberships, wide, rectangle, skipped: true };
  // One visit builds the preflight occupancy count. Two visits prepay oracle add
  // and an optional dense→keyed replay. No membership loop executes unpaid.
  spend(3 * memberships + wide, 'membership construction and oracle insertions');
  const occupancy = new Map<string, number>();
  for (const r of ranges)
    if (r.cells <= 4096)
      for (let x = r.x0; x <= r.x1; x++)
        for (let y = r.y0; y <= r.y1; y++) {
          const key = x + ',' + y;
          occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
        }
  // gridPairs has explicit global prefix/fill passes. SpatialBins uses a dense
  // array only below this exact constructor limit; keyed mode has no global grid.
  const dense = mode === 'grid-pairs' ? rectangle : rectangle <= Math.min(1 << 20, Math.max(4096, 16 * entries.length)) ? rectangle : 0;
  spend(3 * dense + entries.length, 'dense arrays and metadata');
  let queryCells = 0, queryEntries = 0;
  for (const r of qranges) {
    let hits = wide;
    if (r.cells > 4096) {
      hits += memberships + occupancy.size;
      spend(1, 'wide query metadata');
    }
    else {
      // Prepay both preflight cell enumeration and oracle cell enumeration. An
      // actual oracle query may clamp its range; using the entire range is safe.
      spend(2 * r.cells, 'query cell loops');
      queryCells += r.cells;
      for (let x = r.x0; x <= r.x1; x++)
        for (let y = r.y0; y <= r.y1; y++)
          hits += occupancy.get(x + ',' + y) ?? 0;
    }
    // Includes duplicates in ALL shared cells, self and future entries. This
    // upper-bounds incremental SpatialBins and gridPairs' break/stamp behavior.
    spend(hits, 'query membership visits');
    queryEntries += hits;
  }
  return { unsupported: false, mode, work, memberships, wide, rectangle, dense, queryCells, queryEntries, skipped: false };
}
/** An upper bound on the crossing pass's shared-lane pairs, whose keys it sorts:
 * pairs of segments of different routes and sources whose bounds touch (the
 * pass visits no others) and that overlap collinearly in either order. Counted
 * through a uniform grid of 48 px cells, each pair once; every membership and
 * pair visit is charged before it runs. Null when an entry or the grid is too
 * large for the census, so the caller falls back to bounding by visits. */
function sharedLanePairs(layout: GraphLayout, routes: readonly (readonly (readonly [{ x: number; y: number }, { x: number; y: number }])[])[], charge: Charge): number | null {
  const EPS = .001, CELL = 48;
  const items: { readonly route: number; readonly source: string; readonly a: { x: number; y: number }; readonly b: { x: number; y: number };
    readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }[] = [];
  charge(4 * routes.length + 1, 'admission shared-lane census sources');
  routes.forEach((ss, route) => {
    const from = layout.routes[route].from, source = from.kind + '\u0000' + from.id;
    for (const [a, b] of ss) items.push({ route, source, a, b, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
  });
  charge(2 * items.length + 1, 'admission shared-lane census entries');
  let cells = 0;
  for (const item of items) {
    const c = (Math.floor((item.x1 + EPS) / CELL) - Math.floor((item.x0 - EPS) / CELL) + 1) * (Math.floor((item.y1 + EPS) / CELL) - Math.floor((item.y0 - EPS) / CELL) + 1);
    if (!Number.isSafeInteger(c) || c > 4096) return null;
    cells += c;
  }
  if (cells > 1 << 20) return null;
  charge(3 * cells, 'admission shared-lane census membership');
  const cellX0 = (i: number) => Math.floor((items[i].x0 - EPS) / CELL), cellY0 = (i: number) => Math.floor((items[i].y0 - EPS) / CELL);
  // Cell keys are exact while every cell coordinate stays below 2^21 in magnitude.
  if (items.some((item, i) => Math.abs(cellX0(i)) >= 2097152 || Math.abs(cellY0(i)) >= 2097152
    || Math.abs(Math.floor((item.x1 + EPS) / CELL)) >= 2097152 || Math.abs(Math.floor((item.y1 + EPS) / CELL)) >= 2097152)) return null;
  const grid = new Map<number, { readonly x: number; readonly y: number; readonly list: number[] }>();
  items.forEach((item, i) => {
    for (let x = cellX0(i); x <= Math.floor((item.x1 + EPS) / CELL); x++)
      for (let y = cellY0(i); y <= Math.floor((item.y1 + EPS) / CELL); y++) {
        const key = x * 4194304 + y, cell = grid.get(key);
        if (cell) cell.list.push(i); else grid.set(key, { x, y, list: [i] });
      }
  });
  let pairs = 0;
  for (const { x, y, list } of grid.values()) {
    charge(list.length * (list.length - 1) / 2 + 1, 'admission shared-lane census pair visits');
    for (let u = 0; u < list.length; u++) for (let v = u + 1; v < list.length; v++) {
      const s = items[list[u]], t = items[list[v]];
      if (s.route === t.route || s.source === t.source) continue;
      if (!(s.x1 >= t.x0 - EPS && t.x1 >= s.x0 - EPS && s.y1 >= t.y0 - EPS && t.y1 >= s.y0 - EPS)) continue;
      // Two touching entries share every cell of their ranges' overlap; count the pair in its first.
      if (x !== Math.max(cellX0(list[u]), cellX0(list[v])) || y !== Math.max(cellY0(list[u]), cellY0(list[v]))) continue;
      if (collinearOverlap(s.a.x, s.a.y, s.b.x, s.b.y, t.a.x, t.a.y, t.b.x, t.b.y) !== 0
        || collinearOverlap(t.a.x, t.a.y, t.b.x, t.b.y, s.a.x, s.a.y, s.b.x, s.b.y) !== 0) pairs++;
    }
  }
  return pairs;
}
/** Pair visits of the gate's near-lane pass: it forms the same axis-parallel
 * runs (consecutive collinear pieces of a route), keeps those longer than
 * `NEAR_RUN`, and compares each with active runs in its own and the two
 * neighbouring `LANE_SEPARATION` bins only. The sum over bins of count x
 * (count in that bin and its neighbours) bounds those visits. */
function nearLanePairs(routes: readonly (readonly (readonly [{ x: number; y: number }, { x: number; y: number }])[])[]): number {
  const bins = [new Map<number, number>(), new Map<number, number>()];
  for (const ss of routes) {
    let axis = 0, at = 0, lo = 0, hi = 0;
    const flush = () => {
      if (axis && hi - lo > NEAR_RUN) {
        const map = bins[axis - 1], key = Math.floor(at / LANE_SEPARATION);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      axis = 0;
    };
    for (const [{ x: x0, y: y0 }, { x: x1, y: y1 }] of ss) {
      const along = Math.abs(y0 - y1) < AXIS_SLACK && Math.abs(x0 - x1) > 0 ? 1 : Math.abs(x0 - x1) < AXIS_SLACK && Math.abs(y0 - y1) > 0 ? 2 : 0;
      const c = along === 1 ? (y0 + y1) / 2 : (x0 + x1) / 2, a = along === 1 ? Math.min(x0, x1) : Math.min(y0, y1), b = along === 1 ? Math.max(x0, x1) : Math.max(y0, y1);
      if (along && along === axis && Math.abs(c - at) < AXIS_SLACK && a <= hi + AXIS_SLACK && b >= lo - AXIS_SLACK) { lo = Math.min(lo, a); hi = Math.max(hi, b); continue; }
      flush();
      if (along) { axis = along; at = c; lo = a; hi = b; }
    }
    flush();
  }
  let pairs = 0;
  for (const map of bins) for (const [key, count] of map) pairs += count * ((map.get(key - 1) ?? 0) + count + (map.get(key + 1) ?? 0));
  return pairs;
}
export function prepayIndependentAdmission(layout: GraphLayout, items: readonly LayoutItem[], nativeSamples: number, charge: Charge): boolean {
  charge(layout.routes.length + items.length + 1, 'independent admission inputs');
  for (const route of layout.routes)
    charge(16 * route.path.length + 1, 'independent admission sample preparation');
  const routes = layout.routes.map(r => segments(r.path));
  const p = routes.reduce((sum, ss) => sum + ss.length, 0), r = routes.length, n = layout.nodes.size;
  const e = items.reduce((sum, item) => sum + item.parents.length, 0);
  const tables = new Set<readonly unknown[]>();
  let k = 0, t = 0;
  for (const route of layout.routes) {
    const c = route.consumers, entries = Array.isArray(c) ? c : (c as {
      readonly entries: readonly unknown[];
    }).entries;
    k += Array.isArray(c) ? c.length : (c as {
      readonly start: number;
      readonly end: number;
    }).end - (c as {
      readonly start: number;
      readonly end: number;
    }).start;
    if (!tables.has(entries)) {
      tables.add(entries);
      t += entries.length;
    }
  }
  const bounds = routes.flatMap(ss => ss.map(([a, b]) => box(a, b)));
  const routeBounds = routes.map(ss => ss.reduce((v, [a, b]) => ({ minX: Math.min(v.minX, a.x, b.x), maxX: Math.max(v.maxX, a.x, b.x), minY: Math.min(v.minY, a.y, b.y), maxY: Math.max(v.maxY, a.y, b.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }));
  const endpoints = routes.flatMap(ss => ss.length ? [expanded(box(ss[0][0]), .15), expanded(box(ss.at(-1)![1]), .15)] : []);
  const starts = routes.flatMap(ss => ss.length ? [box(ss[0][0])] : []);
  const ports = [...layout.nodes.values()].flatMap(n => [expanded(box({ x: n.x + n.width / 2, y: n.y + n.height }), .15), expanded(box({ x: n.x + n.width, y: n.y + n.height / 2 }), .15)]);
  // Prepay every possible branch rather than reproduce source/group/needsJoins
  // predicates. Every subset actually used has no greater occupancy or visits.
  const prepaid = [
    prepayBins(bounds, bounds, 48, .001, charge, 'grid-pairs'),
    prepayBins(bounds, bounds, 48, .15, charge),
    prepayBins(bounds, endpoints, 48, .15, charge),
    prepayBins(routeBounds, endpoints, 96, .15, charge),
    prepayBins(starts, ports, 96, 0, charge),
  ];
  const grid = prepaid[0];
  // The crossing pass pairs its entries (a filtered subset of the p segments)
  // through the grid, or sweeps them: always below 256 entries, and above it
  // only when the grid declines, which the grid-pairs prepay above predicts
  // exactly. Each pair it visits may add a shared-lane key that is sorted.
  const q = Math.min(p, 255), small = q * (q - 1) / 2;
  const sweep = small + (grid.unsupported || grid.skipped ? p * (p - 1) / 2 : 0);
  const shared = sharedLanePairs(layout, routes, charge);
  const keys = shared ?? small + (grid.unsupported || grid.skipped ? p * (p - 1) / 2 : grid.queryEntries ?? 0);
  // Near-lane runs visit active runs in their own and the two neighbouring
  // lane bins only; forming the runs costs a visit per segment.
  const nearLanes = nearLanePairs(routes) + 3 * p;
  const sorted = p + r + n;
  // Pair sweeps, tile/segment tests, directed source claims and per-edge BFS.
  // A carrier is visited at most once per expected edge; each visit scans at
  // most r outgoing links. Spatial duplicates are prepaid by the bins above.
  // The route-clearance part of the gate repeats the native clearance check,
  // which its callers run and charge on the same drawing beforehand.
  charge(Math.ceil(sweep + keys * (4 + Math.ceil(Math.log2(keys + 1))) + nearLanes + sorted * (2 + Math.ceil(Math.log2(sorted + 1))))
    + 2 * p * n + n * n + r * r + 2 * r * p + n * r + k * (r + 2) + e + 4 * t
    + 2 * r * nativeSamples + nativeSamples * (2 + Math.ceil(Math.log2(nativeSamples + 1))) ** 2 + 1, 'independent admission scalar and graph checks');
  return prepaid.every(result => !result.unsupported);
}
