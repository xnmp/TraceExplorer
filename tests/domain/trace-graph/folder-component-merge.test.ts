import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { projectDag, projectReferenceBadges } from '$lib/domain/trace-graph/projection';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { corpusNode as node, makeFolder, folderInput } from './folder-layout-fixtures';

const rectangles = (layout: FolderLayout) => new Map([
  ...[...layout.cells].map(([key, cell]) => {
    const n = layout.cellFootprints?.get(key) ?? cell;
    return [key, [n.x, n.y, n.width, n.height]] as const;
  }),
  ...[...layout.graphs.values()].flatMap(g => [...g.attached.nodes].map(([key, n]) =>
    [key, [n.x + g.origin.x, n.y + g.origin.y, n.width, n.height]] as const)),
]);

it.each([true, false])('keeps displayed tiles fixed when an output merges components (absorbed open: %s)', absorbedOpen => {
  const folder = makeFolder({ stacks: [
    [node('root'), node('a', ['root'], 1)],
    [node('root', [], 2), node('b', ['root'], 3)],
  ] });
  const engine = createDefaultEngine();
  const initial = folderInput(folder, { open: absorbedOpen ? [...folder.stacks.keys()] : ['s0:root'], width: 640 });
  const before = engine(initial);
  const nodes = [...folder.stacks.values()].flatMap(s => s.nodes);
  const graph = projectReferenceBadges(projectDag([...nodes, node('merged', ['s0:a', 's1:b'], 4)]));
  const request = { ...initial, previous: before,
    items: initial.items.filter(i => i.id !== 's1:root'),
    open: new Map([['s0:root', { id: 's0:root', graph, members: graph.dag.order, anchor: null,
      expanded: new Map(graph.dag.order.map(k => [k, true])) }]]) };
  const after = engine(request);
  expect(createDefaultEngine()(structuredClone(request))).toEqual(after);
  expect(folderGeometryGate(after)).toBeNull();
  const old = rectangles(before), now = rectangles(after);
  for (const [key, rect] of old) expect(now.get(key), key).toEqual(rect);
  const revisited = createDefaultEngine()({ ...request, previous: structuredClone(after) });
  expect(revisited.revisited).toBe(true);
  expect(rectangles(revisited)).toEqual(now);
});

it('reports exhaustion if an edge-only merge cannot retain its drawing', () => {
  const folder = makeFolder({ stacks: [
    [node('root'), node('a', ['root'], 1)],
    [node('root', [], 2), node('b', ['root'], 3)],
  ] });
  const engine = createDefaultEngine();
  const input = folderInput(folder, { open: [...folder.stacks.keys()], width: 640 });
  const before = engine(input);
  const nodes = [...folder.stacks.values()].flatMap(stack => stack.nodes).map(n =>
    n.key === 's1:b' ? { ...n, parents: [...n.parents, 's0:a'] } : n);
  const graph = projectReferenceBadges(projectDag(nodes));
  const after = engine({ ...input, previous: before, items: input.items.filter(item => item.id !== 's1:root'),
    open: new Map([['s0:root', { id: 's0:root', graph, members: graph.dag.order, anchor: null,
      expanded: new Map(graph.dag.order.map(key => [key, true])) }]]) });
  expect(folderGeometryGate(after)).toBeNull();
  const now = rectangles(after);
  const moved = [...rectangles(before)].some(([key, rect]) => JSON.stringify(now.get(key)) !== JSON.stringify(rect));
  if (moved) expect(after.decision?.pinning).toBe('search-exhausted');
});
