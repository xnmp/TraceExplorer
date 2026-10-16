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
