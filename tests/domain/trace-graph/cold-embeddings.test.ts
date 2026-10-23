import { describe, expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { wrapCapacity, wrapRow, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { gridEmbedding, gridRowsEmbedding, serialRowsEmbedding } from '$lib/domain/trace-graph/cold-embeddings';
import { ladderPins } from '$lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { safeFanGrid } from '$lib/domain/trace-graph/safe-grid';
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

  it('covers every request the legacy fan grid and serial rows certify (corpus sample)', () => {
    const missed: string[] = [];
    for (const fixture of corpus().filter(c => c.nodes.length <= 40)) for (const width of [360, 640]) {
      const request = requestFor({ ...fixture, full: true }, null, width, 48);
      if (!request.items.length) continue;
      const legacy = certified(safeFanGrid(request), request) || certified(safeLayout(request), request);
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
    const held = ladderPins(request);
    expect(held(first.layout)).toBe(true);
    const serial = serialRowsEmbedding(request)!;
    expect(held(serial)).toBe(false);
  });

  it('pin nothing without compatible history', () => {
    expect(ladderPins(click)(serialRowsEmbedding(click)!)).toBe(true);
    const foreign = { ...request, history: { ...request.history, signature: 'not a signature' } };
    expect(ladderPins(foreign)(serialRowsEmbedding(click)!)).toBe(true);
  });
});
