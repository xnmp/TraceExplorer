import { expect, it } from 'vitest';
import { captureFramedIncrementalRouting, captureIncrementalRouting, routeCommittedIncremental, solveIncrementalTopology } from '$lib/domain/trace-graph/incremental-routing';
import { bindRoutingFragmentTopology, captureRoutingFragments } from '$lib/domain/trace-graph/routing-fragments';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { routingCoordinate } from '$lib/domain/trace-graph/routing-problem';
import { pathCommands } from '$lib/domain/trace-graph/path-sampling';
import { retainedHardObstacles } from '$lib/domain/trace-graph/retained-hard-obstacles';
import { chargedNativeTileClearance } from '$lib/domain/trace-graph/native-route-clearance';
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute } from '$lib/domain/trace-graph/layout';

const curve = 'C20 75 25 80 30 80 ';
const fixture = () => {
  const tile = (key: string, x: number, y: number, width = 40, height = 40): PlacedNode => ({ key, x, y, width, height, row: 0, band: 0 });
  const a = tile('a', 0, 0), b = tile('b', 160, 200), c = tile('c', 95, 100, 20, 20);
  const old: PlacedRoute = { id: 'ab', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'b' }, terminal: true,
    consumers: [{ parent: 'a', child: 'b' }], path: `M20 40 L20 70 ${curve}L100 80 L100 150 L180 150 L180 192` };
  const previous: GraphLayout = { orientation: 'down', width: 220, height: 240,
    nodes: new Map([[a.key, a], [b.key, b]]), junctions: new Map(), routes: [old], rows: [], readingOrder: new Map([['a', 0], ['b', 1]]) };
  const items = [{ key: 'a', width: 40, height: 40, order: 0, parents: [] },
    { key: 'b', width: 40, height: 40, order: 1, parents: ['a'] }, { key: 'c', width: 20, height: 20, order: 2, parents: ['a'] }];
  const request: LayoutRequest = { items, maxWidth: 220, tileWidth: 40, orientation: 'down', band: { key: 'a', items } };
  const topology: GraphLayout = { ...previous, nodes: new Map([...previous.nodes, ['c', c]]), routes: [old,
    { id: 'ac', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'c' }, terminal: true,
      consumers: [{ parent: 'a', child: 'c' }], path: `M20 40 L20 70 ${curve}L105 80 L105 92` }],
    readingOrder: new Map([['a', 0], ['b', 1], ['c', 2]]) };
  return { previous, topology, request };
};
const capture = (request: LayoutRequest, previous: GraphLayout) => {
  const seed = captureFramedIncrementalRouting(request, previous, previous);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  return seed;
};

const terminalFixture = (base = 16) => {
  const a: PlacedNode = { key: 'a', x: 35, y: 57, width: 40, height: 40, row: 0, band: 0 };
  const b: PlacedNode = { key: 'b', x: base + 8, y: 260.5, width: 40, height: 40, row: 1, band: 0 };
  const route: PlacedRoute = { id: 'ab', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'b' }, terminal: true,
    consumers: [{ parent: 'a', child: 'b' }], path: `M55 97 L55 99 L8 99 L8 280.5 L${base} 280.5` };
  const drawing: GraphLayout = { orientation: 'down', width: 220, height: 320.5, nodes: new Map([['a', a], ['b', b]]),
    junctions: new Map(), routes: [route], rows: [], readingOrder: new Map([['a', 0], ['b', 1]]) };
  const items = [{ key: 'a', width: 40, height: 40, order: 0, parents: [] },
    { key: 'b', width: 40, height: 40, order: 1, parents: ['a'] }];
  const request: LayoutRequest = { items, maxWidth: 220, tileWidth: 40, orientation: 'down', band: { key: 'a', items } };
  return { route, drawing, items, request };
};

