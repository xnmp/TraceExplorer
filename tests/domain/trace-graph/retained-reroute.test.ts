import { expect, it } from 'vitest';
import { layoutGraph, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { rerouteRetainedRoute } from '$lib/domain/trace-graph/band-incremental';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { TILE } from '$lib/domain/trace-graph/metrics';

const requestFor = (parents: readonly (readonly string[])[]): LayoutRequest => {
  const keys = ['root', 'a', 'b', 'c'];
  const items = parents.map((inputs, order) => ({ key: keys[order], parents: inputs, order, width: 92, height: 100 }));
  return { items, maxWidth: 640, tileWidth: 92, band: { key: 'root', items } };
};

function expectOnlyWireChanged(before: GraphLayout, after: GraphLayout, routeId: string): void {
  expect(after.nodes).toEqual(before.nodes);
  expect(after.junctions).toEqual(before.junctions);
  expect(after.routes.map(({ path, ...route }) => route)).toEqual(before.routes.map(({ path, ...route }) => route));
  expect(after.routes.filter(route => route.id !== routeId)).toEqual(before.routes.filter(route => route.id !== routeId));
}

it('reconnects a retained terminal after its target gains a hint without moving any tile', () => {
  const request = requestFor([[], ['root'], ['a']]);
  const before = layoutGraph(request);
  expect(geometryGate(before, request.items, 'root', request.maxWidth)).toBeNull();
  const items = request.items.map(item => item.key === 'b' ? { ...item, height: item.height + TILE.hint } : item);
  const next = { ...request, items, band: { key: 'root', items } };
  const draft = { ...before, height: before.height + TILE.hint,
    nodes: new Map([...before.nodes].map(([key, node]) => [key, key === 'b' ? { ...node, height: node.height + TILE.hint } : node])) };
  const route = draft.routes.find(route => route.from.id === 'a' && route.to.id === 'b')!;
  expect(geometryGate(draft, items, 'root', request.maxWidth)).not.toBeNull();
  const after = rerouteRetainedRoute(next, draft, route.id);
  expect(after).not.toBeNull();
  expectOnlyWireChanged(draft, after!, route.id);
  expect(geometryGate(after!, items, 'root', request.maxWidth)).toBeNull();
});

it.each(['a', 'b'])('reconnects retained merge input %s while preserving valid junction convergence', parent => {
  const request = requestFor([[], ['root'], ['root'], ['a', 'b']]);
  const before = layoutGraph(request);
  expect(geometryGate(before, request.items, 'root', request.maxWidth)).toBeNull();
  const route = before.routes.find(route => route.from.id === parent && route.to.kind === 'junction')!;
  expect(route).toBeDefined();
  expect(route.path).toContain('C');
  const after = rerouteRetainedRoute(request, before, route.id);
  expect(after).not.toBeNull();
  expectOnlyWireChanged(before, after!, route.id);
  expect(after!.routes.find(candidate => candidate.id === route.id)!.path).toContain('C');
  expect(geometryGate(after!, request.items, 'root', request.maxWidth)).toBeNull();
});
