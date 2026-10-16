import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { layoutLayered } from '$lib/domain/trace-graph/layout';
import { attachSingleBand, withBandBounds } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('keeps normal channel turns clear of adjacent passing lanes', () => {
  const fixture = corpus().find(c => c.id === 'random-tree-40-7401')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 454, 48);
  const raw = withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key);
  const placed = attachSingleBand(raw, request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('keeps junction inputs separate before their final convergence', () => {
  const fixture = corpus().find(c => c.id === 'overlapping-merges')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 360, 48);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('reserves the full port berth when a horizontal turn ends beside a foreign port', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-40-7502')!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, 900, 48);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it.each([
  ['random-tree-100-8001', 640, 96],
  ['random-chainy-100-8301', 1400, 128],
] as const)('reserves clearance through narrow swaps and doglegs: %s', (id, width, image) => {
  const fixture = corpus().find(c => c.id === id)!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, width, image);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it.each([
  ['random-dag-40-7503', 900, 64],
  ['random-dag-100-8103', 454, 48],
  ['random-dag-100-8102', 1400, 96],
  ['random-dag-200-9103', 900, 128],
] as const)('reserves every fan approach and rejects near-lane zone choices: %s', (id, width, image) => {
  const fixture = corpus().find(c => c.id === id)!;
  const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, width, image);
  const placed = attachSingleBand(withBandBounds(layoutLayered({ ...request, band: undefined }), request.band!.key), request);
  expect(geometryGate(placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
});

it('finds a free swap detour beyond the local lane cluster within the pane', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-200-9102')!;
  const request = requestFor(fixture, null, 1400, 128);
  const placed = attachSingleBand(withBandBounds(layoutLayered({...request,band:undefined}),request.band!.key),request);
  expect(geometryGate(placed,request.items,request.band!.key,request.maxWidth)).toBeNull();
});