it('keeps an authored eight-pixel terminal shaft outside the free-core pane bound', () => {
  const { drawing, route, request, items } = terminalFixture();
  expect(geometryGate(drawing, items, 'a', 220)).toBeNull();
  const seed = capture(request, drawing);
  const result = solveIncrementalTopology(request, seed, drawing, 64_000_000, { left: 9.15, right: 210.85 });
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (result.ok) {
    expect(result.drawing.routes[0].path).toBe(route.path);
    expect(geometryGate(result.drawing, items, 'a', 220)).toBeNull();
  }
});

it('moves the far end of a longer terminal core while preserving the complete native shaft', () => {
  const { drawing, route, request, items } = terminalFixture(26);
  const seed = capture(request, drawing), original = structuredClone(drawing);
  const result = solveIncrementalTopology(request, seed, drawing, 64_000_000, { left: 9.15, right: 210.85 });
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (result.ok) {
    expect(result.drawing.routes[0].path).not.toBe(route.path);
    expect(result.drawing.routes[0].path).toContain('L9.15 280.5 L26 280.5');
    expect(bindRoutingFragmentTopology(seed.fragments!, result.drawing, undefined, true).ok).toBe(true);
    expect(geometryGate(result.drawing, items, 'a', 220)).toBeNull();
  }
  expect(solveIncrementalTopology(request, seed, drawing, 64_000_000, { left: 18.1, right: 201.9 }).ok).toBe(false);
  expect(drawing).toEqual(original);
});

it.each([8.000000000001, 8.01])('retains native terminal ink accepted by the existing gate at x%s', x => {
  const { drawing, request, items } = terminalFixture();
  const previous = { ...drawing, routes: drawing.routes.map(route => ({ ...route,
    path: route.path.replace('L8 280.5', `L${x} 280.5`) })) };
  expect(geometryGate(previous, items, 'a', 220)).toBeNull();
  const seed = capture(request, previous), original = structuredClone(previous);
  const result = solveIncrementalTopology(request, seed, previous);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (result.ok) expect(result.drawing.routes[0].path).toBe(previous.routes[0].path);
  expect(previous).toEqual(original);
});

it.each([false, true])('propagates terminal endpoint aliases across a zero-length L (authored %s)', authored => {
  const { drawing, request, items } = terminalFixture();
  const repeated = { ...drawing, routes: drawing.routes.map(route => ({ ...route,
    path: route.path.replace('L16 280.5', 'L8 280.5 L16 280.5') })) };
  expect(geometryGate(repeated, items, 'a', 220)).toBeNull();
  const seed = capture(request, authored ? repeated : drawing), original = structuredClone(repeated);
  const result = solveIncrementalTopology(request, seed, repeated, 64_000_000, { left: 9.15, right: 220 });
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (result.ok) expect(result.drawing.routes[0].path).toBe(repeated.routes[0].path);
  expect(repeated).toEqual(original);
});

it('moves an existing straight core around an arrival while retaining native paint and real ports', () => {
  const input = fixture(), before = structuredClone(input), { request, previous, topology } = input;
  expect(geometryGate(previous, request.items.slice(0, 2), 'a', 220)).toBeNull();
  expect(geometryGate(topology, request.items, 'a', 220)).toBe('route-through-tile');
  const seed = capture(request, previous), result = solveIncrementalTopology(request, seed, topology);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (!result.ok) return;
  expect(geometryGate(result.drawing, request.items, 'a', 220)).toBeNull();
  expect(result.drawing.routes[0].path).not.toBe(previous.routes[0].path);
  expect(result.drawing.routes[0].path).toContain(curve);
  expect(result.drawing.routes[0].path.startsWith('M20 40 L20 70 ')).toBe(true);
  expect(result.drawing.routes[0].path.endsWith('L180 150 L180 192')).toBe(true);
  for (const [key, node] of previous.nodes) expect(result.drawing.nodes.get(key)).toEqual(node);
  expect(bindRoutingFragmentTopology(seed.fragments!, result.drawing, undefined, true).ok).toBe(true);
  expect(result.solved).toBeGreaterThan(0);
  expect(input).toEqual(before);
});

