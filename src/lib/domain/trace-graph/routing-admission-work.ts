/** Conservative admission prepayment; the independent gate remains unchanged.
* Charge units are array/map entry visits or a bounded scalar/grid-range query.
* Returned work includes this helper and conservative prepaid oracle visits. */
import type { GraphLayout, LayoutItem } from './layout';
import { segments } from './layout-quality';
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
  // Pair sweeps, tile/segment tests, directed source claims and per-edge BFS.
  // A carrier is visited at most once per expected edge; each visit scans at
  // most r outgoing links. Spatial duplicates are prepaid separately below.
  charge(p * p + 2 * p * n + n * n + r * r + 2 * r * p + n * r + k * (r + 2) + e + 4 * t
    + 2 * r * nativeSamples + nativeSamples * (2 + Math.ceil(Math.log2(nativeSamples + 1))) ** 2 + 1, 'independent admission scalar and graph checks');
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
  return prepaid.every(result => !result.unsupported);
}
