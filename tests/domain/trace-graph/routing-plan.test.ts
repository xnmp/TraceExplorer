import { describe, expect, it } from 'vitest';
import { ARROW } from '$lib/domain/trace-graph/metrics';
import { CONNECTOR_STROKE } from '$lib/domain/trace-graph/connector-ink';
import { importPathGeometry, importRoutingPlan, importAttachmentStem, importArrowStub, importStemTurns, certifiedTurn, corridorCoordinate, tilePort, validateRoutingPlan, type RoutingPlan } from '$lib/domain/trace-graph/routing-plan';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { corpus, requestFor } from '../../../layout-eval/corpus';

const topology = (): Pick<GraphLayout, 'nodes' | 'junctions' | 'routes'> => ({
  nodes: new Map([
    ['a', { key: 'a', x: 0, y: 0, width: 40, height: 40, band: 0, row: 0 }],
    ['b', { key: 'b', x: 0, y: 80, width: 40, height: 40, band: 1, row: 1 }],
  ]), junctions: new Map(), routes: [
    { id: 'a-b', from: { kind: 'node', id: 'a' }, to: { kind: 'node', id: 'b' }, consumers: [], terminal: true, path: `M20 40 L20 ${80 - ARROW.length}` },
  ],
});
const fixture = (): RoutingPlan => importRoutingPlan(topology());

