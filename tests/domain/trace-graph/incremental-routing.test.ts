import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureIncrementalRouting, projectCommittedRouting, solveIncrementalTopology } from '../../../src/lib/domain/trace-graph/incremental-routing';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutRequest } from '../../../src/lib/domain/trace-graph/layout';
import { AUTOMATIC_ROUTING_WORK, constrainedIncremental, incrementalTree } from '../../../src/lib/domain/trace-graph/band-incremental';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { profileLayout } from '../../../src/lib/domain/trace-graph/layout-profile';
import { isLayoutShape, validHistory } from '../../../src/lib/domain/trace-graph/history-boundary';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { layoutGraph } from '../../../src/lib/domain/trace-graph/layout';
import { retainedRoutingConflict } from '../../../src/lib/domain/trace-graph/routing-problem';
import { estimateLayoutBytes } from '../../../src/lib/domain/trace-graph/folder-layout/bounded-cache';

const capture = () => JSON.parse(readFileSync(new URL('./committed-routing-n33.json', import.meta.url), 'utf8'),
  (_k, v) => v?.__map ? new Map(v.__map) : v?.__set ? new Set(v.__set) : v) as {
    request: LayoutRequest; retained: GraphLayout; selected: GraphLayout;
  };
const seed = (request: LayoutRequest, retained: GraphLayout) => {
  const result = captureIncrementalRouting(request, retained);
  if (!('problem' in result)) throw new Error(JSON.stringify(result));
  return result;
};

