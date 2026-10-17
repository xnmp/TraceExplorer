import { expect, it } from 'vitest';
import { corpus, node, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph, type LayoutRequest } from '../../../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-history';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { projectDag, projectReferenceBadges } from '../../../src/lib/domain/trace-graph/projection';
import { planBandScene } from '../../../src/lib/domain/trace-graph/scene';
import { openStack, expandForOutputs, expandedKeys, expansionAnchor, NO_EXPANSION } from '../../../src/lib/domain/trace-graph/expansion';
import { tileMetrics } from '../../../src/lib/domain/trace-graph/metrics';
import { measure } from '../../../src/lib/domain/trace-graph/layout-quality';
import { contacts } from './contact-probe';

it('keeps unrelated corners separate during cumulative output arrival', () => {
  const topology: readonly (readonly [number, readonly number[]])[] = [[0, []], [1, [0]], [2, [1]], [3, [0]], [4, [0]], [5, [0, 2]], [6, [0]], [7, [3]], [9, [5]], [11, [9]], [15, [4]]];
  const nodes = topology.map(([i, ps]) => node(`n${i}`, ps.map(p => `n${p}`), i));
  let expansion = openStack(NO_EXPANSION, 'n0'), history: LayoutRequest['history'], prefix = nodes.slice(0, 1);
  const plan = () => {
    const graph = projectReferenceBadges(projectDag(prefix)), members = graph.dag.order, scope = { graph, members, cover: 'n0' };
    return { scope, request: planBandScene(graph, members, expansionAnchor(expansion, scope), 900, {
      pinned: { key: 'n0', x: 675 }, tile: tileMetrics(48), expanded: expandedKeys(expansion, scope), history,
    }).request };
  };
  const commit = () => {
    const { request } = plan(), layout = layoutGraph(request), placed = attachSingleBand(layout, request);
    expect(contacts(placed), `visible ${request.items.length}`).toEqual([]);
    history = { signature: bandHistorySignature(request), layout, placed };
  };
  commit();
  for (let size = 2; size <= nodes.length; size++) {
    for (const parent of nodes[size - 1].parents) expansion = expandForOutputs(expansion, plan().scope, parent);
    commit(); prefix = nodes.slice(0, size); commit();
  }
});

it('never returns the shared-lane fallback on the dense corpus witness', () => {
  const fixture = corpus().find(c => c.id === 'random-dag-100-8103')!;
  const request = requestFor(fixture, null, 900, 64);
  const layout = layoutGraph(request), placed = attachSingleBand(layout, request);
  const measured = measure(placed, request.band!.key, 900, request.items);
  expect(measured.sharedLanePx).toBe(0);
  expect(measured.tileIntersections).toBe(0);
  expect(measured.disconnectedEdges).toBe(0);
  expect(contacts(placed)).toEqual([]);
});

import { routeClearanceViolation } from '../../../src/lib/domain/trace-graph/geometry-gate';
it.each([
  ['M0 0 L40 0 C40 0 40 0 40 0 L40 -100', 'M140 0 L40 0 C40 0 40 0 40 0 L40 100'],
  ['M0 0 C50 100 150 100 200 0', 'M0 150 C50 50 150 50 200 150'],
])('rejects contact hidden between curve primitives', (a, b) => {
  const layout = { routes: [a, b].map((path, i) => ({ id: String(i), path, from: { kind: 'node', id: String(i) }, to: { kind: 'node', id: String(i) }, consumers: [], terminal: false })), junctions: new Map() };
  expect(routeClearanceViolation(layout as never)).toBe('route-contact');
});

import { createDefaultEngine } from '../../../src/lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '../../../src/lib/domain/trace-graph/folder-layout/geometry-gate';
import { folderInput, makeFolder } from './folder-layout-fixtures';
it('certifies complete attached folders with several open bands', () => {
  const engine = createDefaultEngine();
  const nodes = [node('root'), node('a', ['root'], 1), node('b', ['root'], 2), node('merge', ['a', 'b'], 3)];
  for (const width of [360, 640, 900]) {
    const folder = makeFolder({ stacks: [nodes, nodes, nodes], files: 2 });
    const result = engine(folderInput(folder, { open: folder.stacks.keys(), width }));
    expect(folderGeometryGate(result), String(width)).toBeNull();
  }
});

it('rejects a zero-chord cubic with a nonzero excursion', () => {
  const layout = { nodes: new Map(), junctions: new Map(), routes: [{id:'r', from:{kind:'node',id:'a'}, to:{kind:'node',id:'b'}, terminal:false, consumers:[], path:'M0 0 L10 0 C10 .02 10 .02 10 0 L20 0'}] };
  expect(routeClearanceViolation(layout as never)).toBe('invalid-path');
});
