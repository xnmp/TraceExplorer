/** Retained-track port repair inside the constrained metric (the counterpart of
 * legacy T24): a free retained core that occludes a newly active source port
 * gives way through one more hard separation, never by editing native ink. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockedSourcePorts, captureFramedIncrementalRouting, clearIncrementalPorts, projectCommittedRouting,
  type IncrementalRoutingSeed } from '$lib/domain/trace-graph/incremental-routing';
import { bindRoutingFragmentTopology } from '$lib/domain/trace-graph/routing-fragments';
import { AUTOMATIC_ROUTING_WORK, automaticIncrementalBudget, constrainedBandInsertion } from '$lib/domain/trace-graph/band-incremental';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { segments } from '$lib/domain/trace-graph/layout-quality';
import { pathCommands } from '$lib/domain/trace-graph/path-sampling';
import { LANE_SEPARATION, PORT_BERTH } from '$lib/domain/trace-graph/metrics';
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute } from '$lib/domain/trace-graph/layout';

const tile = (key: string, x: number, y: number): PlacedNode => ({ key, x, y, width: 40, height: 40, row: 0, band: 0 });
const route = (from: string, to: string, path: string): PlacedRoute => ({ id: `${from}-${to}`, from: { kind: 'node', id: from },
  to: { kind: 'node', id: to }, terminal: true, consumers: [{ parent: from, child: to }], path });
const item = (key: string, order: number, parents: string[]) => ({ key, width: 40, height: 40, order, parents });

/** Cover `a` feeds `p` and `b`; the a→b core at y=143 runs 3 px below p's
 * bottom port (120, 140). A new child `c` of `p` activates that port. */
