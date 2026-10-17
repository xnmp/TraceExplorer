import { expect, it } from 'vitest';
import fixture from './repack-budget-scene.json';
import { layoutGraph, type GraphLayout, type LayoutRequest } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';

it('gives anchored repacking its own bounded search after pinned insertion exhausts its effort', () => {
  const scene = JSON.parse(JSON.stringify(fixture), (_key, value) => value?.__map ? new Map(value.__map) : value);
  const previous = scene.previous as GraphLayout;
  const request = scene.request as LayoutRequest;
  expect(geometryGate(previous, request.items.filter(n=>previous.nodes.has(n.key)), request.band!.key, request.maxWidth)).toBeNull();
  const input = {...request, history: {signature: bandHistorySignature(request),layout: previous,placed: previous}};
  const result = attachSingleBand(layoutGraph(input), input);
  const anchor = request.anchorKey!;
  expect(result.nodes.get(anchor)).toMatchObject({x:previous.nodes.get(anchor)!.x,y:previous.nodes.get(anchor)!.y});
  expect(geometryGate(result,input.items,input.band!.key,input.maxWidth)).toBeNull();
});
