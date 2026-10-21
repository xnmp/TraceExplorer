/** Construction probes are checked locally. A probe pays for its own route and
 * the pairs it visits; retained routes are painted, read, indexed and given an
 * envelope once per ledger. Locality must never change a verdict: the cached
 * pair check equals the full native clearance on the same two routes, and the
 * identity painter paints exactly what attachment paints. */
import { describe, expect, it } from 'vitest';
import { chargedNativeClearance, NativeRouteCache, outOfNativeReach } from '$lib/domain/trace-graph/native-route-clearance';
import { attachSingleBand, identitySingleBandPainter, retainSingleBandFrame } from '$lib/domain/trace-graph/band-geometry';
import { pinnedBandExtent } from '$lib/domain/trace-graph/pinned-band-extent';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';
import { STACK_STEM_ROOM } from '$lib/domain/trace-graph/metrics';
import { node, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';

const route = (id: string, path: string, terminal = false, from = id): PlacedRoute => ({
  id, from: { kind: 'node', id: from }, to: { kind: 'node', id: `${id}:to` }, terminal, consumers: [], path,
});
const drawing = (routes: PlacedRoute[], nodes = new Map(), junctions = new Map()): GraphLayout => ({
  orientation: 'down', nodes, routes, junctions, rows: [], width: 2000, height: 2000, readingOrder: new Map(),
} as unknown as GraphLayout);
const free = () => {};
const shift = (path: string, dx: number, dy: number) => path.replace(/-?\d+(\.\d+)?/g, (n, _f, at, s) => {
  const index = s.slice(0, at).match(/-?\d+(\.\d+)?/g)?.length ?? 0;
  return String(+n + (index % 2 ? dy : dx));
});
const shapes = (x: number, y: number) => [
  `M${x} ${y} L${x} ${y + 80}`, `M${x} ${y} L${x + 80} ${y}`, `M${x} ${y} L${x} ${y + 40} L${x + 40} ${y + 40}`,
  `M${x} ${y} C${x} ${y + 30} ${x + 30} ${y + 40} ${x + 60} ${y + 40}`,
];

describe('cached pairwise native clearance', () => {
  it('gives the full check\'s verdict for every near pair, in either order and on reuse', () => {
    const cache = new NativeRouteCache();
    let rejected = 0, compared = 0;
    const retained = shapes(100, 100).flatMap((path, i) => [false, true].map(terminal => route(`a${i}${terminal}`, path, terminal)));
    for (const a of retained) for (const [j, second] of shapes(100, 100).entries())
      for (const dx of [-40, -8, -6, -3, 0, 3, 6, 8, 40]) for (const dy of [-40, -6, 0, 6, 40]) {
        const b = route(`b${j}`, shift(second, dx, dy), !a.terminal);
        const expected = chargedNativeClearance(drawing([a, b]), free);
        if (expected) rejected++;
        compared++;
        expect(cache.pair(drawing([a, b]), a, b, free), `${a.path} / ${b.path}`).toBe(expected);
        expect(cache.pair(drawing([b, a]), b, a, free)).toBe(chargedNativeClearance(drawing([b, a]), free));
        expect(cache.outOfReach(a, b, free)).toBe(outOfNativeReach(a, b, free));
      }
    expect(compared).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(100);
  });

  it('honours tile ports, junction joins and endpoint masks like the full check', () => {
    const tile = { key: 'A', x: 80, y: 60, width: 40, height: 40, row: 0, band: 0 };
    const nodes = new Map([['A', tile]]), junctions = new Map([['J', { id: 'J', x: 300, y: 100, parents: [] }]]);
    const fromTile = route('a', 'M100 100 L100 200', false, 'A');
    const intoDot: PlacedRoute = { ...route('k', 'M240 40 L300 40 L300 100'), to: { kind: 'junction', id: 'J' } };
    const fromDot: PlacedRoute = { ...route('j', 'M300 100 L300 200'), from: { kind: 'junction', id: 'J' } };
    const cache = new NativeRouteCache();
    for (const base of [fromTile, fromDot]) for (const dx of [3, 4.5, 5.5, 6, 8]) for (const masked of [false, true]) {
      const x = +base.path.split(' ')[0].slice(1) + dx, y = +base.path.split(' ')[1];
      const other = route('o', `M${x} ${y - 3} L${x} ${y - 60}`);
      const options = masked ? { endpointMasks: new Map([[base, { start: false, end: true }]]) } : undefined;
      expect(cache.pair(drawing([base, other], nodes, junctions), base, other, free, options))
        .toBe(chargedNativeClearance(drawing([base, other], nodes, junctions), free, options));
    }
    // A join at the shared dot is intentional for both routes.
    expect(cache.pair(drawing([intoDot, fromDot], nodes, junctions), intoDot, fromDot, free))
      .toBe(chargedNativeClearance(drawing([intoDot, fromDot], nodes, junctions), free));
  });

  it('re-reads a route whose endpoint tile changed', () => {
    const near = { key: 'A', x: 80, y: 60, width: 40, height: 40, row: 0, band: 0 };
    const moved = { ...near, y: 0 };
    const base = route('a', 'M100 100 L100 200', false, 'A'), other = route('o', 'M105 97 L105 40');
    const cache = new NativeRouteCache();
    const before = drawing([base, other], new Map([['A', near]])), after = drawing([base, other], new Map([['A', moved]]));
    expect(cache.pair(before, base, other, free)).toBe(chargedNativeClearance(before, free));
    expect(cache.pair(after, base, other, free)).toBe(chargedNativeClearance(after, free));
    expect(chargedNativeClearance(before, free)).not.toBe(chargedNativeClearance(after, free));
  });

  it('pays for a retained route once, then only for the new route and the pair', () => {
    const cache = new NativeRouteCache(), retained = route('r', 'M0 0 L0 400 L300 400');
    const spent = (path: string) => {
      let work = 0;
      const probe = route('p', path);
      cache.pair(drawing([retained, probe]), retained, probe, amount => { work += amount; });
      return work;
    };
    const first = spent('M8 0 L8 300'), second = spent('M8 0 L8 300');
    expect(second).toBeLessThan(first);
    let fresh = 0;
    chargedNativeClearance(drawing([retained, route('p', 'M8 0 L8 300')]), amount => { fresh += amount; });
    expect(second).toBeLessThan(fresh);
  });

  it('rejects an unreadable route wherever it is', () => {
    const cache = new NativeRouteCache(), far = route('f', 'M900 900 L950 900');
    for (const path of ['M0 0 L0 NaN', 'M0 0 l0 50', '']) {
      const bad = route('b', path);
      expect(cache.pair(drawing([bad, far]), bad, far, free)).toBe(chargedNativeClearance(drawing([bad, far]), free));
      expect(cache.pair(drawing([far, bad]), far, bad, free)).toBe(chargedNativeClearance(drawing([far, bad]), free));
    }
  });
});

// Construction works in the committed, attached frame (the published drawing).
describe('identity attachment painter', () => {
  const nodes = [node('root'), node('a', ['root'], 1), node('b', ['root'], 2), node('c', ['a', 'b'], 3), node('d', ['c'], 4), node('e', ['a'], 5)];
  const request = requestFor({ id: 'painter', nodes, focuses: [null] }, null, 640, 96);
  const allocate = (layout: GraphLayout) => {
    const key = request.band!.key, extent = pinnedBandExtent(layout, key)!;
    return { ...layout, bandBounds: { left: 0, width: extent.left + extent.width, top: layout.nodes.get(key)!.height + STACK_STEM_ROOM }, preferredX: 0 };
  };

  it('paints every route exactly as attachment does', () => {
    const layout = optimizedBand(request, {}).placed;
    const declared = retainSingleBandFrame(allocate(layout), request, layout.routes);
    expect(declared).not.toBeNull();
    const painter = identitySingleBandPainter(declared!, request)!;
    expect(painter).not.toBeNull();
    const attached = attachSingleBand(declared!, request);
    expect(declared!.routes.map(painter.paint)).toEqual(attached.routes);
    // Tiles and dots keep their values under the identity frame.
    expect([...attached.nodes]).toEqual([...declared!.nodes]);
    expect([...attached.junctions]).toEqual([...declared!.junctions]);
    // Undeclared root routes get their attachment stem rebuilt, as attachment does.
    const undeclared = retainSingleBandFrame(allocate(layout), request, [])!;
    const repainter = identitySingleBandPainter(undeclared, request)!;
    expect(undeclared.routes.map(repainter.paint)).toEqual(attachSingleBand(undeclared, request).routes);
  });

  it('declines a frame that is not the identity', () => {
    const layout = optimizedBand(request, {}).placed, allocated = allocate(layout);
    const cover = allocated.nodes.get(request.band!.key)!;
    const shifted = { ...allocated, nodes: new Map([...allocated.nodes, [cover.key, { ...cover, y: 5 }]]) };
    expect(identitySingleBandPainter(shifted, request)).toBeNull();
    expect(identitySingleBandPainter({ ...allocated, bandBounds: { ...allocated.bandBounds, top: allocated.bandBounds.top + 10 } }, request)).toBeNull();
    expect(identitySingleBandPainter(allocated, request)).not.toBeNull();
  });
});