it('constructs only protected native obstacles while leaving a conflicting old straight core free', () => {
  const { request, previous, topology } = fixture(), seed = capture(request, previous);
  const original = structuredClone(seed.fragments), newTile = topology.nodes.get('c')!;
  const hard = retainedHardObstacles(seed.fragments!, () => {});
  expect(hard.ok).toBe(true);
  if (!hard.ok) return;
  const routes = [...hard.routes.values()].flat();
  const obstacles = { ...previous, nodes: new Map([['c', newTile]]), routes };
  expect(chargedNativeTileClearance({ ...obstacles, routes: previous.routes }, () => {}).ok).toBe(false);
  expect(chargedNativeTileClearance(obstacles, () => {}).ok).toBe(true);
  expect(routes.some(route => route.path.includes(curve))).toBe(true);
  expect(routes.some(route => route.path === 'M180 184 L180 192' && route.terminal)).toBe(true);
  expect(routes.some(route => route.path === 'M20 40 L20 46')).toBe(true);
  for (const route of routes) {
    expect(route.from).toEqual(previous.routes[0].from);
    expect(route.to).toEqual(previous.routes[0].to);
    expect(route.consumers).toEqual(previous.routes[0].consumers);
  }
  expect(seed.fragments).toEqual(original);
  const exhausted = { exhausted: true };
  let caught: unknown;
  try { retainedHardObstacles(seed.fragments!, () => { throw exhausted; }); } catch (error) { caught = error; }
  expect(caught).toBe(exhausted);
});

it('keeps whole-route retention as the default', () => {
  const { request, previous, topology } = fixture(), seed = captureIncrementalRouting(request, previous);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  expect(solveIncrementalTopology(request, seed, topology).ok).toBe(false);
});

it('derives its frame inside the constructor ledger and captures the actual committed source', () => {
  const { request, previous, topology } = fixture();
  const result = routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined,
    source => ({ preferred: source, frames: [] }));
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  const before = structuredClone(previous);
  const substituted = routeCommittedIncremental(request, previous, drawing => drawing, 64_000_000, undefined,
    source => ({ preferred: { ...source, nodes: new Map([...source.nodes].map(([key, node]) =>
      [key, key === 'a' ? { ...node, x: node.x + 10 } : node])) }, frames: [] }));
  expect(substituted.ok).toBe(false);
  expect(previous).toEqual(before);
  let prepared = false;
  expect(routeCommittedIncremental(request, previous, () => topology, 0, undefined, source => {
    prepared = true; return { preferred: source, frames: [] };
  })).toMatchObject({ ok: false, work: 0, conflict: { reason: 'budget-exhaustion' } });
  expect(prepared).toBe(false);
});

it('keeps a retained C identity when a free L command is inserted before it', () => {
  const { request, previous, topology } = fixture(), seed = capture(request, previous);
  const changed = { ...topology, routes: topology.routes.map(route => route.id === 'ab'
    ? { ...route, path: route.path.replace('L20 70 ', 'L20 60 L20 70 ') } : route) };
  const result = solveIncrementalTopology(request, seed, changed);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (result.ok) {
    expect(result.drawing.routes[0].path).toContain(curve);
    expect(geometryGate(result.drawing, request.items, 'a', 220)).toBeNull();
  }
});

it('exposes selected construction obstacles without allowing them to replace captured pins', () => {
  const frame = (source: GraphLayout) => ({ preferred: source, frames: [] });
  const run = (mutate: boolean) => {
    const { request, previous, topology } = fixture(), before = structuredClone(previous);
    const result = routeCommittedIncremental(request, previous, (_drawing, _charge, _choose, _reserve, fragments) => {
      expect(fragments?.fragments.some(fragment => fragment.native.length === 4)).toBe(true);
      // Construction reads pins through a lookup only, and owns copies of the rest.
      expect(Object.keys(fragments!.pins)).toEqual(['get']);
      if (mutate) {
        // An adapter that edits its view must not alter the independent capture
        // used by the final metric and retained-paint check.
        for (const node of fragments!.preferred.drawing.nodes.values()) (node as { x: number }).x += 10;
        (fragments!.fragments as unknown[]).length = 0;
        (fragments!.intervals as unknown[]).length = 0;
        (fragments!.source.plan.paths as unknown[]).length = 0;
      }
      return topology;
    }, 64_000_000, undefined, frame);
    expect(previous).toEqual(before);
    return result;
  };
  const clean = run(false), mutated = run(true);
  expect(clean.ok, JSON.stringify(clean.ok || clean.conflict)).toBe(true);
  expect(mutated).toEqual(clean);
});

