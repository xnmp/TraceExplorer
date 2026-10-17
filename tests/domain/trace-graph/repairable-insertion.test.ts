import { expect, it } from 'vitest';
import fixture from './repairable-insertion-scene.json';
import { layoutGraph, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

// Reduced from dense-f4-100-20501, width454, click3: main keeps n92 with
// a connector contact. A bounded connector repair permits a legal pinned result.
// Removing any remaining visible subtree loses this regression.
it('keeps the click anchor when an otherwise valid insertion needs connector repair', () => {
  const scene = JSON.parse(JSON.stringify(fixture), (_key, value) => value?.__map ? new Map(value.__map) : value);
  const previous = scene.previous as GraphLayout;
  const request = scene.request as LayoutRequest;
  const anchor = request.anchorKey!;
  const before = previous.nodes.get(anchor)!;
  expect(geometryGate(previous, request.items.filter(n => previous.nodes.has(n.key)), request.band!.key, request.maxWidth)).toBeNull();

  const input = { ...request, history: { signature: bandHistorySignature(request), layout: previous, placed: previous } };
  const result = attachSingleBand(layoutGraph(input), input);

  expect(geometryGate(result, input.items, input.band!.key, input.maxWidth)).toBeNull();
  expect(result.nodes.get(anchor)).toMatchObject({ x: before.x, y: before.y });
});
