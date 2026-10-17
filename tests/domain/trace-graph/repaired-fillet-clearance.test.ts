import { expect, it } from 'vitest';
import { incrementalTree } from '$lib/domain/trace-graph/band-incremental';
import { roundedStem } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { pathCommands } from '$lib/domain/trace-graph/path-sampling';
import { distanceToSegment } from '$lib/domain/trace-graph/route-contacts';
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedRoute } from '$lib/domain/trace-graph/layout';

it('repairs an occluded departure without letting its fillet approach foreign ink closer than the sharp turn', () => {
  const rectangles = [['root', 200, 0], ['a', 40, 100], ['p', 120, 157],
    ['f', 40, 210], ['b', 180, 250], ['c', 90, 300]] as const;
  const nodes = new Map(rectangles.map(([key, x, y]) => [key, { key, x, y, width: 40, height: 40, row: 1, band: 1 }]));
  const items: LayoutItem[] = rectangles.map(([key], order) => ({ key, order, width: 40, height: 40,
    parents: key === 'b' ? ['a'] : key === 'c' ? ['f'] : [] }));
  const route = (id: string, from: string, to: string, path: string, terminal: boolean, child: string): PlacedRoute => ({
    id, from: { kind: 'node', id: from }, to: { kind: 'node', id: to }, path, terminal, consumers: [{ parent: from, child }],
  });
  const routes = [
    route('bend', 'a', 'a', roundedStem([{ x: 60, y: 140 }, { x: 60, y: 200 }, { x: 200, y: 200 }, { x: 200, y: 220 }]), false, 'b'),
    route('tail', 'a', 'b', 'M200 220L200 242', true, 'b'),
    route('block-right', 'a', 'a', 'M60 140L60 150L163 150L163 190', false, 'b'),
    route('foreign', 'f', 'f', 'M80 230L110 230L110 211L195 211', false, 'c'),
    route('foreign-tail', 'f', 'c', 'M110 230L110 292', true, 'c'),
  ];
  const previous: GraphLayout = { nodes, routes, junctions: new Map(), rows: [], width: 360, height: 360,
    readingOrder: new Map(items.map((item, i) => [item.key, i])), orientation: 'down' };
  const nextItems = [...items, { key: 'new', parents: ['p'], order: 7, width: 40, height: 40 }];
  const request: LayoutRequest = { items: nextItems, maxWidth: 360, tileWidth: 40,
    band: { key: 'root', items: nextItems }, pinned: { key: 'root', x: 220 } };
  expect(geometryGate(previous, items, 'root', 360)).toBeNull();
  const next = incrementalTree(request, previous);
  expect(next).not.toBeNull();
  expect(geometryGate(next!, nextItems, 'root', 360)).toBeNull();
  expect(next!.nodes.has('new')).toBe(true);
  for (const [key, before] of previous.nodes) {
    const after = next!.nodes.get(key)!;
    expect([after.x, after.y, after.width, after.height]).toEqual([before.x, before.y, before.width, before.height]);
  }
  const repaired = next!.routes.find(r => r.id === 'bend')!;
  expect(repaired.path).not.toBe(routes[0].path);

  // Freeing p's bottom port moves the horizontal run from y200 to y206.
  // Its sharp right turn has 5px clearance to the foreign segment at y211.
  // Retaining radius6 would reduce this to 4.586px, which the ordinary 3px gate accepts.
  const commands = pathCommands(repaired.path)!;
  let index = commands.length - 1;
  while (index >= 0 && commands[index].kind !== 'C') index--;
  expect(index).toBeGreaterThan(0);
  const start = commands[index - 1].values.slice(-2), values = commands[index].values;
  const clearances = Array.from({ length: 101 }, (_, step) => {
    const t = step / 100, u = 1 - t;
    const point = { x: u ** 3 * start[0] + 3 * u ** 2 * t * values[0] + 3 * u * t ** 2 * values[2] + t ** 3 * values[4],
      y: u ** 3 * start[1] + 3 * u ** 2 * t * values[1] + 3 * u * t ** 2 * values[3] + t ** 3 * values[5] };
    return distanceToSegment([{ x: 110, y: 211 }, { x: 195, y: 211 }], point);
  });
  expect(Math.min(...clearances)).toBeGreaterThanOrEqual(5 - 1e-6);
  expect(Math.min(...clearances)).toBeLessThan(5.001);
});