for (const framed of [false, true]) {
  it(`gives every ${framed ? 'framed' : 'strict'} candidate an unmutated drawing after a rejected candidate edits its own`, () => {
    const run = (mutate: boolean) => {
      const { request, previous, topology } = fixture();
      const seen: string[] = [];
      const result = routeCommittedIncremental(request, previous, (drawing, _charge, choose) => {
        seen.push(JSON.stringify([[...drawing.nodes.keys()], drawing.routes.map(route => route.path)]));
        if (choose('family', ['first', 'second']) === 'first') {
          if (mutate) {
            drawing.nodes.set('zzz', { key: 'zzz', x: 1, y: 1, width: 1, height: 1, row: 0, band: 0 });
            (drawing.routes as PlacedRoute[])[0] = { ...drawing.routes[0], path: 'M0 0 L1 1' };
          }
          return { reason: 'topology-conflict', constraints: ['first family'] };
        }
        return topology;
      }, 64_000_000, undefined, framed ? source => ({ preferred: source, frames: [] }) : undefined);
      return { seen, result };
    };
    const clean = run(false), mutated = run(true);
    expect(mutated.seen).toHaveLength(2);
    expect(mutated.seen[1]).toBe(mutated.seen[0]);
    expect(mutated.result).toEqual(clean.result);
  });
}

it('captures once per attempt: a later embedding candidate builds on the same captured authority', () => {
  const { request, previous, topology } = fixture();
  let prepared = 0, built = 0;
  const result = routeCommittedIncremental(request, previous, (_drawing, _charge, choose) => {
    built++;
    return choose('family', ['first', 'second']) === 'first' ? { reason: 'topology-conflict', constraints: ['first family'] } : topology;
  }, 64_000_000, undefined, source => { prepared++; return { preferred: source, frames: [] }; });
  expect(result.ok, JSON.stringify(result.ok || result.conflict)).toBe(true);
  expect(built).toBe(2);
  expect(prepared).toBe(1);
});

it('captures again for every candidate when the frame policy itself chooses', () => {
  const { request, previous, topology } = fixture();
  let prepared = 0, frame = '';
  const result = routeCommittedIncremental(request, previous, () => frame === 'first'
    ? { reason: 'topology-conflict', constraints: ['first frame'] } : topology,
  64_000_000, undefined, (source, _charge, choose) => {
    prepared++; frame = choose('frame', ['first', 'second']);
    return { preferred: source, frames: [] };
  });
  expect(result.ok, JSON.stringify(result.ok || result.conflict)).toBe(true);
  expect(prepared).toBe(2);
});

it('withholds a solved band when actual publication admission finds a conflict', () => {
  const { request, previous, topology } = fixture();
  let checked = false;
  const result = routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined,
    source => ({ preferred: source, frames: [] }), drawing => {
      checked = true;
      expect(geometryGate(drawing, request.items, 'a', 220)).toBeNull();
      expect(drawing.routes[0].path).toContain(curve);
      return { reason: 'metric-conflict', constraints: ['actual packed retained pin'] };
    });
  expect(checked).toBe(true);
  expect(result).toMatchObject({ ok: false, conflict: { reason: 'metric-conflict', constraints: ['actual packed retained pin'] } });
});

