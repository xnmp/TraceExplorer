import { describe, expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { wrapCapacity, wrapRow, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { gridEmbedding, gridRowsEmbedding, serialRowsEmbedding } from '$lib/domain/trace-graph/cold-embeddings';
import { ladderPins, layoutBand } from '$lib/domain/trace-graph/band-layout';
import { bandHistorySignature, historyFit } from '$lib/domain/trace-graph/band-history';
import { TILE } from '$lib/domain/trace-graph/metrics';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';
import { safeLayout } from '$lib/domain/trace-graph/safe-layout';

const certified = (layout: GraphLayout | null, request: LayoutRequest) =>
  !!layout && !geometryGate(attachSingleBand(layout, request), request.items, request.band!.key, request.maxWidth);
const rowSizes = (layout: GraphLayout, cover: string) =>
  layout.rows.filter(row => !row.keys.includes(cover)).map(row => row.keys.length);

describe('wrapCapacity', () => {
  it('is the default wrap without a usable capacity', () => {
    const widths = [100, 100, 100, 100, 100];
    for (const capacity of [undefined, 0, -1, NaN, 5, 9]) expect(wrapCapacity(widths, 340, 20, capacity)).toEqual(wrapRow(widths, 340, 20));
    expect(wrapCapacity([], 100, 10, 1)).toEqual([]);
  });
  it('keeps order, caps each row and balances counts', () => {
    const rows = wrapCapacity([10, 10, 10, 10, 10, 10, 10], 1000, 5, 3);
    expect(rows).toEqual([[0, 1, 2], [3, 4], [5, 6]]);
    expect(wrapCapacity([10, 10, 10], 1000, 5, 1)).toEqual([[0], [1], [2]]);
  });
  it('still wraps by width inside a capacity group', () => {
    expect(wrapCapacity([300, 300, 300, 300], 500, 10, 2)).toEqual([[0], [1], [2], [3]]);
  });
});

describe('cold embeddings through the common layered solve', () => {
  const cases = ['fan-30', 'screenshot', 'random-dag-40-7501', 'random-tree-100-8001', 'chain-20'];
  for (const id of cases) it(`serial rows hold one tile per display row and are certified: ${id}`, () => {
    const fixture = corpus().find(c => c.id === id)!;
    for (const width of [360, 900]) {
      const request = requestFor({ ...fixture, full: true }, null, width, 96);
      const layout = serialRowsEmbedding(request)!;
      expect(certified(layout, request)).toBe(true);
      expect(rowSizes(layout, request.band!.key).every(n => n === 1)).toBe(true);
      // The pinned cover is a constraint of the same solve.
      const cover = layout.nodes.get(request.band!.key)!;
      expect(cover.x + cover.width / 2).toBe(request.pinned!.x);
    }
  });

  it('grid rows respect their capacity, and do not apply to a chain', () => {
    const fan = requestFor({ ...corpus().find(c => c.id === 'fan-30')!, full: true }, null, 900, 96);
    const embedding = gridEmbedding(fan)!;
    const layout = gridRowsEmbedding(fan)!;
    expect(certified(layout, fan)).toBe(true);
    expect(Math.max(...rowSizes(layout, fan.band!.key))).toBeLessThanOrEqual(embedding.capacity);
    const chain = requestFor({ ...corpus().find(c => c.id === 'chain-20')!, full: true }, null, 900, 96);
    expect(gridEmbedding(chain)).toBeNull();
  });

  it.each([2, 7, 43, 100])('grid rows keep all %i unequal fan tiles and parent edges, the same under permutation', count => {
    const items = Array.from({ length: count }, (_, i) => ({ key: String(i), order: count - i,
      width: 92 + i % 3 * 16, height: 97 + i % 4 * 16, parents: i ? ['0'] : [] }));
    const request = { items, band: { key: '0', items }, maxWidth: 640, tileWidth: 92, pinned: { key: '0', x: 320 } };
    const layout = gridRowsEmbedding(request) ?? serialRowsEmbedding(request)!;
    expect(certified(layout, request)).toBe(true);
    const placed = attachSingleBand(layout, request);
    expect(placed.nodes.size).toBe(count);
    expect(measure(placed, '0', 640, items)).toMatchObject({ missingEdges: 0, disconnectedEdges: 0, overflow: 0 });
    const permuted = { ...request, items: [...items].reverse() };
    const again = gridRowsEmbedding(permuted) ?? serialRowsEmbedding(permuted)!;
    expect([...again.nodes]).toEqual([...layout.nodes]);
  });

  // The legacy fan grid drew these without its side gutters. The embeddings keep
  // their route margin, so below one tile and two margins their ink overflows the
  // pane by at most that margin; they are still certified.
  it.each([[96, 20], [108, 20], [120, 0]])('certify a fan when only %i px of pane is available (overflow ≤ %i px)', (width, overflow) => {
    const items = Array.from({ length: 17 }, (_, i) => ({ key: String(i), order: i, width: 96, height: 96, parents: i ? ['0'] : [] }));
    const request = { items, maxWidth: width, band: { key: '0', items }, pinned: { key: '0', x: width / 2 } };
    for (const layout of [gridRowsEmbedding(request), serialRowsEmbedding(request)]) {
      expect(certified(layout, request)).toBe(true);
      expect(measure(attachSingleBand(layout!, request), '0', width, items).overflow).toBeLessThanOrEqual(overflow);
    }
  });

  it('grid rows overflow the pane only when tiles wider than it would leave the coordinate reach in rows of one', () => {
    const fan = (size: number) => { const items = Array.from({ length: 44 }, (_, i) => ({ key: 'n' + i, width: size, height: size, order: i, parents: i ? ['n0'] : [] }));
      return { items, band: { key: 'n0', items }, maxWidth: 900, tileWidth: size }; };
    const giant = fan(100_000), large = fan(50_000);
    expect(gridEmbedding(giant)!.width).toBeGreaterThan(900);
    expect(certified(gridRowsEmbedding(giant), giant)).toBe(true);
    // Rows of one stay within reach: the pane bounds the rows, as before.
    expect(gridEmbedding(large)!.width).toBeUndefined();
  });

  it('covers every request legacy serial rows certify (corpus sample)', () => {
    const missed: string[] = [];
    for (const fixture of corpus().filter(c => c.nodes.length <= 40)) for (const width of [360, 640]) {
      const request = requestFor({ ...fixture, full: true }, null, width, 48);
      if (!request.items.length) continue;
      const legacy = certified(safeLayout(request), request);
      if (legacy && !certified(gridRowsEmbedding(request), request) && !certified(serialRowsEmbedding(request), request)) missed.push(`${fixture.id}/${width}`);
    }
    expect(missed).toEqual([]);
  }, 60_000);
});

describe('ladder pins', () => {
  const fixture = corpus().find(c => c.id === 'screenshot')!;
  const first = optimizedBand(requestFor(fixture, null, 454, 96));
  const click = requestFor(fixture, 'Saffron', 454, 96);
  const request = { ...click, anchorKey: 'Saffron', history: { signature: first.signature, layout: first.layout, placed: first.placed } };

  it('accept a candidate that keeps the clicked ancestry and reject a cold serial one that moves it', () => {
    const pins = ladderPins(request);
    expect(pins.keys).toContain('Saffron');
    expect(pins.held(first.layout)).toBe(true);
    expect(pins.held(serialRowsEmbedding(request)!)).toBe(false);
  });

  it('pin nothing without compatible history', () => {
    expect(ladderPins(click).held(serialRowsEmbedding(click)!)).toBe(true);
    const foreign = { ...request, history: { ...request.history, signature: 'not a signature' } };
    expect(ladderPins(foreign).keys).toEqual([]);
  });

  it('do not pin an ancestor the committed drawing never had', () => {
    const tile = (key: string, parents: string[], order: number) => ({ key, parents, width: 92, height: 120, order });
    const band = [tile('root', [], 0), tile('A', ['root'], 1), tile('B', ['root'], 2), tile('M', ['A', 'B'], 3)];
    const base = { tileWidth: 92, maxWidth: 600, pinned: { key: 'root', x: 300 }, band: { key: 'root', items: band } };
    const hidden = { ...base, items: band.filter(i => i.key !== 'B') };
    const before = layoutBand(hidden);
    const revealed = { ...base, items: band, anchorKey: 'M', history: { signature: bandHistorySignature(hidden), layout: before, placed: attachSingleBand(before, hidden) } };
    const pins = ladderPins(revealed);
    expect(pins.keys).not.toContain('B');
    expect(pins.keys).toContain('M');
    expect(() => pins.held(layoutBand(revealed))).not.toThrow();
  });

  it('pin resized history where a tile gained its expansion hint, as the ordinary candidates do', () => {
    let tried = 0;
    const rejected: string[] = [];
    for (const fixture of corpus().filter(c => c.nodes.length <= 40)) for (const width of [360, 640]) {
      const cold = requestFor({ ...fixture, full: true }, null, width, 48);
      if (cold.items.length < 3) continue;
      const first = optimizedBand(cold);
      const sources = new Set(cold.items.flatMap(i => i.parents));
      const leaf = cold.items.find(i => !sources.has(i.key) && i.key !== cold.band!.key);
      if (!leaf) continue;
      const items = cold.items.map(i => i.key === leaf.key ? { ...i, height: i.height + TILE.hint } : i);
      const grown = { ...cold, items, band: { ...cold.band!, items }, history: { signature: first.signature, layout: first.layout, placed: first.placed } };
      const fit = historyFit(first.signature, grown);
      if (fit?.kind !== 'grown' || !fit.heights.size) continue;
      tried++;
      const published = layoutBand(grown);
      if (published.decision?.stability && !ladderPins(grown).held(published)) rejected.push(`${fixture.id}/${width}`);
    }
    expect(tried).toBeGreaterThan(10);
    expect(rejected).toEqual([]);
  }, 60_000);

  it('size generations without recursion on a deep chain given child first', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => ({ key: `n${i}`, parents: i ? [`n${i - 1}`] : [], width: 92, height: 120, order: i })).reverse();
    expect(gridEmbedding({ items, maxWidth: 600, tileWidth: 92, band: { key: 'n0', items } })).toBeNull();
  });
});