describe('imported painted routing contract', () => {
  it('imports existing shared-net and native-curve topology without rewriting semantics or path bytes', () => {
    let count = 0;
    for (const c of corpus()) for (const width of [360, 900]) for (const image of [48, 96]) {
      const drawing = layoutLayered(requestFor(c, null, width, image));
      const plan = importRoutingPlan(drawing);
      expect(plan.paths.map(p => p.route)).toEqual(drawing.routes);
      for (const path of plan.paths) expect(path.route).toBe(drawing.routes.find(r => r.id === path.id));
      count++;
    }
    expect(count).toBe(260);
  }, 20000);
  it('imports exact tile ports, arrow shaft, wings and stroke corridors without changing topology', () => {
    const plan = fixture();
    expect(() => validateRoutingPlan(plan)).not.toThrow();
    expect(plan.ports.map(p => [p.owner.kind, p.side, p.offset, p.point])).toEqual([
      ['tile', 'bottom', 20, { x: 20, y: 40 }], ['tile', 'top', 20, { x: 20, y: 80 }],
    ]);
    expect(plan.stubs[0].tip).toEqual({ x: 20, y: 80 });
    expect(plan.corridors[0].ink.left).toBe(20 - Math.max(...Object.values(CONNECTOR_STROKE)) / 2);
  });

  it('rejects a port off its owner edge', () => {
    const plan = fixture();
    expect(() => validateRoutingPlan({ ...plan, ports: [{ ...plan.ports[0], point: { x: 21, y: 41 } }, plan.ports[1]] })).toThrow(/port.*edge/i);
  });
  it('rejects a stub that does not meet its port', () => {
    const plan = fixture();
    expect(() => validateRoutingPlan({ ...plan, stubs: [{ ...plan.stubs[0], tip: { x: 21, y: 80 } }] })).toThrow(/stub.*port/i);
  });
  it('rejects a corridor smaller than its painted ink', () => {
    const plan = fixture(), corridor = plan.corridors[0];
    expect(() => validateRoutingPlan({ ...plan, corridors: [{ ...corridor, bounds: { ...corridor.bounds, left: 20 } }] })).toThrow(/corridor.*ink/i);
  });
  it('checks the certificate against actual paint rather than trusting its claimed envelope', () => {
    const plan = fixture(), corridor = plan.corridors[0], small = { left: 20, right: 20, top: 40, bottom: 72 };
    expect(() => validateRoutingPlan({ ...plan, corridors: [{ ...corridor, ink: small, bounds: small }] })).toThrow(/paint/i);
  });
  it('checks imported turns and channel pins without moving them', () => {
    const points = [{ x: 10, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 }];
    const turns = importStemTurns(points);
    expect(turns[0].radius).toBe(6);
    expect(() => validateRoutingPlan({ paths: [], ports: [], stubs: [], corridors: [], turns })).not.toThrow();
    expect(() => validateRoutingPlan({ paths: [], ports: [], stubs: [], corridors: [], turns: [{ ...turns[0], radius: 7 }] })).toThrow(/bound/i);
    expect(corridorCoordinate('track', 1.25, { lower: 1, upper: 2 })).toBe(1.25);
    expect(() => corridorCoordinate('track', 1.25, { lower: 2, upper: 3 })).toThrow(/conflict/i);
  });
  it('rejects detached branches but imports a connected same-source prefix', () => {
    const graph = topology(), route = graph.routes[0];
    expect(() => importRoutingPlan({ ...graph, routes: [{ ...route, path: 'M20 50 L20 72' }] })).toThrow(/disconnect/i);
    const plan = importRoutingPlan({ ...graph, routes: [
      { ...route, id: 'trunk', to: route.from, terminal: false, path: 'M20 40 L20 50' },
      { ...route, path: 'M20 50 L20 72' },
    ] });
    expect(plan.ports.find(p => p.id === 'a-b:from')?.owner.kind).toBe('junction');
    expect(plan.paths).toHaveLength(2);
  });
  it('rejects removal of painted corridors, collapsed arrows and perpendicular shafts', () => {
    const plan = fixture(), stub = plan.stubs[0];
    expect(() => validateRoutingPlan({ ...plan, corridors: [] })).toThrow(/corridor/i);
    expect(() => validateRoutingPlan({ ...plan, stubs: [{ ...stub, ink: { left: 20, right: 20, top: 72, bottom: 80 } }] })).toThrow(/paint/i);
    expect(() => validateRoutingPlan({ ...plan, stubs: [{ ...stub, shaft: [{ x: 12, y: 72 }, stub.base] }] })).toThrow(/direction/i);
  });
  it('binds attachment geometry to its supplied cover port', () => {
    const placement = { coverX: 20, coverHeight: 40, x: 0, width: 100, left: 0, right: 100 };
    const wrong = tilePort({ key: 'cover', x: 60, y: 0, width: 40, height: 40 }, 'bottom');
    expect(() => importAttachmentStem('M20 40 L20 100', 40, 34, placement, wrong)).toThrow(/start port/i);
  });
  it('rejects actual attachment lanes outside the cover-to-child allocation', () => {
    const placement = { coverX: 20, coverHeight: 40, x: 0, width: 100, left: 0, right: 100 };
    expect(() => importAttachmentStem('M20 40 L20 100', 0, 34, placement)).toThrow(/bound conflict/i);
    expect(() => importAttachmentStem('M20 40 L20 100', 40, 34, { ...placement, track: 19 })).toThrow(/bound conflict/i);
  });
  it('keeps slanted arrow wings perpendicular to the native endpoint direction', () => {
    const arrow = importArrowStub('diagonal', 'M0 0 L10 10', 'tip');
    const [a, b] = arrow.paint;
    expect(a.x + a.y).toBeCloseTo(20);
    expect(b.x + b.y).toBeCloseTo(20);
    expect(Math.hypot(a.x - 10, a.y - 10)).toBeCloseTo(ARROW.width / 2);
    expect(a).not.toEqual(b);
  });
  it('binds every certified turn to its authored path and corridor', () => {
    const plan = importRoutingPlan({ points: [{ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }] });
    expect(() => validateRoutingPlan({ ...plan, turns: [] })).toThrow(/turn/i);
    const unrelated = certifiedTurn('turn:0', { x: 0, y: 0 }, { x: 0, y: 20 }, { x: 20, y: 20 }, 6);
    expect(() => validateRoutingPlan({ ...plan, turns: [unrelated] })).toThrow(/turn/i);
  });
  it('requires the arrow shaft to be real native straight ink', () => {
    const graph = topology(), route = graph.routes[0];
    expect(() => importRoutingPlan({ ...graph, routes: [{ ...route, path: 'M20 40 C20 55 50 60 20 71 L20 72' }] })).toThrow(/shaft/i);
  });
  it('requires arrow allocation and binds native primitives to the authored path', () => {
    const plan = fixture(), path = plan.paths[0];
    expect(() => validateRoutingPlan({ ...plan, corridors: plan.corridors.filter(c => !c.id.endsWith('arrow-ink')),
      paths: [{ ...path, corridors: path.corridors.filter(id => !id.endsWith('arrow-ink')) }] })).toThrow(/arrow/i);
    expect(() => validateRoutingPlan({ ...plan, paths: [{ ...path, native: [[{ x: 100, y: 100 }, { x: 100, y: 108 }]] }] })).toThrow(/native/i);
    expect(() => validateRoutingPlan({ ...plan, paths: [{ ...path, kind: 'unknown' as never }] })).toThrow(/kind/i);
    expect(() => validateRoutingPlan({ ...plan, ports: [{ ...plan.ports[0], owner: { ...plan.ports[0].owner, kind: 'unknown' as never } }, plan.ports[1]] })).toThrow(/owner/i);
  });
  it('requires departure and arrival tangents normal to the port side', () => {
    const graph = topology(), route = graph.routes[0];
    expect(() => importRoutingPlan({ ...graph, routes: [{ ...route, path: 'M20 40 L0 40 L0 80 L12 80' }] })).toThrow(/tangent/i);
  });
  it('retains native command arity as well as its control-point sequence', () => {
    const graph = topology(), route = graph.routes[0];
    const plan = importRoutingPlan({ ...graph, nodes: new Map([...graph.nodes].map(([id, n]) => [id, id === 'b' ? { ...n, x: 10 } : n])),
      routes: [{ ...route, path: 'M20 40 C20 55 30 55 30 64 L30 72' }] });
    const path = plan.paths[0];
    expect(() => validateRoutingPlan({ ...plan, paths: [{ ...path,
      native: path.points.slice(1).map((p, i) => [path.points[i], p] as const) }] })).toThrow(/native/i);
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite geometry (%s)', value => {
    const plan = fixture();
    expect(() => validateRoutingPlan({ ...plan, ports: [{ ...plan.ports[0], offset: value }, plan.ports[1]] })).toThrow(/finite/i);
    expect(() => importPathGeometry(`M20 40 L20 ${value}`)).toThrow();
  });
  it('rejects duplicate identities and unknown port references', () => {
    const plan = fixture();
    expect(() => validateRoutingPlan({ ...plan, ports: [...plan.ports, plan.ports[0]] })).toThrow(/duplicate/i);
    expect(() => validateRoutingPlan({ ...plan, stubs: [{ ...plan.stubs[0], port: 'missing' }] })).toThrow(/port/i);
    expect(() => importRoutingPlan({ nodes: new Map(), junctions: new Map(), routes: [
      { id: 'x', from: { kind: 'node', id: 'missing' }, to: { kind: 'node', id: 'missing' }, consumers: [], terminal: true, path: 'M0 0 L0 10' },
    ] })).toThrow(/owner/i);
  });
  it('retains native cubic control hulls and rejects malformed path grammar', () => {
    const path = importPathGeometry('M0 0 C0 20 30 20 30 40 L30 50');
    expect(path.ink[0]).toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 40 }]);
    expect(path.end).toEqual({ x: 30, y: 50 });
    for (const invalid of ['M0 0 L1', 'M0 0 Q1 1 2 2', 'M0 0 L1e999 3', 'M0 0 garbage', 'M0?0 L1@1', '']) expect(() => importPathGeometry(invalid)).toThrow();
  });
  it('does not mutate an imported plan', () => {
    const plan = fixture(), before = structuredClone(plan);
    validateRoutingPlan(plan);
    expect(plan).toEqual(before);
  });
  it('derives right/left ports from the same tile equations', () => {
    const owner = { key: 'x', x: 10, y: 20, width: 40, height: 80 };
    expect(tilePort(owner, 'right').point).toEqual({ x: 50, y: 60 });
    expect(tilePort(owner, 'left').point).toEqual({ x: 10, y: 60 });
  });
});
