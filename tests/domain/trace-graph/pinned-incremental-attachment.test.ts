import { expectArrivalPinned } from './arrival-contract';
import { expect, it } from 'vitest';
import { layoutGraph } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { node, requestFor } from '../../../layout-eval/corpus';

it('arrival extends a wide committed band without translating its retained tile rectangles', () => {
  const nodes = [node('root'), node('a', ['root'], 1), node('b', ['a'], 2), node('c', ['b'], 3), node('d', ['c'], 4), node('e', ['c', 'd'], 5)];
  const first = requestFor({ id: 'wide-chain', nodes, focuses: [null] }, 'e', 640, 96);
  const layout = layoutGraph(first), placed = attachSingleBand(layout, first);
  const next = { ...requestFor({ id: 'wide-chain', nodes: [...nodes, node('f', ['e'], 6)], focuses: [null] }, 'e', 640, 96),
    history: { signature: bandHistorySignature(first), layout, placed } };
  const result = attachSingleBand(layoutGraph(next), next);
  expect(geometryGate(result, next.items, 'root', 640)).toBeNull();
  expectArrivalPinned(placed, result);
});

import { profiles, provenanceSession, sessionComponents } from '../../../layout-eval/provenance-model';

it('arrival routes clear retained cover ports without rebuilding the committed band', () => {
  const component = sessionComponents(provenanceSession(profiles.combinations, 3)).sort((a, b) => b.length - a.length)[0];
  const rename = new Map(component.map((n, i) => [n.key, i ? n.key : 'root']));
  const nodes = component.map(n => ({ ...n, key: rename.get(n.key)!, parents: n.parents.filter(p => rename.has(p)).map(p => rename.get(p)!) }));
  const first = requestFor({ id: 'cover-port', nodes: nodes.slice(0, 10), focuses: [null] }, nodes[10].parents[0], 454, 96);
  const layout = layoutGraph(first), placed = attachSingleBand(layout, first);
  const next = { ...requestFor({ id: 'cover-port', nodes: nodes.slice(0, 11), focuses: [null] }, nodes[10].parents[0], 454, 96),
    history: { signature: bandHistorySignature(first), layout, placed } };
  const result = attachSingleBand(layoutGraph(next), next);
  expect(geometryGate(result, next.items, 'root', 454)).toBeNull();
  expectArrivalPinned(placed, result);
});

it.each([['chains', 'i20'], ['variations', 'i34']])('keeps retained %s geometry when an output arrives beyond the pane', (profile, focus) => {
  const component = sessionComponents(provenanceSession(profiles[profile], 2)).sort((a, b) => b.length - a.length)[0];
  const rename = new Map(component.map((n, i) => [n.key, i ? n.key : 'root']));
  const nodes = component.map(n => ({ ...n, key: rename.get(n.key)!, parents: n.parents.filter(p => rename.has(p)).map(p => rename.get(p)!) }));
  const c = { id: profile, nodes, focuses: [null] };
  const commit = (request: Parameters<typeof layoutGraph>[0]) => {
    const layout = layoutGraph(request);
    return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
  };
  const selected = commit({ ...requestFor(c, focus, 360, 96), history: commit(requestFor(c, null, 360, 96)) });
  const next = { ...requestFor({ ...c, nodes: [...nodes, node('placeholder', [focus], 1e6)] }, focus, 360, 96), history: selected };
  const after = commit(next);
  expect(geometryGate(after.placed, next.items, 'root', 360)).toBeNull();
  expectArrivalPinned(selected.placed, after.placed);
});

import { corpus } from '../../../layout-eval/corpus';

it('removing a failed output preserves the retained routing channel and tile rectangles', () => {
  const c = corpus().find(c => c.id === 'random-dag-12-7223')!, focus = 'n6';
  const commit = (request: Parameters<typeof layoutGraph>[0]) => {
    const layout = layoutGraph(request);
    return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
  };
  const selected = commit({ ...requestFor(c, focus, 360, 96), history: commit(requestFor(c, null, 360, 96)) });
  const running = { ...c, nodes: [...c.nodes, node('placeholder', [focus], 1e6)] };
  const started = commit({ ...requestFor(running, focus, 360, 96), history: selected });
  const request = { ...requestFor(c, focus, 360, 96), history: started };
  const failed = commit(request);
  expect(geometryGate(failed.placed, request.items, 'root', 360)).toBeNull();
  for (const [key, now] of failed.placed.nodes) {
    const was = started.placed.nodes.get(key)!;
    expect([now.x, now.y, now.width, now.height], key).toEqual([was.x, was.y, was.width, request.items.find(n => n.key === key)!.height]);
  }
});
