import { expect, it } from 'vitest';
import { repairRouteContacts } from '$lib/domain/trace-graph/repair-route-contacts';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, PlacedRoute } from '$lib/domain/trace-graph/layout';

it.each([3.25, 3.9, 4.4])('keeps unrelated connectors out of the painted junction at %s px', distance => {
  const nodes = [
    { key: 'a', x: 20, y: 0 }, { key: 'b', x: 140, y: 0 },
    { key: 'c', x: 70, y: 200 }, { key: 'd', x: 0, y: 30 }, { key: 'e', x: 110, y: 150 },
  ].map((n, i) => ({ ...n, width: 20, height: 20, row: i, band: i }));
  const items = nodes.map((n, order) => ({ ...n, order, parents: n.key === 'c' ? ['a', 'b'] : n.key === 'e' ? ['d'] : [] }));
  const routes: PlacedRoute[] = [
    { id: 'a-j', from: { kind: 'node', id: 'a' }, to: { kind: 'junction', id: 'j' }, terminal: false, consumers: [{ parent: 'a', child: 'c' }], path: 'M30 20 L30 70 L80 70 L80 100' },
    { id: 'b-j', from: { kind: 'node', id: 'b' }, to: { kind: 'junction', id: 'j' }, terminal: false, consumers: [{ parent: 'b', child: 'c' }], path: 'M150 20 L150 100 L80 100' },
    { id: 'j-c', from: { kind: 'junction', id: 'j' }, to: { kind: 'node', id: 'c' }, terminal: true, consumers: [{ parent: 'a', child: 'c' }, { parent: 'b', child: 'c' }], path: 'M80 100 L80 192' },
    { id: 'd-e', from: { kind: 'node', id: 'd' }, to: { kind: 'node', id: 'e' }, terminal: true, consumers: [{ parent: 'd', child: 'e' }], path: `M10 50 L10 ${100 + distance} L120 ${100 + distance} L120 142` },
  ];
  const layout: GraphLayout = { nodes: new Map(nodes.map(n => [n.key, n])), junctions: new Map([['j', { id: 'j', x: 80, y: 100, parents: ['a', 'b'] }]]),
    routes, rows: [], readingOrder: new Map(), width: 200, height: 250, orientation: 'down' };
  // Certification must protect the outline and every connector styling state.
  // d-e crosses j-c just below the junction, without declaring that join.
  expect(geometryGate(layout, items, 'a', 200)).not.toBeNull();
  const repaired = repairRouteContacts(layout, { items, maxWidth: 200, band: { key: 'a', items } });
  expect(repaired).not.toBeNull();
  expect(geometryGate(repaired!, items, 'a', 200)).toBeNull();
  expect(repaired!.nodes).toEqual(layout.nodes);
  expect(repaired!.junctions).toEqual(layout.junctions);
});
