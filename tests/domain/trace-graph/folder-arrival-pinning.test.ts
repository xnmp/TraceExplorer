import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { corpusNode as node, folderInput, makeFolder } from './folder-layout-fixtures';

const rectangles = (layout: FolderLayout) => new Map([
  ...[...layout.cells].map(([id, n]) => [`cell:${id}`, [n.x, n.y, n.width, n.height]] as const),
  ...[...layout.graphs].flatMap(([id, graph]) => [...graph.attached.nodes].map(([key, n]) =>
    [`graph:${id}/${key}`, [n.x + graph.origin.x, n.y + graph.origin.y, n.width, n.height]] as const)),
]);

it.each([
  ['an output beside a neighbouring band', 640, [node('root'), node('a', ['root'], 1)], node('b', ['a'], 2)],
  ['a merge above later grid rows', 200, [node('root'), node('a', ['root'], 1), node('b', ['root'], 2)], node('c', ['a', 'b'], 3)],
] as const)('pins every folder rectangle on arrival of %s', (_name, width, initial, output) => {
  const engine = createDefaultEngine();
  const input = (nodes: readonly ReturnType<typeof node>[], previous?: FolderLayout) => {
    const folder = makeFolder({ stacks: [nodes, [node('root'), node('child', ['root'], 1)]], files: 1 });
    const input = folderInput(folder, { open: ['s0:root', 's1:root'], width, tile: tileMetrics(96), previous });
    return { ...input, open: new Map([...input.open].map(([id, stack]) =>
      [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
  };
  const before = engine(input(initial)), after = engine(input([...initial, output], before));
  const now = rectangles(after);
  for (const [key, rect] of rectangles(before)) expect(now.get(key), key).toEqual(rect);
  expect(folderGeometryGate(after)).toBeNull();

  const fromClone = createDefaultEngine()(input([...initial, output], structuredClone(before)));
  expect(rectangles(fromClone)).toEqual(now);
  expect([...fromClone.graphs].map(([id, g]) => [id, g.attached.routes])).toEqual([...after.graphs].map(([id, g]) => [id, g.attached.routes]));

  const expanded = input([...initial, output], after), open = new Map(expanded.open);
  const stack = open.get('s0:root')!;
  open.set('s0:root', { ...stack, expanded: new Map([['s0:root', false]]) });
  const collapsed = engine({ ...expanded, open });
  const restored = engine(input([...initial, output], collapsed));
  expect(rectangles(restored)).toEqual(now);
  expect([...restored.graphs].map(([id, g]) => [id, g.attached.routes])).toEqual([...after.graphs].map(([id, g]) => [id, g.attached.routes]));
  expect(folderGeometryGate(restored)).toBeNull();

  const next = engine(input([...initial, output, node('next', [output.key], output.order + 1)], restored));
  const nextRects = rectangles(next);
  for (const [key, rect] of now) expect(nextRects.get(key), `second arrival: ${key}`).toEqual(rect);
  expect(folderGeometryGate(next)).toBeNull();
});

it('appends new ordinary files without repacking the retained folder', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const folder = makeFolder({ stacks: [[node('root'), node('a', ['root'], 1)]], files: 2 });
  const input = folderInput(folder, { open: ['s0:root'], width: 200, tile });
  const before = engine(input);
  const nextInput = { ...input, items: [{ id: 'new-file', kind: 'file' as const }, ...input.items], previous: before };
  const after = engine(nextInput), now = rectangles(after);
  for (const [key, rect] of rectangles(before)) expect(now.get(key), key).toEqual(rect);
  expect(after.cells.has('new-file')).toBe(true);
  expect(folderGeometryGate(after)).toBeNull();
  expect(rectangles(createDefaultEngine()(structuredClone(nextInput)))).toEqual(now);
});

it('seeds a newly arrived disconnected root before routing its joining output', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const nodes = [node('root'), node('a', ['root'], 1)];
  const input = (members: typeof nodes, previous?: FolderLayout) => {
    const folder = makeFolder({ stacks: [members], files: 1 });
    const input = folderInput(folder, { open: ['s0:root'], width: 200, tile, previous });
    return { ...input, open: new Map([...input.open].map(([id, stack]) =>
      [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
  };
  const before = engine(input(nodes)), after = engine(input([...nodes, node('r2', [], 2), node('join', ['a', 'r2'], 3)], before));
  const now = rectangles(after);
  for (const [key, rect] of rectangles(before)) expect(now.get(key), key).toEqual(rect);
  expect(after.graphs.get('s0:root')!.attached.nodes.has('s0:r2')).toBe(true);
  expect(after.graphs.get('s0:root')!.attached.nodes.has('s0:join')).toBe(true);
  expect(folderGeometryGate(after)).toBeNull();
});

it('routes a retained merge around a full-width cell boundary without widening the pane', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const initial=[node('root'),node('a',['root'],1),node('b',['root'],2)];
  const input=(members: typeof initial, previous?: FolderLayout) => {
    const folder=makeFolder({stacks:[members,[node('root'),node('child',['root'],1)]],files:1});
    const base=folderInput(folder,{open:['s0:root','s1:root'],width:200,tile,grid:{cellWidth:200,cellHeight:128,gap:8},previous});
    return {...base,open:new Map([...base.open].map(([id,stack])=>[id,{...stack,expanded:new Map(stack.members.map(key=>[key,true]))}]))};
  };
  const before=engine(input(initial)), after=engine(input([...initial,node('c',['a','b'],3)],before));
  expect(after.size.width).toBeLessThanOrEqual(200);
  for (const graph of after.graphs.values()) expect(graph.origin.x + graph.attached.width).toBeLessThanOrEqual(200);
  const now=rectangles(after);
  for(const [key,rect] of rectangles(before)) expect(now.get(key),key).toEqual(rect);
  expect(folderGeometryGate(after)).toBeNull();
});
