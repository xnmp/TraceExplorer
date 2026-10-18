import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { constrainedIncremental } from '../../../src/lib/domain/trace-graph/band-incremental';
import { captureIncrementalRouting } from '../../../src/lib/domain/trace-graph/incremental-routing';
import { retainedRoutingConflict } from '../../../src/lib/domain/trace-graph/routing-problem';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import type { GraphLayout, LayoutRequest } from '../../../src/lib/domain/trace-graph/layout';
const capture = (): { request: LayoutRequest; retained: GraphLayout } =>
  JSON.parse(readFileSync(new URL('./publication-contact-committed.json', import.meta.url), 'utf8'),
    (_key, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value);

it('publishes arrivals while keeping new attachment fillets clear of new foreign routes', () => {
  const { request, retained } = capture(), original = structuredClone({ request, retained });
  const seed = captureIncrementalRouting(request, retained);
  if (!('problem' in seed)) throw new Error(JSON.stringify(seed));
  const result = constrainedIncremental(request, retained);
  expect(result.ok, JSON.stringify(result.ok ? undefined : result.conflict)).toBe(true);
  if (!result.ok) return;
  const published = attachSingleBand(structuredClone(result.drawing), request);
  expect([...published.nodes.keys()].sort()).toEqual(request.items.map(n => n.key).sort());
  expect(published.nodes.has('n24')).toBe(true);
  expect(published.routes.some(r => r.from.kind === 'node' && r.from.id === 'root'
    && r.to.kind === 'node' && r.to.id === 'n24' && r.terminal)).toBe(true);
  expect(geometryGate(published, request.items, request.band!.key, request.maxWidth)).toBeNull();
  expect(retainedRoutingConflict(seed.problem, [{ id: 'committed', space: 'attached', drawing: published }])).toBeNull();
  for (const [key, tile] of seed.drawing.nodes) expect(published.nodes.get(key)).toEqual(tile);
  for (const route of seed.drawing.routes) expect(published.routes.find(r => r.id === route.id)?.path).toBe(route.path);
  expect(result.work).toBeLessThanOrEqual(64_000_000);
  expect({ request, retained }).toEqual(original);
  expect(constrainedIncremental(structuredClone(request), structuredClone(retained))).toEqual(result);
}, 20_000);
