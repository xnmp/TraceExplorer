import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { NO_EXPANSION, openStack, toggleNode } from '$lib/domain/trace-graph/expansion';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { corpusNode as node, folderInput, makeFolder } from './folder-layout-fixtures';

const recorded = [node('root'), node('Cerulean', ['root'], 1), node('Saffron', ['root'], 2), node('Pikachu', ['Cerulean'], 3), node('Blastoise', ['Saffron'], 4), node('Ash', ['Saffron'], 5), node('Charizard', ['Ash'], 6)];
const geometry = (layout: FolderLayout) => [...layout.graphs].map(([id, g]) => [id, [...g.attached.nodes], g.attached.routes, [...g.attached.junctions], g.origin]);

it('restores the recorded Saffron/Ash layout after collapse and reopen through the folder engine', () => {
  const folder = makeFolder({ stacks: [recorded] }), stack = folder.stacks.get('s0:root')!;
  const scope = { graph: stack.graph, members: stack.graph.dag.order, cover: stack.cover };
  const tile = tileMetrics(64), width = 900;
  const items = [...Array.from({ length: Math.floor(width / (tile.width + 8)) - 1 }, (_, i) => ({ id: `file${i}`, kind: 'file' as const })), { id: stack.cover, kind: 'stack' as const }];
  const engine = createDefaultEngine();
  let expansion = openStack(NO_EXPANSION, stack.cover), previous: FolderLayout | undefined;
  const commit = () => previous = engine({ ...folderInput(folder, { open: [stack.cover], expansion, previous, tile, width }), items });
  commit();
  for (const key of ['Cerulean', 'Saffron', 'Ash']) { expansion = toggleNode(expansion, scope, `s0:${key}`); commit(); }
  const before = geometry(previous!);
  expansion = toggleNode(expansion, scope, 's0:Saffron'); commit();
  expansion = toggleNode(expansion, scope, 's0:Saffron'); commit();
  expect(geometry(previous!)).toEqual(before);
});

it('pins every retained rectangle when the fourth sibling arrives without an anchor', () => {
  const nodes = [node('root'), ...[0, 1, 2].map(i => node(`a${i}`, ['root'], i + 1))];
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const input = (nodes: typeof recorded, previous?: FolderLayout) => folderInput(makeFolder({ stacks: [nodes] }), { open: ['s0:root'], width: 640, tile, previous });
  const before = engine(input(nodes)), after = engine(input([...nodes, node('a3', ['root'], 4)], before));
  for (const [key, rect] of before.graphs.get('s0:root')!.attached.nodes) {
    const next = after.graphs.get('s0:root')!.attached.nodes.get(key)!;
    expect([next.x, next.y, next.width, next.height], key).toEqual([rect.x, rect.y, rect.width, rect.height]);
  }
});

it('does not resize a leaf when its first output arrives', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(64);
  const nodes = [node('root'), node('leaf', ['root'], 1)];
  const input = (nodes: typeof recorded, previous?: FolderLayout) => folderInput(makeFolder({ stacks: [nodes] }), { open: ['s0:root'], width: 900, tile, previous });
  const before = engine(input(nodes)), after = engine(input([...nodes, node('output', ['leaf'], 2)], before));
  const rect = before.graphs.get('s0:root')!.attached.nodes.get('s0:leaf')!, next = after.graphs.get('s0:root')!.attached.nodes.get('s0:leaf')!;
  expect([next.x, next.y, next.width, next.height]).toEqual([rect.x, rect.y, rect.width, rect.height]);
});

import { corpus, rng } from '../../../layout-eval/corpus';
import { expandForOutputs } from '$lib/domain/trace-graph/expansion';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';

