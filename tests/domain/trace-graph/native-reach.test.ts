/** Native clearance is local: a route pair whose painted envelopes are farther
 * apart than the largest clearance radius cannot fail the pair check, so the
 * constructor may skip it. The skip must never hide a contact. */
import { describe, expect, it } from 'vitest';
import { chargedNativeClearance, NATIVE_REACH, outOfNativeReach } from '$lib/domain/trace-graph/native-route-clearance';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';

const route = (id: string, path: string, terminal = false, from = id): PlacedRoute => ({
  id, from: { kind: 'node', id: from }, to: { kind: 'node', id: `${id}:to` }, terminal, consumers: [], path,
});
const drawing = (routes: PlacedRoute[], nodes = new Map(), junctions = new Map()): GraphLayout => ({
  orientation: 'down', nodes, routes, junctions, rows: [], width: 2000, height: 2000, readingOrder: new Map(),
} as unknown as GraphLayout);
const free = () => {};

describe('native reach', () => {
  it('skips only pairs at least the largest clearance radius apart', () => {
    const a = route('a', 'M100 100 L100 300');
    expect(outOfNativeReach(a, route('b', `M${100 + NATIVE_REACH} 100 L${100 + NATIVE_REACH} 300`), free)).toBe(true);
    expect(outOfNativeReach(a, route('b', `M${100 + NATIVE_REACH - .01} 100 L${100 + NATIVE_REACH - .01} 300`), free)).toBe(false);
    // A terminal arrowhead extends the envelope past the path's last point.
    expect(outOfNativeReach(route('t', 'M0 0 L0 100', true), route('u', `M0 ${100 + NATIVE_REACH + 1} L50 ${100 + NATIVE_REACH + 1}`), free)).toBe(false);
    // Curve control points bound the ink, not only the end points.
    expect(outOfNativeReach(route('c', 'M0 0 C0 0 60 50 0 100'), route('v', 'M40 0 L40 100'), free)).toBe(false);
  });
  it('never skips a path the strict reader rejects', () => {
    for (const path of ['M0 0 L0 0', 'M0 0 l0 50', 'M0 0 L0 50 Z', 'M0 0 L0 5 M9 9 L9 20', 'M0 0 C5 5 -5 5 0 0', 'MNaN NaN L0 0 L5 5', 'M0 0 H50'])
      expect(outOfNativeReach(route('a', path), route('b', 'M900 900 L950 900'), free), path).toBe(false);
  });
  it('never skips an unreadable path and charges both parses', () => {
    let work = 0;
    const charge = (amount: number) => { work += amount; };
    expect(outOfNativeReach(route('a', 'M0 0 L0 NaN'), route('b', 'M900 900 L950 900'), charge)).toBe(false);
    expect(outOfNativeReach(route('a', ''), route('b', 'M900 900 L950 900'), charge)).toBe(false);
    expect(work).toBe('M0 0 L0 NaN'.length + 'M900 900 L950 900'.length + 2 + 'M900 900 L950 900'.length + 2);
  });
  // Exhaustive near-boundary pairs: parallel, crossing, end-to-run and curved,
  // terminal or not, at offsets around the reach. Every skipped pair is clear.
  it('never skips a pair that the clearance check rejects', () => {
    const shapes = (x: number, y: number) => [
      `M${x} ${y} L${x} ${y + 80}`, `M${x} ${y} L${x + 80} ${y}`, `M${x} ${y} L${x} ${y + 40} L${x + 40} ${y + 40}`,
      `M${x} ${y} C${x} ${y + 30} ${x + 30} ${y + 40} ${x + 60} ${y + 40}`,
    ];
    let skipped = 0, rejected = 0;
    for (const [i, first] of shapes(100, 100).entries()) for (const [j, second] of shapes(0, 0).entries())
      for (const terminal of [false, true]) for (const dx of [-90, -60, -40, -20, -8, -6, -3, 0, 3, 6, 8, 20, 40, 60, 90])
        for (const dy of [-90, -40, -8, -6, 0, 6, 8, 40, 90]) {
          const a = route(`a${i}`, first, terminal), b = route(`b${j}`, second.replace(/-?\d+(\.\d+)?/g, (n, _f, at, s) => {
            const index = s.slice(0, at).match(/-?\d+(\.\d+)?/g)?.length ?? 0;
            return String(+n + (index % 2 ? 100 + dy : 100 + dx));
          }), !terminal);
          const failure = chargedNativeClearance(drawing([a, b]), free);
          if (failure) rejected++;
          if (outOfNativeReach(a, b, free)) { skipped++; expect(failure, `${first} / ${b.path}`).toBeNull(); }
        }
    expect(skipped).toBeGreaterThan(100);
    expect(rejected).toBeGreaterThan(100);
  });
  // The largest radii: a port on a tile outline (PORT_BERTH) and a junction dot.
  // Routes leaving those ends sit just inside and just outside the reach.
  it('covers the port berth and junction clearance radii', () => {
    const tile = { key: 'A', x: 80, y: 60, width: 40, height: 40, row: 0, band: 0 };
    const nodes = new Map([['A', tile]]), junctions = new Map([['J', { id: 'J', x: 300, y: 100, parents: [] }]]);
    const fromTile = route('a', 'M100 100 L100 200', false, 'A');
    const fromDot: PlacedRoute = { ...route('j', 'M300 100 L300 200'), from: { kind: 'junction', id: 'J' } };
    let near = 0;
    for (const base of [fromTile, fromDot]) for (const dx of [3, 4, 4.5, 5, 5.5, 5.99, 6, 6.5, 8]) {
      const x = +base.path.split(' ')[0].slice(1) + dx, y = +base.path.split(' ')[1];
      const other = route('o', `M${x} ${y - 3} L${x} ${y - 60}`);
      const failure = chargedNativeClearance(drawing([base, other], nodes, junctions), free);
      if (failure) near++;
      if (outOfNativeReach(base, other, free)) expect(failure, `${base.id} ${dx}`).toBeNull();
    }
    expect(near).toBeGreaterThan(4);
  });
});
