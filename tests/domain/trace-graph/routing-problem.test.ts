import { describe, expect, it } from 'vitest';
import { importCommittedRouting, retainedRoutingConflict, routingCoordinate, type CommittedRoutingScene } from '../../../src/lib/domain/trace-graph/routing-problem';
import { solveRoutingComponents } from '../../../src/lib/domain/trace-graph/routing-components';
import type { GraphLayout } from '../../../src/lib/domain/trace-graph/layout';
import { layoutLayered } from '../../../src/lib/domain/trace-graph/layout';

const drawing = (): GraphLayout => ({
  orientation: 'down', width: 200, height: 130, rows: [], readingOrder: new Map(),
  nodes: new Map([
    ['a', { key: 'a', x: 0, y: 0, width: 40, height: 40, band: 0, row: 0 }],
    ['b', { key: 'b', x: 10, y: 80, width: 40, height: 40, band: 1, row: 1 }],
    ['ordinary', { key: 'ordinary', x: 100, y: 80, width: 40, height: 40, band: 1, row: 1 }],
  ]), junctions: new Map(), routes: [{ id: 'a-b', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'b' },
    consumers: [{ parent: 'a', child: 'b' }], terminal: true, path: 'M20 40 L20 50 C20 56 30 56 30 62 L30 72' }],
});
const scene = (value = drawing(), id = 'retained'): CommittedRoutingScene => ({ id, space: 'folder', drawing: value });
const committed = (scenes = [scene()]) => {
  const result = importCommittedRouting(scenes);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.conflict));
  return result.problem;
};