const scene = (core = 143, extra: readonly PlacedRoute[] = [], nodes: readonly PlacedNode[] = []) => {
  const previous: GraphLayout = { orientation: 'down', width: 300, height: 340,
    nodes: new Map([tile('a', 0, 0), tile('p', 100, 100), tile('b', 200, 300), ...nodes].map(n => [n.key, n])), junctions: new Map(),
    routes: [route('a', 'p', 'M20 40 L20 50 L120 50 L120 92'), route('a', 'b', `M20 40 L20 60 L60 60 L60 ${core} L220 ${core} L220 292`), ...extra],
    rows: [], readingOrder: new Map([['a', 0], ['p', 1], ['b', 2]]) };
  const items = [item('a', 0, []), item('p', 1, ['a']), item('b', 2, ['a']), ...nodes.map((n, i) => item(n.key, 3 + i, ['a'])), item('c', 9, ['p'])];
  const request: LayoutRequest = { items, maxWidth: 300, tileWidth: 40, orientation: 'down', band: { key: 'a', items } };
  return { previous, request };
};
const framed = (request: LayoutRequest, previous: GraphLayout): IncrementalRoutingSeed => {
  const seed = captureFramedIncrementalRouting(request, previous, previous);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  return seed;
};
const nearest = (drawing: GraphLayout, port: { x: number; y: number }, owner: string) => Math.min(...drawing.routes
  .filter(r => r.from.id !== owner).flatMap(r => segments(r.path)).map(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((port.x - a.x) * dx + (port.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(port.x - a.x - t * dx, port.y - a.y - t * dy);
  }));

describe('blocked source ports', () => {
  it('names only newly active ports that another source occludes', () => {
    const { request, previous } = scene();
    expect(blockedSourcePorts(request, previous)).toEqual([{ owner: 'p', side: 'bottom', x: 120, y: 140 }]);
  });

  it('ignores the port owner\'s own routes, clear berths and requests with nothing new', () => {
    const { request, previous } = scene();
    const own = { ...previous, routes: previous.routes.map(r => r.id === 'a-b' ? { ...r, from: { kind: 'node' as const, id: 'p' } } : r) };
    expect(blockedSourcePorts(request, own)).toEqual([]);
    expect(blockedSourcePorts(request, scene(140 + PORT_BERTH).previous)).toEqual([]);
    expect(blockedSourcePorts({ ...request, items: request.items.filter(n => n.key !== 'c') }, previous)).toEqual([]);
  });

  it('gives the band cover only its bottom port', () => {
    const { request, previous } = scene();
    const child = { ...request, items: [...request.items, item('d', 10, ['a'])] };
    const blocker = { ...previous, routes: [...previous.routes, route('p', 'b', 'M120 140 L120 160 L42 160 L42 18 L60 18 L60 292')] };
    expect(blockedSourcePorts(child, blocker).filter(port => port.owner === 'a')).toEqual([]);
  });
});

describe('retained port clearance', () => {
  it('moves the occluding free core to the port berth and nothing else', () => {
    const { request, previous } = scene(), before = structuredClone({ request, previous });
    const seed = framed(request, previous), ports = blockedSourcePorts(request, previous);
    const result = clearIncrementalPorts(request, seed, ports);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    expect(result.drawing.routes.map(r => r.path)).toEqual(['M20 40 L20 50 L120 50 L120 92', 'M20 40 L20 60 L60 60 L60 146 L220 146 L220 292']);
    expect(result.drawing.nodes).toEqual(previous.nodes);
    expect(nearest(result.drawing, ports[0], 'p')).toBeGreaterThanOrEqual(PORT_BERTH);
    expect(bindRoutingFragmentTopology(seed.fragments!, result.drawing, undefined, true).ok).toBe(true);
    expect({ request, previous }).toEqual(before);
    expect(clearIncrementalPorts(structuredClone(request), framed(structuredClone(request), structuredClone(previous)), ports)).toEqual(result);
  });

  it('pushes a parallel retained core in its drawn order, never past it', () => {
    const { request, previous } = scene(143, [route('p', 'q', 'M140 120 L142 120 L150 120 L150 147 L170 147 L170 292')], [tile('q', 150, 300)]);
    const result = clearIncrementalPorts(request, framed(request, previous), blockedSourcePorts(request, previous));
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    const y = (id: string) => segments(result.drawing.routes.find(r => r.id === id)!.path).find(([a, b]) => a.y === b.y && a.y > 130)![0].y;
    expect(y('a-b')).toBe(146);
    expect(y('p-q')).toBe(146 + LANE_SEPARATION);
  });

  it('needs a fragment authority: whole-route captures keep every retained byte', () => {
    const { request, previous } = scene();
    const seed = { ...framed(request, previous), fragments: undefined };
    const result = clearIncrementalPorts(request, seed, blockedSourcePorts(request, previous));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.reason).toBe('unsupported-input');
  });
});

describe('constrained insertion with retained port repair', () => {
  /** Tour input 62 (random-dag-40, 1400 px): two retained cores pass 2 and 5 px
   * from n21's right port, which new n22 and n26 need. Legacy reached T24 here;
   * before the repair the constrained search exhausted the API allowance. */
  const tour62 = () => JSON.parse(readFileSync(new URL('./fixtures/routing-adoption/port-repair-tour62.json', import.meta.url), 'utf8'),
    (_k, v) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v) as { request: LayoutRequest; previous: GraphLayout };

  it('certifies the T24 input with every retained rectangle and native constant exact', () => {
    const { request, previous } = tour62(), before = structuredClone({ request, previous });
    const blocked = blockedSourcePorts(request, previous);
    expect(blocked).toEqual([{ owner: 'n21', side: 'right', x: 164, y: 2082 }]);
    const result = constrainedBandInsertion(request, previous, () => automaticIncrementalBudget(), AUTOMATIC_ROUTING_WORK);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict.constraints.slice(0, 3))).toBe(true);
    if (!result.ok) return;
    const published = attachSingleBand(structuredClone(result.drawing), request);
    expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
    for (const { key } of request.items) if (previous.nodes.has(key)) expect(published.nodes.get(key)).toEqual(previous.nodes.get(key));
    const projected = projectCommittedRouting(previous, request);
    const seed = captureFramedIncrementalRouting(request, previous, projected, []);
    if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
    expect(bindRoutingFragmentTopology(seed.fragments!, published, undefined, true).ok).toBe(true);
    for (const port of blocked) {
      expect(nearest(previous, port, port.owner)).toBeLessThan(PORT_BERTH);
      expect(nearest(published, port, port.owner)).toBeGreaterThanOrEqual(PORT_BERTH);
    }
    expect({ request, previous }).toEqual(before);
  }, 60_000);
});

