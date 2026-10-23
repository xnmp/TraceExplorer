import { describe, expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import type { GraphLayout, LayoutItem, LayoutRequest } from '$lib/domain/trace-graph/layout';
import { wrapCuts, wrappedEmbedding, wrappedEmbeddings, wrappedGenerations } from '$lib/domain/trace-graph/wrapped-embedding';
import { attachSingleBand, withBandBounds } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';
import { layoutBand } from '$lib/domain/trace-graph/band-layout';

const item = (key: string, parents: string[] = [], order = 0, width = 92, height = 80): LayoutItem => ({ key, parents, order, width, height });
const band = (items: LayoutItem[], maxWidth = 454): LayoutRequest => ({ items, maxWidth, band: { key: items[0].key, items }, tileWidth: 92 });
const placed = (layout: GraphLayout, request: LayoutRequest) => attachSingleBand(withBandBounds(layout, request.band!.key), request);
const gate = (layout: GraphLayout, request: LayoutRequest) => geometryGate(placed(layout, request), request.items, request.band!.key, request.maxWidth);

describe('wrappedGenerations', () => {
  it('lists a tree under its cover by generation, siblings in order', () => {
    const request = band([item('r'), item('b', ['r'], 2), item('a', ['r'], 1), item('c', ['a'], 3)]);
    expect(wrappedGenerations(request)?.map(g => g.map(n => n.key))).toEqual([['a', 'b'], ['c']]);
  });
  it('declines merges, a cover with a parent, a missing cover and a lone cover', () => {
    expect(wrappedGenerations(band([item('r'), item('a', ['r']), item('b', ['r']), item('m', ['a', 'b'])]))).toBeNull();
    expect(wrappedGenerations({ ...band([item('p'), item('r', ['p']), item('a', ['r'])]), band: { key: 'r', items: [] } })).toBeNull();
    expect(wrappedGenerations({ ...band([item('r'), item('a', ['r'])]), band: { key: 'x', items: [] } })).toBeNull();
    expect(wrappedGenerations(band([item('r')]))).toBeNull();
  });
});

describe('wrapCuts', () => {
  const spans = (n: number) => Array.from({ length: n }, (_, i) => ({ left: i * 100, right: i * 100 + 80, height: 50 + i }));
  it('takes the fewest chunks that fit, every chunk within the width estimate', () => {
    const plans = wrapCuts(spans(6), 300, () => 10, () => 10, () => 20);
    expect(plans[0]).toEqual([3, 6]);
    for (const plan of plans) expect(plan.at(-1)).toBe(6);
  });
  it('re-cuts around a chunk proved to overflow', () => {
    const plans = wrapCuts(spans(6), 300, () => 10, () => 10, () => 20, (a, b) => a === 0 && b === 3);
    for (const plan of plans) expect(plan[0]).toBeLessThan(3);
  });
  it('has no plan when one column cannot fit', () => {
    expect(wrapCuts(spans(3), 50, () => 10, () => 10, () => 20)).toEqual([]);
  });
});

describe('wrapped rightward embeddings through the common solve', () => {
  const cases = ['chain-20', 'chain-80', 'screenshot', 'hidden-siblings', 'random-tree-40-7401', 'random-tree-100-8001', 'random-chainy-40-7701', 'random-bushy-40-7601'];
  for (const id of cases) it(`are certified, fit the pane and keep display order: ${id}`, () => {
    const fixture = corpus().find(c => c.id === id)!;
    let built = 0;
    for (const width of [360, 454, 900]) for (const px of [48, 96]) {
      const request = requestFor({ ...fixture, full: true }, null, width, px);
      const key = request.band!.key;
      for (const { layout, partition } of wrappedEmbeddings(request)) {
        built++;
        expect(gate(layout, request)).toBeNull();
        expect(layout.decision?.partition).toEqual(partition);
        const cover = layout.nodes.get(key)!;
        expect(cover.x + cover.width / 2).toBe(request.pinned!.x);
        const tiles = [...layout.nodes.values()].filter(n => n.key !== key);
        expect(Math.max(...tiles.map(n => n.x + n.width))).toBeLessThanOrEqual(layout.width);
        // Each chunk lies wholly below the one before; within a chunk generations run left to right.
        const generations = wrappedGenerations(request)!;
        const chunkOf = (g: number) => partition.findIndex(end => g < end);
        generations.forEach((generation, g) => generation.forEach(n => {
          const node = layout.nodes.get(n.key)!;
          if (g) for (const p of generations[g - 1].filter(q => n.parents.includes(q.key))) {
            const parent = layout.nodes.get(p.key)!;
            if (chunkOf(g) === chunkOf(g - 1)) expect(node.x).toBeGreaterThan(parent.x + parent.width);
            else expect(node.y).toBeGreaterThan(Math.max(...generations.slice(0, g).flat().map(q => layout.nodes.get(q.key)!.y + layout.nodes.get(q.key)!.height)));
          }
        }));
        // Display order: siblings keep their order and wrapped connectors never cross.
        const metrics = measure(placed(layout, request), key, request.maxWidth, request.items);
        expect(metrics.siblingInversions).toBe(0);
        expect(metrics.crossings).toBe(0);
      }
    }
    expect(built).toBeGreaterThan(0);
  });

  it('declines malformed plans and requests', () => {
    const request = requestFor({ ...corpus().find(c => c.id === 'chain-20')!, full: true }, null, 454, 96);
    const n = wrappedGenerations(request)!.length;
    for (const ends of [[], [n - 1], [3, 3, n], [5, 2, n], [n + 1]]) expect(wrappedEmbedding(request, ends)).toBeNull();
    const merge = band([item('r'), item('a', ['r']), item('b', ['r']), item('m', ['a', 'b'])]);
    expect(wrappedEmbeddings(merge)).toEqual([]);
    expect(wrappedEmbeddings(band([item('r')]))).toEqual([]);
  });

  it('names every route by its real edge, whatever the partition', () => {
    const fixture = corpus().find(c => c.id === 'random-tree-40-7401')!;
    const ids = (width: number) => {
      const request = requestFor({ ...fixture, full: true }, null, width, 96);
      const layout = wrappedEmbeddings(request)[0].layout;
      expect(new Set(layout.routes.map(r => r.id)).size).toBe(layout.routes.length);
      expect(layout.routes.every(r => !r.id.includes('wrap:') || r.id === JSON.stringify(['wrap', 'node', r.from.id]))).toBe(true);
      return { partition: layout.decision!.partition, terminal: new Set(layout.routes.filter(r => r.terminal).map(r => r.id)) };
    };
    const narrow = ids(360), wide = ids(454);
    expect(narrow.partition).not.toEqual(wide.partition);
    expect(narrow.terminal).toEqual(wide.terminal);
  });

  it('declines items in the breaking-point key namespace instead of throwing', () => {
    const request = band([item('r'), item('\u0001wrap:0', ['r']), item('b', ['\u0001wrap:0'])]);
    expect(wrappedGenerations(request)).toBeNull();
    expect(() => layoutBand(request)).not.toThrow();
  });

  it('wraps fractional tile sizes', () => {
    const items = [item('r'), ...Array.from({ length: 12 }, (_, i) => item(`c${i}`, [i ? `c${i - 1}` : 'r'], i + 1, 92.37, 80.333))];
    const request = band(items, 454);
    const built = wrappedEmbeddings(request);
    expect(built.some(w => w.partition.length > 1)).toBe(true);
    for (const { layout } of built) expect(gate(layout, request)).toBeNull();
  });

  it('is deterministic', () => {
    const request = requestFor({ ...corpus().find(c => c.id === 'random-tree-40-7401')!, full: true }, null, 454, 96);
    const a = wrappedEmbeddings(request), b = wrappedEmbeddings(request);
    expect(b.map(w => [w.partition, [...w.layout.nodes], w.layout.routes])).toEqual(a.map(w => [w.partition, [...w.layout.nodes], w.layout.routes]));
  });

  it('competes as a band candidate and publishes with its partition', () => {
    const request = requestFor({ ...corpus().find(c => c.id === 'chain-20')!, full: true }, null, 454, 96);
    const layout = layoutBand(request);
    expect(layout.decision?.candidate).toBe('wrapped-shelves');
    expect(layout.decision?.partition?.at(-1)).toBe(wrappedGenerations(request)!.length);
    expect(gate(layout, request)).toBeNull();
  });
});
