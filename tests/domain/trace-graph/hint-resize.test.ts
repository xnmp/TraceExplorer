import { expect, it } from 'vitest';
import { rerouteResizedHistory } from '$lib/domain/trace-graph/hint-resize';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { TILE } from '$lib/domain/trace-graph/metrics';
import type { GraphLayout, LayoutRequest } from '$lib/domain/trace-graph/layout';
import { expectArrivalPinned } from './arrival-contract';

it('encloses split rows and a lowest tile that both descends and gains a hint', () => {
  const nodes = new Map([
    ['root', { key: 'root', x: 0, y: 0, width: 92, height: 100, row: 0, band: 0 }],
    ['upper', { key: 'upper', x: 0, y: 120, width: 92, height: 100, row: 1, band: 0 }],
    ['lower', { key: 'lower', x: 0, y: 240, width: 92, height: 100, row: 2, band: 0 }],
    ['beside', { key: 'beside', x: 200, y: 240, width: 92, height: 100, row: 2, band: 0 }],
  ]);
  const before: GraphLayout = { nodes, junctions: new Map(), routes: [], readingOrder: new Map(),
    orientation: 'down', width: 400, height: 360,
    rows: [{ index: 0, band: 0, keys: ['root'], top: 0, bottom: 100 }, { index: 1, band: 0, keys: ['upper'], top: 120, bottom: 220 },
      { index: 2, band: 0, keys: ['lower', 'beside'], top: 240, bottom: 340 }] };
  const heights = new Map([['upper', 100 + TILE.hint], ['lower', 100 + TILE.hint]]);
  const items = [...nodes.values()].map((node, order) => ({ ...node, height: heights.get(node.key) ?? node.height, parents: [], order }));
  const request: LayoutRequest = { items, tileWidth: 92, maxWidth: 400, band: { key: 'root', items } };
  const after = rerouteResizedHistory(request, before, heights, true);
  expect(after).not.toBeNull();
  expectArrivalPinned(before, after!);
  expect(after!.nodes.get('beside')!.y).toBe(240);
  expect(after!.nodes.get('lower')!.y).toBe(240 + TILE.hint);
  expect(after!.rows[2]).toEqual({ index: 2, band: 0, keys: ['lower', 'beside'], top: 240, bottom: 340 + 2 * TILE.hint });
  expect(after!.height).toBe(360 + 2 * TILE.hint);
  expect(geometryGate(after!, items, 'root', 400)).toBeNull();
});
