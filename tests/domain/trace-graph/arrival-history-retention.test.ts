import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { CACHE_ENTRIES, CACHE_BYTES } from '$lib/domain/trace-graph/folder-layout/bounded-cache';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { node } from '../../../layout-eval/corpus';
import { folderInput, makeFolder } from './folder-layout-fixtures';

it('discards arrival histories for components removed from the folder', () => {
  const engine = createDefaultEngine();
  let previous: FolderLayout | undefined;
  for (let i = 0; i < 70; i++) {
    for (const arrived of [false, true]) {
      const nodes = [node(`root${i}`), node(`a${i}`, [`root${i}`], 1), ...(arrived ? [node(`b${i}`, [`root${i}`], 2)] : [])];
      const input = folderInput(makeFolder({ stacks: [nodes] }), { open: [`s0:root${i}`], previous });
      previous = engine({ ...input, folderKey: '/same-folder' });
    }
    previous = engine({ ...folderInput(makeFolder({ stacks: [] }), { previous }), folderKey: '/same-folder' });
  }
  expect(previous!.arrivals!.size).toBe(0);
});

it('bounds histories even when all components remain in the folder', () => {
  const folder = makeFolder({ stacks: Array.from({ length: CACHE_ENTRIES + 10 }, (_, i) => [node(`root${i}`)]) });
  const engine = createDefaultEngine();
  const before = engine(folderInput(folder, { open: [...folder.stacks.keys()] }));
  expect(before.arrivals!.size).toBeLessThanOrEqual(CACHE_ENTRIES);
  const id = [...folder.stacks.keys()][0];
  const oversized = { ...before, arrivals: new Map([[id, { contents: 'x'.repeat(CACHE_BYTES) }]]) };
  const closed = engine(folderInput(folder, { previous: oversized }));
  expect(closed.arrivals!.has(id)).toBe(false);
});

it('pins arrivals even after their component ledger entry was evicted', () => {
  const engine = createDefaultEngine();
  const initial = [node('root'), node('a', ['root'], 1), node('b', ['root'], 2)];
  const input = (nodes: typeof initial, previous?: FolderLayout) => {
    const folder = makeFolder({ stacks: [nodes, [node('root'), node('child', ['root'], 1)]], files: 1 });
    const base = folderInput(folder, { open: ['s0:root', 's1:root'], width: 200, tile: tileMetrics(96), previous });
    return { ...base, open: new Map([...base.open].map(([id, stack]) =>
      [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
  };
  const before = engine(input(initial));
  const after = engine(input([...initial, node('c', ['a', 'b'], 3)], { ...before, arrivals: new Map() }));
  expect(after.cells).toEqual(before.cells);
  for (const [id, graph] of before.graphs) for (const [key, node] of graph.attached.nodes) {
    const current = after.graphs.get(id)!;
    const now = current.attached.nodes.get(key)!;
    expect([now.x + current.origin.x, now.y + current.origin.y, now.width, now.height]).toEqual(
      [node.x + graph.origin.x, node.y + graph.origin.y, node.width, node.height]);
  }
});
