import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importCommittedRouting, retainedRoutingConflict, routingCoordinate } from '../../../src/lib/domain/trace-graph/routing-problem';
import { solveRoutingComponents } from '../../../src/lib/domain/trace-graph/routing-components';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import { pathCommands } from '../../../src/lib/domain/trace-graph/path-sampling';
import { distanceToSegment } from '../../../src/lib/domain/trace-graph/route-contacts';
import type { GraphLayout, LayoutRequest, PlacedRoute } from '../../../src/lib/domain/trace-graph/layout';

const capture = () => JSON.parse(readFileSync(new URL('./committed-routing-n33.json', import.meta.url), 'utf8'),
  (_k, v) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v) as {
    request: LayoutRequest; retained: GraphLayout; selected: GraphLayout; oldDeparture: PlacedRoute;
  };
const points = (route: PlacedRoute) => pathCommands(route.path)!.map(c => ({ x: c.values.at(-2)!, y: c.values.at(-1)! }));
const routeKey = (a: string, b: string) => JSON.stringify(['incremental', a, b]);
const route = (drawing: GraphLayout, a: string, b: string) => drawing.routes.find(r => r.id === routeKey(a, b))!;
const scene = (drawing: GraphLayout) => ({ id: 'retained', space: 'attached' as const, drawing });
const gate = (drawing: GraphLayout, request: LayoutRequest) => geometryGate(drawing, request.items, request.band!.key, request.maxWidth);

/** This contract starts AFTER a discrete topology has been chosen. It does not
 * claim that production can yet construct this topology or publish its result. */
describe('n33 selected topology with every committed pin retained', () => {
  it('solves the free conflict component without changing any committed native paint', () => {
    const { request, retained, selected } = capture();
    expect(gate(selected, request)).toBe('shared-lane');
    const imported = importCommittedRouting([scene(retained)]);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(JSON.stringify(imported.conflict));
    const p = imported.problem;
    const n8 = route(selected, 'n8', 'n17'), n33 = route(selected, 'n33', 'n38'), n25 = route(selected, 'n25', 'n98');
    const n8Points = points(n8), witness = points(n33)[0];
    const index = n8Points.findIndex((b, i, all) => i > 1 && i + 1 < all.length && b.x === all[i - 1].x
      && all[i - 2].y === all[i - 1].y && all[i + 1].y === b.y && distanceToSegment([all[i - 1], b], witness) < 6);
    expect(index).toBeGreaterThan(1);
    const prefix = points(n25), y = n8Points[index - 1].y;
    const prefixRun = prefix.findIndex((b, i) => i > 0 && b.x === prefix[i - 1].x && b.y >= y && prefix[i - 1].y <= y);
    expect(prefixRun).toBeGreaterThan(0);
    const ids = { a: 'new-n33-track', b: 'new-n25-prefix', c: 'new-n8-run',
      left: routingCoordinate('retained', 'tile', 'n33', 'x'), right: routingCoordinate('retained', 'tile', 'n35', 'x') };
    const free = [{ id: ids.a, preferred: points(n33)[1].x }, { id: ids.b, preferred: prefix[prefixRun].x }, { id: ids.c, preferred: n8Points[index].x }];
    const metric = { ...p.metric, variables: [...p.metric.variables, ...free],
      order: [...p.metric.order.filter(id => id !== ids.right), ...free.map(v => v.id), ids.right], separations: [
        ...free.map(v => ({ id: 'lower:' + v.id, before: ids.left, after: v.id, gap: retained.nodes.get('n33')!.width + 2 })),
        { id: 'parallel-tracks', before: ids.a, after: ids.c, gap: 3 },
        { id: 'prefix-corner', before: ids.b, after: ids.c, gap: 3 },
        ...free.map(v => ({ id: 'upper:' + v.id, before: v.id, after: ids.right, gap: 2 })),
      ] };
    const solved = solveRoutingComponents(metric, [ids.c]);
    expect(solved.ok).toBe(true);
    if (!solved.ok) throw new Error(JSON.stringify(solved.conflict));
    for (const v of p.metric.variables) expect(Object.is(solved.positions.get(v.id), v.pin!.value)).toBe(true);
    expect(free.map(v => solved.positions.get(v.id))).toEqual([174, 175, 178]);
    const raw = [...n8.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
    const path = raw.map((s, i) => i === index - 1 || i === index ? `L${solved.positions.get(ids.c)} ${n8Points[i].y}` : s).join(' ');
    const drawing = { ...selected, routes: selected.routes.map(r => r.id === n8.id ? { ...r, path } : r) };
    expect(retainedRoutingConflict(p, [scene(drawing)])).toBeNull();
    expect(gate(drawing, request)).toBeNull();
    // The missing departure move is independent of the free-run separation.
    const oldDeparture = capture().oldDeparture;
    expect(gate({ ...drawing, routes: drawing.routes.map(r => r.id === oldDeparture.id ? oldDeparture : r) }, request)).toBe('route-contact');
  });
});