it('restores revisited states over seeded click walks on the corpus', () => {
  for (const fixture of corpus().filter(c => c.nodes.length > 2 && c.nodes.length <= 16).slice(0, 16)) {
    const folder = makeFolder({ stacks: [fixture.nodes] }), stack = [...folder.stacks.values()][0];
    const scope = { graph: stack.graph, members: stack.graph.dag.order, cover: stack.cover };
    const engine = createDefaultEngine(), random = rng(fixture.nodes.length * 137);
    let expansion = openStack(NO_EXPANSION, stack.cover), previous: FolderLayout | undefined;
    const seen = new Map<string, unknown>();
    for (let step = 0; step < 24; step++) {
      previous = engine(folderInput(folder, { open: [stack.cover], expansion, previous, width: 900, tile: tileMetrics(64) }));
      expect(folderGeometryGate(previous), `${fixture.id}/${step}`).toBeNull();
      const graph = previous.graphs.get(stack.cover)!;
      const state = JSON.stringify([...graph.attached.nodes.keys()].sort());
      const drawing = geometry(previous);
      if (seen.has(state)) expect(drawing, `${fixture.id}/${step}`).toEqual(seen.get(state));
      else seen.set(state, drawing);
      const choices = [...graph.plan.tiles].filter(([, t]) => t.togglable).map(([key]) => key);
      if (!choices.length) break;
      expansion = toggleNode(expansion, scope, choices[Math.floor(random() * choices.length)]);
    }
  }
}, 30000);

it('pins retained rectangles through seeded output arrivals and checks every result', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const random = rng(seed), engine = createDefaultEngine();
    const nodes = [node('root')];
    let expansion = openStack(NO_EXPANSION, 's0:root'), previous: FolderLayout | undefined;
    const commit = () => {
      const folder = makeFolder({ stacks: [nodes] });
      const result = engine(folderInput(folder, { open: ['s0:root'], expansion, previous, width: 640, tile: tileMetrics(64) }));
      expect(folderGeometryGate(result), `seed ${seed}, size ${nodes.length}`).toBeNull();
      return { folder, result };
    };
    previous = commit().result;
    for (let i = 1; i <= 8; i++) {
      const parent = nodes[Math.floor(random() * nodes.length)].key;
      const folder = makeFolder({ stacks: [nodes] }), stack = folder.stacks.get('s0:root')!;
      expansion = expandForOutputs(expansion, { graph: stack.graph, members: stack.graph.dag.order, cover: stack.cover }, `s0:${parent}`);
      previous = commit().result;
      nodes.push(node(`n${i}`, [parent], i));
      const next = commit().result;
      for (const [key, rect] of previous.graphs.get('s0:root')!.attached.nodes) {
        const now = next.graphs.get('s0:root')!.attached.nodes.get(key)!;
        expect([now.x, now.y, now.width, now.height], `seed ${seed}, output ${i}, retained ${key}`).toEqual([rect.x, rect.y, rect.width, rect.height]);
      }
      previous = next;
    }
  }
}, 30000);

it('keeps a later grid row fixed when an earlier stack receives outputs', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const nodes = [node('root'), node('a', ['root'], 1)];
  const input = (nodes: typeof recorded, previous?: FolderLayout) => ({ ...folderInput(makeFolder({ stacks: [nodes], files: 1 }), { open: ['s0:root'], width: 200, tile, previous }), items: [{ id: 's0:root', kind: 'stack' as const }, { id: 'file', kind: 'file' as const }] });
  const before = engine(input(nodes)), after = engine(input([...nodes, node('b', ['root'], 2), node('c', ['root'], 3), node('d', ['root'], 4)], before));
  expect(after.cells.get('file')).toEqual(before.cells.get('file'));
  expect(folderGeometryGate(after)).toBeNull();
});

import { layoutGraph } from '$lib/domain/trace-graph/layout';
import { bandHistorySignature } from '$lib/domain/trace-graph/band-history';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { validHistory } from '$lib/domain/trace-graph/history-boundary';
import { requestFor } from '../../../layout-eval/corpus';
it('produces reusable history when a pinned extension exceeds the pane width', () => {
  const nodes = [node('root'), ...Array.from({length: 5}, (_,i) => node(`a${i}`, [i ? `a${i-1}` : 'root'], i+1))];
  let history: Parameters<typeof layoutGraph>[0]['history'];
  for (let size = 1; size <= nodes.length; size++) {
    const request = requestFor({id: 'extension', nodes: nodes.slice(0,size), focuses: [], full: true}, null, 454, 48);
    const layout = layoutGraph({...request, history});
    history = {signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout,request)};
    expect(validHistory(history, 'root'), `size ${size}`).toBe(true);
  }
});
