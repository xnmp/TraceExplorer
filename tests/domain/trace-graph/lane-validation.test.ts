import { expect, it } from 'vitest';
import { type GraphLayout, type PlacedRoute } from '$lib/domain/trace-graph/layout';
import { sharedLaneLength } from '$lib/domain/trace-graph/layout-quality';
import { rng } from '../../../layout-eval/corpus';

const layoutOf = (routes: PlacedRoute[]): GraphLayout => ({ orientation: 'down', width: 1000, height: 1000, nodes: new Map(), routes, junctions: new Map(), rows: [], readingOrder: new Map() });

it('measures overlapping near lanes exactly, including nested intervals and source/junction exemptions', () => {
  const random = rng(813);
  for (const horizontal of [false, true]) {
    const runs = Array.from({ length: 120 }, (_, i) => {
      const lo = Math.floor(random() * 100), length = [0, 8, 9, 30, 100][i % 5];
      return { at: i % 12 + (i % 3) / 2, lo, hi: lo + length, source: `source${i % 17}`, join: i % 4 ? null : `join${i % 8}` };
    });
    const routes = runs.map((r, i): PlacedRoute => ({ id: `${i}`, from: { kind: 'node', id: r.source },
      to: { kind: r.join ? 'junction' : 'node', id: r.join ?? `target${i}` }, consumers: [], terminal: false,
      path: horizontal ? `M${r.lo} ${r.at} L${r.hi} ${r.at}` : `M${r.at} ${r.lo} L${r.at} ${r.hi}` }));
    // Independent all-pairs oracle over these straight segments, including exact collinear lanes.
    let expected = 0;
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i], b = runs[j], distance = Math.abs(a.at - b.at);
      if (a.source === b.source || a.hi === a.lo || b.hi === b.lo) continue;
      const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
      if (distance === 0) expected += Math.max(0, overlap);
      else if (distance < 2.99 && overlap > 8 && !(a.join && a.join === b.join)) expected += overlap;
    }
    expect(sharedLaneLength(layoutOf(routes))).toBe(expected);
    expect(sharedLaneLength(layoutOf([...routes].reverse()))).toBe(expected);
  }
});

it('validates disjoint intervals on nearby columns without quadratic growth', () => {
  const disjoint = (n: number) => layoutOf(Array.from({ length: n }, (_, i): PlacedRoute => ({
    id: String(i), from: { kind: "node", id: String(i % 2) }, to: { kind: "node", id: "target" }, consumers: [], terminal: false,
    path: `M${i % 2} ${i * 40} L${i % 2} ${i * 40 + 20}`,
  })));
  const small = disjoint(2000), large = disjoint(8000);
  const time = (layout: GraphLayout) => {
    const start = performance.now();
    expect(sharedLaneLength({ ...layout })).toBe(0);
    return performance.now() - start;
  };
  time(small); time(large);
  const smallMs: number[] = [], largeMs: number[] = [];
  for (let i = 0; i < 5; i++) { smallMs.push(time(small)); largeMs.push(time(large)); }
  const median = (values: number[]) => values.sort((a, b) => a - b)[2];
  // Four times the disjoint geometry may take up to eight times as long, plus timer/load slack.
  expect(median(largeMs)).toBeLessThan(8 * median(smallMs) + 20);
}, 30_000);