describe('committed incremental topology adapter', () => {
  it('carries new n64 consumers through exact native source prefixes', () => {
    const { request, retained } = JSON.parse(readFileSync(new URL('./committed-routing-n64.json', import.meta.url), 'utf8'),
      (_key, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value) as {
        request: LayoutRequest; retained: GraphLayout;
      };
    const before = structuredClone({ request, retained }), captured = seed(request, retained);
    const result = constrainedIncremental(request, retained);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    const published = attachSingleBand(structuredClone(result.drawing), request);
    expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
    expect(new Set(published.nodes.keys())).toEqual(new Set(request.items.map(item => item.key)));
    expect(retainedRoutingConflict(captured.problem, [{ id: 'committed', space: 'attached', drawing: published }])).toBeNull();
    expect(result.work).toBeLessThanOrEqual(AUTOMATIC_ROUTING_WORK);
    expect({ request, retained }).toEqual(before);
  }, 20_000);

  it('constructs the n33 fresh departure and corridor from committed input alone', () => {
    const { request, retained } = capture(), before = structuredClone({ request, retained });
    const captured = seed(request, retained), result = constrainedIncremental(request, retained);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    const published = attachSingleBand(structuredClone(result.drawing), request);
    expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
    expect(new Set(published.nodes.keys())).toEqual(new Set(request.items.map(n => n.key)));
    expect(retainedRoutingConflict(captured.problem, [{ id: 'committed', space: 'attached', drawing: published }])).toBeNull();
    expect({ request, retained }).toEqual(before);
    expect(constrainedIncremental(structuredClone(request), structuredClone(retained))).toEqual(result);
  }, 20_000);

  it('solves the n33 free internal corridor with every committed path and tile exact', () => {
    const { request, retained, selected } = capture(), before = structuredClone({ request, retained, selected });
    expect(geometryGate(selected, request.items, request.band!.key, request.maxWidth)).toBe('shared-lane');
    const result = solveIncrementalTopology(request, seed(request, retained), selected);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    expect(geometryGate(result.drawing, request.items, request.band!.key, request.maxWidth)).toBeNull();
    for (const [key, tile] of retained.nodes) expect(result.drawing.nodes.get(key)).toEqual(tile);
    for (const route of retained.routes) expect(result.drawing.routes.find(r => r.id === route.id)?.path).toBe(route.path);
    expect(result.solved).toBeGreaterThan(0);
    expect({ request, retained, selected }).toEqual(before);
  });

  it('declines changed retained path bytes instead of silently dropping the pin', () => {
    const { request, retained, selected } = capture();
    const topology = { ...selected, routes: selected.routes.map(r => r.id === retained.routes[0].id ? { ...r, path: r.path + ' ' } : r) };
    const result = solveIncrementalTopology(request, seed(request, retained), topology);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict.reason).toBe('metric-conflict');
  });

  it('reports a finite total work budget without mutating committed state', () => {
    const { request, retained, selected } = capture();
    const result = solveIncrementalTopology(request, seed(request, retained), selected, 0);
    expect(result).toMatchObject({ ok: false, work: 0, conflict: { reason: 'budget-exhaustion' } });
  });

  it('projects actual departures before capturing retained coordinates and consumers', () => {
    const { request, retained } = capture();
    const items = request.items.filter(n => n.key !== 'n33');
    const projected = projectCommittedRouting(retained, { ...request, items });
    expect(projected.nodes.has('n33')).toBe(false);
    const captured = captureIncrementalRouting({ ...request, items }, retained);
    expect('problem' in captured).toBe(true);
  });

  it('requires a declared hint policy before changing any retained rectangle', () => {
    const { request, retained } = capture();
    const items = request.items.map(n => n.key === 'n33' ? { ...n, height: n.height + 16 } : n);
    expect(captureIncrementalRouting({ ...request, items }, retained)).toEqual({ reason: 'unsupported-input', constraints: ['derive hint rectangles before capture'] });
  });

  it('automatically constructs and publishes an insertion without reauthoring a retained root suffix', () => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const before = optimizedBand(requestFor(fixture, null, 454, 96));
    const request = requestFor(fixture, 'Cerulean', 454, 96);
    const result = constrainedIncremental(request, before.placed);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    const published = attachSingleBand(structuredClone(result.drawing), request);
    expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
    for (const route of before.placed.routes) expect(published.routes.find(r => r.id === route.id)?.path).toBe(route.path);
    for (const [key, n] of before.placed.nodes) expect(published.nodes.get(key)).toEqual(n);
    expect(published.nodes.size).toBe(request.items.length);
  });

  it('classifies an exhausted constructor as budget exhaustion', () => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const before = optimizedBand(requestFor(fixture, null, 454, 96));
    const request = requestFor(fixture, 'Cerulean', 454, 96);
    expect(constrainedIncremental(request, before.placed, { fallback: 0, second: 0, probes: 0 })).toMatchObject({
      ok: false, conflict: { reason: 'budget-exhaustion' },
    });
  });

  it('certifies a departure with no newly visible tile', () => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const before = optimizedBand(requestFor(fixture, 'Cerulean', 454, 96));
    const request = requestFor(fixture, null, 454, 96);
    const result = constrainedIncremental(request, before.placed);
    expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
    if (!result.ok) return;
    expect([...result.drawing.nodes.keys()].sort()).toEqual(request.items.map(n => n.key).sort());
    expect(geometryGate(attachSingleBand(result.drawing, request), request.items, request.band!.key, request.maxWidth)).toBeNull();
  });

  it('declines malformed committed input before projecting consumers', () => {
    const { request, retained } = capture();
    const malformed = structuredClone(retained);
    (malformed.routes[0] as any).consumers = null;
    const sparse = [...request.items]; sparse.length++;
    const sparseBand = [...request.band!.items]; sparseBand.length++;
    const sparseParents = [...request.items[0].parents]; sparseParents.length++;
    const malformedParents = { ...request, items: [{ ...request.items[0], parents: sparseParents }, ...request.items.slice(1)] };
    for (const [input, drawing] of [[request, malformed], [request, null], [{ ...request, items: [null] }, retained],
      [{ ...request, items: sparse }, retained], [malformedParents, retained],
      [{ ...request, band: { ...request.band!, items: sparseBand } }, retained],
      [{ ...request, band: { ...request.band!, items: [null] } }, retained]] as const) {
      expect(constrainedIncremental(input as any, drawing as any)).toMatchObject({
        ok: false, conflict: { reason: 'unsupported-input' },
      });
    }
  });

  it('charges an oversized free native model before parsing its commands', () => {
    const { request, retained, selected } = capture();
    const topology = { ...selected, routes: [...selected.routes, { ...selected.routes[0], id: 'oversized',
      path: 'M0 0 ' + 'L0 1 '.repeat(20_000) }] };
    const before = structuredClone(topology);
    const result = solveIncrementalTopology(request, seed(request, retained), topology, 1);
    expect(result).toMatchObject({ ok: false, work: 1, conflict: { reason: 'budget-exhaustion' } });
    expect(topology).toEqual(before);
  });

  it.each(['paths', 'placement', 'extra-cycle', 'sparse', 'duplicate'] as const)('rejects mutated %s frame metadata identically before and after worker transfer', kind => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const before = optimizedBand(requestFor(fixture, null, 454, 96)), request = requestFor(fixture, 'Cerulean', 454, 96);
    const result = constrainedIncremental(request, before.placed);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const layout = structuredClone(result.drawing), placed = attachSingleBand(layout, request);
    const history = { signature: bandHistorySignature(request), layout, placed };
    expect(validHistory(history, request.band!.key)).toBe(true);
    const frame = layout.routingAttachment as any;
    if (kind === 'paths') frame.paths = [null];
    else if (kind === 'placement') frame.placement = null;
    else if (kind === 'extra-cycle') frame.placement.extra = frame.placement;
    else if (kind === 'sparse') delete frame.paths[0];
    else frame.paths.push(frame.paths[0]);
    expect(isLayoutShape(layout)).toBe(false);
    expect(validHistory(history, request.band!.key)).toBe(false);
    expect(validHistory(structuredClone(history), request.band!.key)).toBe(false);
    const rebuilt = layoutGraph({ ...request, history });
    expect(geometryGate(attachSingleBand(rebuilt, request), request.items, request.band!.key, request.maxWidth)).toBeNull();
  });

  it('accounts for persisted native frame bindings in bounded storage', () => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const before = optimizedBand(requestFor(fixture, null, 454, 96)), request = requestFor(fixture, 'Cerulean', 454, 96);
    const result = constrainedIncremental(request, before.placed);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const without = { ...result.drawing, routingAttachment: undefined };
    expect(estimateLayoutBytes(result.drawing) - estimateLayoutBytes(without)).toBeGreaterThanOrEqual(
      result.drawing.routingAttachment!.paths.reduce((n, [id, path]) => n + 2 * (id.length + path.length), 0));
  });
});