it('charges actual publication checks to the same bounded request and protects the accepted drawing', () => {
  const { request, previous, topology } = fixture(), original = structuredClone(previous);
  const prepare = (source: GraphLayout) => ({ preferred: source, frames: [] });
  const exhausted = routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined, prepare,
    (_drawing, charge) => { charge(64_000_000, 'actual folder admission'); return null; });
  expect(exhausted).toMatchObject({ ok: false, conflict: { reason: 'budget-exhaustion' } });
  expect(exhausted.work).toBeLessThanOrEqual(64_000_000);
  const accepted = routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined, prepare,
    drawing => { (drawing.nodes as Map<string, unknown>).clear(); return null; });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.drawing.nodes.size).toBe(request.items.length);
  expect(previous).toEqual(original);
});

it('declines a malformed publication response and propagates unexpected admission failures', () => {
  const { request, previous, topology } = fixture(), prepare = (source: GraphLayout) => ({ preferred: source, frames: [] });
  expect(routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined, prepare,
    () => undefined as never)).toMatchObject({ ok: false, conflict: { reason: 'unsupported-input' } });
  const failure = new Error('unexpected final admission failure');
  expect(() => routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined, prepare,
    () => { throw failure; })).toThrow(failure);
});

it('declines malformed named conflicts from frame and topology callbacks', () => {
  const { request, previous, topology } = fixture();
  for (const response of [{ reason: 'unknown' }, { reason: 'unsupported-input', constraints: null },
    { reason: 'topology-conflict', constraints: [1] }]) {
    expect(routeCommittedIncremental(request, previous, () => topology, 64_000_000, undefined,
      () => response as never)).toMatchObject({ ok: false, conflict: { reason: 'unsupported-input' } });
    expect(routeCommittedIncremental(request, previous, () => response as never, 64_000_000))
      .toMatchObject({ ok: false, conflict: { reason: 'unsupported-input' } });
  }
});

it.each(['curve', 'source', 'consumer'] as const)('rejects a changed retained %s', change => {
  const { request, previous, topology } = fixture(), seed = capture(request, previous);
  const changed = { ...topology, routes: topology.routes.map(route => route.id !== 'ab' ? route
    : change === 'consumer' ? { ...route, consumers: [{ parent: 'a', child: 'c' }] }
      : { ...route, path: change === 'curve' ? route.path.replace('C20 75', 'C20 76') : route.path.replace('M20 40', 'M40 20') }) };
  expect(solveIncrementalTopology(request, seed, changed).ok).toBe(false);
});

it('rejects a changed retained rectangle without its source frame declaration', () => {
  const { request, previous } = fixture();
  const preferred = { ...previous, height: 256, nodes: new Map([...previous.nodes].map(([key, node]) =>
    [key, key === 'b' ? { ...node, height: 56 } : node])) };
  const grown = { ...request, items: request.items.map(item => item.key === 'b' ? { ...item, height: 56 } : item) };
  expect('problem' in captureFramedIncrementalRouting(grown, previous, preferred)).toBe(false);
  expect('problem' in captureFramedIncrementalRouting(grown, previous, preferred, [{ id: 'b-height',
    input: routingCoordinate('before', 'tile', 'b', 'height'), output: routingCoordinate('derived', 'tile', 'b', 'height'),
    steps: [{ operation: 'add', operand: 16, result: 56 }] }])).toBe(true);
});

it('withholds an exhausted solve and leaves the committed scene untouched', () => {
  const { request, previous, topology } = fixture(), seed = capture(request, previous), before = structuredClone(previous);
  expect(solveIncrementalTopology(request, seed, topology, 0)).toMatchObject({ ok: false, work: 0,
    conflict: { reason: 'budget-exhaustion' } });
  expect(previous).toEqual(before);
});