describe('committed routing problem', () => {
  it('captures isolated rectangles, real ports, native controls and complete route bytes as solver constants', () => {
    const p = committed(), metric = p.metric;
    const port = p.scenes[0].plan.ports[0];
    const n = routingCoordinate('retained', 'tile', 'ordinary', 'x');
    const native = routingCoordinate('retained', 'path', 'a-b', 'native', 1, 1, 'x');
    const portX = routingCoordinate('retained', 'port', port.id, 'point', 'x');
    const result = solveRoutingComponents({ ...metric, variables: [...metric.variables, { id: 'new', preferred: 0 }],
      order: [...metric.order, 'new'], separations: [{ id: 'fixed-obstacle', before: n, after: 'new', gap: 3 }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positions.get(n)).toBe(100);
      expect(result.positions.get(native)).toBe(20);
      expect(result.positions.get(portX)).toBe(20);
      expect(result.positions.get('new')).toBe(103);
      expect(result.solved).toEqual([['new']]);
    }
    expect(p.scenes[0].drawing.routes[0].path).toBe(drawing().routes[0].path);
  });
  it('names every captured coordinate exactly as routingCoordinate does, whatever its keys contain', () => {
    const keys = ['plain', 'quo"te', 'back\\slash', '12', 'line\u2028sep', 'ünï', ''];
    const nodes = new Map(keys.map((key, i) => [key, { key, x: 10 * i, y: 50, width: 8, height: 8, band: 1, row: 1 }]));
    const value: GraphLayout = { orientation: 'down', width: 200, height: 100, rows: [{ band: 1, index: 2, top: 50, bottom: 58, keys: keys }],
      readingOrder: new Map(), nodes, junctions: new Map(), routes: [] };
    for (const sceneId of ['retained', 'sc"ene', '7']) {
      const ids = new Set(committed([scene(value, sceneId)]).metric.variables.map(v => v.id));
      for (const [i, key] of keys.entries()) for (const [axis, at] of [['x', 10 * i], ['y', 50]] as const) {
        const id = routingCoordinate(sceneId, 'tile', key, axis);
        expect(ids.has(id), id).toBe(true);
        expect(committed([scene(value, sceneId)]).metric.variables.find(v => v.id === id)?.pin?.value).toBe(at);
      }
      expect(ids.has(routingCoordinate(sceneId, 'row', 1, 2, 'top'))).toBe(true);
      expect([...ids].every(id => { const parsed = JSON.parse(id); return parsed[0] === 'scene' && parsed[1] === sceneId; })).toBe(true);
    }
  });

  it('detects a moved retained tile whatever its scene id and key contain', () => {
    const keys = ['quo"te', 'back\\slash'];
    const make = (dx: number): GraphLayout => ({ orientation: 'down', width: 200, height: 100, rows: [], readingOrder: new Map(),
      nodes: new Map(keys.map((key, i) => [key, { key, x: 10 * i + (i ? dx : 0), y: 50, width: 8, height: 8, band: 1, row: 1 }])), junctions: new Map(), routes: [] });
    for (const sceneId of ['sc"ene', 'x","tile']) {
      const p = committed([scene(make(0), sceneId)]);
      expect(retainedRoutingConflict(p, [scene(make(0), sceneId)])).toBeNull();
      expect(retainedRoutingConflict(p, [scene(make(1), sceneId)])?.variable).toBe(routingCoordinate(sceneId, 'tile', keys[1], 'x'));
    }
  });

  it('returns equality conflict if a proposed solve tries to move a retained track', () => {
    const p = committed(), id = routingCoordinate('retained', 'path', 'a-b', 'native', 1, 1, 'x');
    expect(solveRoutingComponents({ ...p.metric, equalities: [{ id: 'candidate-track', variable: id, value: 21 }] }))
      .toMatchObject({ ok: false, conflict: { kind: 'equality', variable: id } });
  });
  it('captures a snapshot independent of later caller mutation and worker cloning', () => {
    const before = scene(), p = committed([before]);
    (before.drawing.nodes.get('a') as { x: number }).x = 99;
    expect(p.scenes[0].drawing.nodes.get('a')!.x).toBe(0);
    expect(solveRoutingComponents(structuredClone(p.metric))).toEqual(solveRoutingComponents(p.metric));
  });
  it('checks physical and native byte retention separately when the topology grows', () => {
    const p = committed(), after = drawing();
    const added = { ...after.nodes.get('ordinary')!, key: 'new', x: 150 };
    const extension = { ...after, width: 250, nodes: new Map([...after.nodes, ['new', added]]) };
    expect(retainedRoutingConflict(p, [scene(extension)])).toBeNull();
    const reserialized = { ...extension, routes: extension.routes.map(r => ({ ...r, path: r.path.replace(' L', '  L') })) };
    expect(retainedRoutingConflict(p, [scene(reserialized)])).toMatchObject({ kind: 'equality', constraints: ['retained native route'] });
  });
  it('rejects loss of isolated tile identity and of an old native cubic suffix', () => {
    const p = committed(), after = drawing(), nodes = new Map(after.nodes); nodes.delete('ordinary');
    expect(retainedRoutingConflict(p, [scene({ ...after, nodes })])).toMatchObject({ kind: 'equality' });
    const routes = after.routes.map(r => ({ ...r, path: r.path.replace('C20 56', 'C21 56') }));
    expect(retainedRoutingConflict(p, [scene({ ...after, routes })])).toMatchObject({ kind: 'equality' });
  });
  it('does not let changed component labels redefine the tile pin identities', () => {
    const p = committed(), unchanged = scene({ ...drawing(), decision: { candidate: 'new-component-id', stability: true } });
    expect(retainedRoutingConflict(p, [unchanged])).toBeNull();
    const nodes = new Map(unchanged.drawing.nodes);
    nodes.set('ordinary', { ...nodes.get('ordinary')!, x: 101 });
    expect(retainedRoutingConflict(p, [scene({ ...unchanged.drawing, nodes })])).toMatchObject({ kind: 'equality' });
  });
  it('binds convergence suffixes to path identity across route storage permutations', () => {
    const joined = layoutLayered({ items: [
      { key: 'a', parents: [], width: 40, height: 40, order: 0 },
      { key: 'b', parents: [], width: 40, height: 40, order: 1 },
      { key: 'c', parents: ['a', 'b'], width: 40, height: 40, order: 2 },
    ], maxWidth: 360 });
    const before = committed([scene(joined)]);
    const reversed = { ...joined, routes: [...joined.routes].reverse() };
    const after = committed([scene(reversed)]);
    const constants = (p: typeof before) => new Map(p.metric.variables.map(v => [v.id, v.pin!.value]));
    expect(constants(after)).toEqual(constants(before));
    expect(retainedRoutingConflict(before, [scene(reversed)])).toBeNull();
  });
  it('retains every ordered frame result instead of reassociating arithmetic', () => {
    const source = { ...drawing(), routes: [] }, target = structuredClone(source);
    source.nodes = new Map([['a', { ...source.nodes.get('a')!, x: .1 }]]);
    target.nodes = new Map([['a', { ...target.nodes.get('a')!, x: (.1 + 2 ** 30) - 2 ** 30 }]]);
    const input = routingCoordinate('raw', 'tile', 'a', 'x'), output = routingCoordinate('world', 'tile', 'a', 'x');
    const frames = [{ id: 'ordered-frame', input, output, steps: [
      { operation: 'add' as const, operand: 2 ** 30, result: .1 + 2 ** 30 },
      { operation: 'subtract' as const, operand: 2 ** 30, result: target.nodes.get('a')!.x },
    ] }];
    const result = importCommittedRouting([scene(source, 'raw'), scene(target, 'world')], frames);
    expect(result.ok).toBe(true);
    expect(target.nodes.get('a')!.x).not.toBe(.1);
    const wrong = [{ ...frames[0], steps: [{ operation: 'add' as const, operand: 0, result: .1 }] }];
    expect(importCommittedRouting([scene(source, 'raw'), scene(target, 'world')], wrong)).toMatchObject({ ok: false, conflict: { kind: 'equality' } });
  });
  it('rejects a different declared frame even if its coordinate numbers happen to match', () => {
    const p = committed();
    expect(retainedRoutingConflict(p, [{ ...scene(), space: 'band' }])).toMatchObject({ kind: 'equality', constraints: ['declared frame'] });
  });
  it('rejects nonfinite isolated geometry, duplicate scenes and malformed native paths', () => {
    const d = drawing(), nodes = new Map(d.nodes); nodes.set('ordinary', { ...nodes.get('ordinary')!, x: NaN });
    expect(importCommittedRouting([scene({ ...d, nodes })])).toMatchObject({ ok: false, conflict: { kind: 'invalid' } });
    expect(importCommittedRouting([scene(), scene()])).toMatchObject({ ok: false, conflict: { kind: 'invalid' } });
    expect(importCommittedRouting([scene({ ...d, routes: [{ ...d.routes[0], path: 'M1 NaN' }] })])).toMatchObject({ ok: false, conflict: { kind: 'invalid' } });
    for (const invalid of [undefined, { ...d, nodes: null }, { ...d, rows: [{ index: 0, band: 0, top: 40, bottom: 0, keys: ['a'] }] }])
      expect(importCommittedRouting([{ id: 'retained', space: 'folder', drawing: invalid as GraphLayout }])).toMatchObject({ ok: false, conflict: { kind: 'invalid' } });
  });
  it('propagates the original work-ledger exhaustion', () => {
    for (const exhausted of [new Error('stop work'), new RangeError('work budget')])
      expect(() => importCommittedRouting([scene()], [], () => { throw exhausted; })).toThrow(exhausted);
  });
  it('charges a shared consumer table before snapshot and shape traversal', () => {
    const d = drawing(), consumer = { parent: 'a', child: 'b' };
    const consumers = { entries: Array.from({ length: 10_000 }, () => consumer), start: 0, end: 1 };
    const large = { ...d, routes: [{ ...d.routes[0], consumers }] };
    let remaining = 5000;
    const exhausted = new RangeError('snapshot budget');
    expect(() => importCommittedRouting([scene(large)], [], work => {
      if (work > remaining) throw exhausted;
      remaining -= work;
    })).toThrow(exhausted);
  });
  it('charges shared-table shape validation again for each declared scene', () => {
    const d = drawing(), consumer = { parent: 'a', child: 'b' };
    const consumers = { entries: Array(10_000).fill(consumer), start: 0, end: 1 };
    const shared = { ...d, routes: [{ ...d.routes[0], consumers }] };
    let remaining = 500_000;
    const exhausted = new Error('multi-scene snapshot budget');
    expect(() => importCommittedRouting(Array.from({ length: 100 }, (_, i) => scene(shared, String(i))), [], work => {
      if (work > remaining) throw exhausted;
      remaining -= work;
    })).toThrow(exhausted);
  });
});
