import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { constrainedIncremental } from '../../../src/lib/domain/trace-graph/band-incremental';
import { chargedNativeClearance } from '../../../src/lib/domain/trace-graph/native-route-clearance';
import { captureIncrementalRouting } from '../../../src/lib/domain/trace-graph/incremental-routing';
import { retainedRoutingConflict } from '../../../src/lib/domain/trace-graph/routing-problem';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutRequest } from '../../../src/lib/domain/trace-graph/layout';
const capture = (): { request: LayoutRequest; retained: GraphLayout } =>
  JSON.parse(readFileSync(new URL('./committed-routing-t25.json', import.meta.url), 'utf8'),
    (_key, v) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v);

it('constructs another native-safe corridor instead of publishing the tiny cubic contact', () => {
  const { request, retained } = capture(), original = structuredClone({ request, retained });
  const seed = captureIncrementalRouting(request, retained);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  const result = constrainedIncremental(request, retained);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (!result.ok) return;
  const published = attachSingleBand(structuredClone(result.drawing), request);
  expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
  expect([...published.nodes.keys()].sort()).toEqual(request.items.map(n => n.key).sort());
  expect(retainedRoutingConflict(seed.problem, [{ id: 'committed', space: 'attached', drawing: published }])).toBeNull();
  for (const [key, tile] of seed.drawing.nodes) expect(published.nodes.get(key)).toEqual(tile);
  for (const route of seed.drawing.routes) expect(published.routes.find(r => r.id === route.id)?.path).toBe(route.path);
  expect(result.work).toBeLessThanOrEqual(64_000_000);
  expect({ request, retained }).toEqual(original);
  expect(constrainedIncremental(structuredClone(request), structuredClone(retained))).toEqual(result);
}, 20_000);

it('charges native parsing before executing it and preserves budget exceptions', () => {
  const { retained } = capture();
  const exhausted = new Error('work exhausted');
  const charges: string[] = [];
  expect(() => chargedNativeClearance(retained, (_work, reason) => {
    charges.push(reason!);
    if (reason === 'native path parsing') throw exhausted;
  })).toThrow(exhausted);
  expect(charges).toContain('native path parsing');
});

it('bounds repeated native source identities by their expanded serialized size', () => {
  const { retained } = capture();
  const measure = (id: string) => {
    const route = { ...retained.routes[0], from: { kind: 'node' as const, id }, terminal: false };
    const drawing = { ...retained, nodes: new Map(), junctions: new Map(),
      routes: Array.from({ length: 64 }, (_, index) => ({ ...route, id: `fragment-${index}` })) };
    let work = 0;
    expect(chargedNativeClearance(drawing, amount => { work += amount; })).toBeNull();
    return work;
  };
  const short = 'a', long = '\u0000'.repeat(32_768);
  const expandedBytes = 64 * (JSON.stringify(['node', long]).length - JSON.stringify(['node', short]).length);
  expect(measure(long) - measure(short)).toBeGreaterThanOrEqual(expandedBytes);
});

it('preserves every source-identity charge exception before serializing the identity', () => {
  const { retained } = capture();
  for (const exhausted of [new Error('identity budget'), { exhausted: true }, 'identity budget', null]) {
    let identityReads = 0;
    const route = { ...retained.routes[0], from: { kind: 'node' as const,
      get id() { if (++identityReads > 1) throw new Error('unpaid identity serialization'); return 'source'; } } };
    let caught: unknown = Symbol('not thrown');
    try {
      chargedNativeClearance({ ...retained, routes: [route] }, (_work, reason) => {
        if (reason === 'native source identity bytes') throw exhausted;
      });
    } catch (error) { caught = error; }
    expect(caught).toBe(exhausted);
    expect(identityReads).toBe(1);
  }
});

it('returns bounded exhaustion if native admission consumes the constructor remainder', () => {
  const { request, retained } = capture();
  const result = constrainedIncremental(request, retained, undefined, undefined, 26_000_000);
  expect(result).toMatchObject({ ok: false, conflict: { reason: 'budget-exhaustion' } });
  expect(result.work).toBeLessThanOrEqual(26_000_000);
});