it('rejects malformed declarations and propagates ledger failures before native parsing', () => {
  const { request, previous } = fixture();
  for (const frames of [[null], [{ id: 'bad', input: 'not-a-coordinate', output: 'not-json', steps: [] }]])
    expect('problem' in captureFramedIncrementalRouting(request, previous, previous, frames as never)).toBe(false);
  const failure = new Error('work ledger exhausted');
  expect(() => captureFramedIncrementalRouting(request, previous, previous, [], () => { throw failure; })).toThrow(failure);
});

it('withholds non-cloneable preferred data and frame metadata', () => {
  const { request, previous } = fixture();
  const preferred = { ...previous, extra: () => {} };
  expect(captureFramedIncrementalRouting(request, previous, preferred)).toMatchObject({ reason: 'unsupported-input' });
  const frame = { id: 'head', input: routingCoordinate('before', 'path', 'ab', 'native', 0, 0, 'y'),
    output: routingCoordinate('derived', 'path', 'ab', 'native', 0, 0, 'y'), steps: [], extra: () => {} };
  expect(captureFramedIncrementalRouting(request, previous, previous, [frame])).toMatchObject({ reason: 'unsupported-input' });
});

it('compares consumer ownership without serializing unrelated cyclic metadata', () => {
  const { request, previous } = fixture();
  const extra: { self?: unknown } = {}; extra.self = extra;
  const source = { ...previous, routes: previous.routes.map(route => ({ ...route,
    consumers: [{ parent: 'a', child: 'b', extra }], from: { ...route.from, extra } })) };
  expect('problem' in captureFramedIncrementalRouting(request, source, source)).toBe(true);
});

it('meters expanded ownership bytes even when a long consumer object is shared', () => {
  const { previous } = fixture(), a = 'a'.repeat(1000), b = 'b'.repeat(1000);
  const consumer = { parent: a, child: b };
  const source: GraphLayout = { ...previous, nodes: new Map([[a, { ...previous.nodes.get('a')!, key: a }],
    [b, { ...previous.nodes.get('b')!, key: b }]]), routes: previous.routes.map(route => ({ ...route,
      from: { kind: 'node', id: a }, to: { kind: 'node', id: b }, consumers: Array(800).fill(consumer) })),
    readingOrder: new Map([[a, 0], [b, 1]]) };
  const limit = 512_000, failure = new Error('bounded ownership work');
  let work = 0;
  expect(() => captureRoutingFragments({ id: 'before', space: 'attached', drawing: source },
    { id: 'derived', space: 'attached', drawing: source }, [], amount => {
      if (amount > limit - work) throw failure;
      work += amount;
    })).toThrow(failure);
  expect(work).toBeLessThanOrEqual(limit);
});

it('does not let an added frame equality weaken the mandatory source interval', () => {
  const { request, previous, topology } = fixture();
  const source = { ...previous, routes: previous.routes.map(route => ({ ...route, path: 'M20 40 L20 100 L180 100 L180 192' })) };
  const topologyWithShortPrefix = { ...topology, routes: topology.routes.map(route => route.id === 'ab'
    ? { ...route, path: 'M20 40 L20 43 L180 43 L180 192' } : route) };
  const output = routingCoordinate('derived', 'path', 'ab', 'native', 0, 0, 'y');
  const crossAddress = captureFramedIncrementalRouting(request, source, source, [{ id: 'wrong-origin',
    input: routingCoordinate('before', 'tile', 'b', 'y'), output, steps: [{ operation: 'subtract', operand: 160, result: 40 }] }]);
  expect(crossAddress).toMatchObject({ reason: 'unsupported-input' });
  const seed = captureFramedIncrementalRouting(request, source, source, [{ id: 'head-identity',
    input: routingCoordinate('before', 'path', 'ab', 'native', 0, 0, 'y'), output, steps: [] }]);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  const solved = solveIncrementalTopology(request, seed, topologyWithShortPrefix);
  expect(solved.ok, JSON.stringify(solved.ok ? undefined : solved.conflict)).toBe(true);
  if (solved.ok) expect(pathCommands(solved.drawing.routes[0].path)![1].values[1]).toBeGreaterThanOrEqual(46);
});
