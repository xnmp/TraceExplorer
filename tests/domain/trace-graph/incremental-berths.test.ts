import { expect, it } from 'vitest';
import { denseCorpus, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph, type GraphLayout, type LayoutRequest, type PlacedNode } from '$lib/domain/trace-graph/layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { incrementalBudget, incrementalTree } from '$lib/domain/trace-graph/band-incremental';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

const rectangle = (node: PlacedNode) => [node.x, node.y, node.width, node.height];

function extend(request: LayoutRequest, previous: GraphLayout): GraphLayout {
  const result = incrementalTree(request, previous);
  expect(result, 'a clear route around foreign ports and corners exists').not.toBeNull();
  const placed = attachSingleBand(result!, request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
  for (const [key, node] of previous.nodes) expect(rectangle(placed.nodes.get(key)!), key).toEqual(rectangle(node));
  expect(placed.width).toBeLessThanOrEqual(request.maxWidth);
  return placed;
}

it('routes a three-parent arrival around foreign berths without moving retained tiles', () => {
  const fixture = { ...denseCorpus().find(c => c.id === 'dense-f4-40-20442')!, full: false };
  const base = requestFor(fixture, null, 900, 96), expanded = requestFor(fixture, 'n15', 900, 96);
  const keys = new Set([...base.items.map(n => n.key), 'n21']);
  const first = { ...expanded, items: expanded.items.filter(n => keys.has(n.key)) };
  const before = extend(first, attachSingleBand(layoutGraph(base), base));
  keys.add('n17');
  extend({ ...expanded, items: expanded.items.filter(n => keys.has(n.key)) }, before);
});

it('routes a four-parent arrival past remote corners rather than accepting the first invalid grid path', () => {
  const fixture = { ...denseCorpus().find(c => c.id === 'dense-f10-40-21042')!, full: false };
  const base = requestFor(fixture, null, 900, 96), expanded = requestFor(fixture, 'n30', 900, 96);
  extend(expanded, attachSingleBand(layoutGraph(base), base));
});

it('withholds a route when its shared search budget is exhausted', () => {
  const fixture = { ...denseCorpus().find(c => c.id === 'dense-f10-40-21042')!, full: false };
  const base = requestFor(fixture, null, 900, 96), expanded = requestFor(fixture, 'n30', 900, 96);
  const previous = attachSingleBand(layoutGraph(base), base);
  const before = structuredClone(previous);
  const budget = { ...incrementalBudget(), fallback: 5000, second: 5000 };
  expect(incrementalTree(expanded, previous, budget)).toBeNull();
  expect(previous).toEqual(before);
});
