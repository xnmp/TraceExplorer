import { expect, it } from 'vitest';
import { layoutGraph, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { corpus, node, requestFor } from '../../../layout-eval/corpus';
import { expectArrivalPinned } from './arrival-contract';

it('keeps retained tiles pinned when an arrival shifts a connected tile below its new hint', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-40-7501')!;
  const commit = (request: LayoutRequest) => {
    const layout = layoutGraph(request);
    return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
  };
  const cold = commit(requestFor(fixture, null, 360, 96));
  const selected = commit({ ...requestFor(fixture, 'n16', 360, 96), anchorKey: 'n16', history: cold });
  const running = { ...fixture, nodes: [...fixture.nodes, { ...node('placeholder', ['n16'], 1e6), state: 'running' as const }] };
  const request = { ...requestFor(running, 'n16', 360, 96), anchorKey: 'n16', history: selected };
  const arrived = commit(request);

  expect(arrived.placed.nodes.has('placeholder')).toBe(true);
  expectArrivalPinned(selected.placed, arrived.placed, 'selected n16 arrival');
  expect(geometryGate(arrived.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});