describe('departure stubs', () => {
  /** Cover `a` feeds `p` below it and `b` through a 4 px stub off its right
   * port (40, 20), then down a core at x=44. That core passes 4 px from p's
   * right port (40, 100), which a new child `c` of `p` activates. */
  const stubScene = () => {
    const previous: GraphLayout = { orientation: 'down', width: 300, height: 340,
      nodes: new Map([tile('a', 0, 0), tile('p', 0, 80), tile('b', 200, 300)].map(n => [n.key, n])), junctions: new Map(),
      routes: [route('a', 'p', 'M20 40 L20 72'), route('a', 'b', 'M40 20 L44 20 L44 143 L220 143 L220 292')],
      rows: [], readingOrder: new Map([['a', 0], ['p', 1], ['b', 2]]) };
    const items = [item('a', 0, []), item('p', 1, ['a']), item('b', 2, ['a']), item('c', 9, ['p'])];
    const request: LayoutRequest = { items, maxWidth: 300, tileWidth: 40, orientation: 'down', band: { key: 'a', items } };
    return { previous, request };
  };
  const stubSeed = (request: LayoutRequest, previous: GraphLayout, departureStubs: boolean) => {
    const seed = captureFramedIncrementalRouting(request, previous, previous, [], () => {}, { departureStubs });
    if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
    return seed;
  };
  const points = (drawing: GraphLayout, id: string) => pathCommands(drawing.routes.find(r => r.id === id)!.path)!.map(c => c.values.slice(-2));

  it('lengthens the stub so the core leaving it clears the port, keeping its start and line', () => {
    const { request, previous } = stubScene(), ports = blockedSourcePorts(request, previous);
    expect(ports).toEqual([{ owner: 'p', side: 'right', x: 40, y: 100 }]);
    const seed = stubSeed(request, previous, true), result = clearIncrementalPorts(request, seed, ports);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    const [start, stubEnd, coreEnd] = points(result.drawing, 'a-b');
    expect(start).toEqual([40, 20]);
    expect(stubEnd[1]).toBe(20);
    expect(stubEnd[0]).toBeGreaterThanOrEqual(40 + PORT_BERTH);
    expect(coreEnd[0]).toBe(stubEnd[0]);
    expect(nearest(result.drawing, ports[0], 'p')).toBeGreaterThanOrEqual(PORT_BERTH);
    expect(result.drawing.nodes).toEqual(previous.nodes);
    expect(bindRoutingFragmentTopology(seed.fragments!, result.drawing, undefined, true).ok).toBe(true);
  });

  it('keeps the whole prefix exact without the option, so that port stays blocked', () => {
    const { request, previous } = stubScene();
    const result = clearIncrementalPorts(request, stubSeed(request, previous, false), blockedSourcePorts(request, previous));
    expect(!result.ok || nearest(result.drawing, { x: 40, y: 100 }, 'p') < PORT_BERTH).toBe(true);
  });

  it('never shortens a stub or moves it off its line', () => {
    const { request, previous } = stubScene(), seed = stubSeed(request, previous, true);
    const withPath = (path: string): GraphLayout => ({ ...previous, routes: previous.routes.map(r => r.id === 'a-b' ? { ...r, path } : r) });
    expect(bindRoutingFragmentTopology(seed.fragments!, withPath('M40 20 L50 20 L50 143 L220 143 L220 292'), undefined, true).ok).toBe(true);
    expect(bindRoutingFragmentTopology(seed.fragments!, withPath('M40 20 L42 20 L42 143 L220 143 L220 292'), undefined, true).ok).toBe(false);
    expect(bindRoutingFragmentTopology(seed.fragments!, withPath('M40 20 L44 22 L44 143 L220 143 L220 292'), undefined, true).ok).toBe(false);
  });
});
