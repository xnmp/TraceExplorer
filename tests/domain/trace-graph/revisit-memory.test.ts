import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { NO_EXPANSION, openStack, toggleNode } from '$lib/domain/trace-graph/expansion';
import { folderInput, makeFolder, handCase } from './folder-layout-fixtures';

it('builds a new expansion from the displayed drawing and click anchor', () => {
  const folder = makeFolder({ stacks: [handCase('screenshot')] }), stack = folder.stacks.get('s0:root')!;
  const scope = { graph: stack.graph, members: stack.graph.dag.order, cover: stack.cover };
  const engine = createDefaultEngine();
  const expansion = openStack(NO_EXPANSION, stack.cover);
  const before = engine(folderInput(folder, { open: [stack.cover], expansion }));
  const after = engine(folderInput(folder, { open: [stack.cover], previous: before, expansion: toggleNode(expansion, scope, 's0:Saffron') }));
  const request = after.graphs.get(stack.cover)!.plan.request;
  expect(request.anchorKey).toBe('s0:Saffron');
  expect(request.history?.placed).toEqual(before.graphs.get(stack.cover)!.attached);
});

import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { corpusNode as node } from './folder-layout-fixtures';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
const drawing = (layout: FolderLayout) => ({ cells: layout.cells, bands: layout.bands, rowBands: layout.rowBands,
  size: layout.size, bounds: layout.bounds, graphs: [...layout.graphs].map(([id,g]) => [id,g.attached,g.origin,g.placement]) });

it('keys revisits by pane width, tile and grid metrics, and folder identity', () => {
  const folder = makeFolder({ stacks: [handCase('screenshot')] }), engine = createDefaultEngine();
  const input = folderInput(folder, { open: ['s0:root'], focus: 's0:Saffron', width: 900 });
  const before = engine({ ...input, folderKey: '/first' });
  for (const changed of [{ width: 360 }, { tile: tileMetrics(128) }, { grid: { ...input.grid, cellHeight: 200 } }, { folderKey: '/second' }]) {
    const after = engine({ ...input, folderKey: '/first', ...changed, previous: before });
    const cold = engine({ ...input, folderKey: '/first', ...changed });
    if ('folderKey' in changed) expect(after.displays!.entries).toHaveLength(1);
    else expect(drawing(after), JSON.stringify(changed)).not.toEqual(drawing(before));
    expect(folderGeometryGate(after)).toBeNull();
    expect(after.geometryBasis).toEqual(cold.geometryBasis);
    const returned = engine({ ...input, folderKey: '/first', previous: after });
    if (!('folderKey' in changed)) expect(drawing(returned)).toEqual(drawing(before));
  }
});

it.each(['arrival', 'removal'] as const)('forgets every old state on %s and pins the surviving rectangles', change => {
  const nodes = [node('root'), node('a',['root'],1), node('b',['root'],2), node('c',['a'],3)];
  const engine = createDefaultEngine();
  const run = (nodes: typeof nodes, focus: string | null, previous?: FolderLayout) =>
    engine(folderInput(makeFolder({ stacks: [nodes] }), { open:['s0:root'], focus, previous }));
  const first = run(nodes, null), before = run(nodes, 's0:a', first);
  const changed = change === 'arrival' ? [...nodes, node('d',['a'],4)] : nodes.filter(n => n.key !== 'b');
  const after = run(changed, 's0:a', before);
  expect(after.displays!.entries).toHaveLength(1);
  for (const [key, n] of before.graphs.get('s0:root')!.attached.nodes) {
    const next = after.graphs.get('s0:root')!.attached.nodes.get(key);
    if (next) expect([next.x,next.y,next.width,next.height]).toEqual([n.x,n.y,n.width,n.height]);
  }
  const revisit = run(changed, null, after);
  expect(revisit.displays!.entries).toHaveLength(2);
  expect(revisit.graphs.get('s0:root')!.plan.request.band!.items.map(n=>n.key)).toEqual(changed.map(n=>'s0:'+n.key));
});

it('bounds history at 64 states and never aliases mutable displayed geometry', () => {
  const folder = makeFolder({ stacks: [handCase('screenshot')] }), engine = createDefaultEngine();
  const input = folderInput(folder, { open:['s0:root'], focus:'s0:Saffron' });
  let previous: FolderLayout | undefined;
  for (let width=900; width<967; width++) previous = engine({...input, width, previous});
  expect(previous!.displays!.entries).toHaveLength(64);
  const saved = drawing(previous!), copy = structuredClone(saved);
  const other = engine({...input, width:967, previous});
  const g = previous!.graphs.get('s0:root')!;
  (g.attached.nodes as Map<string, unknown>).clear();
  const restored = engine({...input,width:966,previous:other});
  expect(drawing(restored)).toEqual(copy);
});

import { createBoundedCache, estimateLayoutBytes, rememberBands } from '$lib/domain/trace-graph/folder-layout';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';
it('never seeds a cold band request with geometry restored from a different click history', () => {
  const folder = makeFolder({stacks:[handCase('screenshot')]}), engine=createDefaultEngine();
  let previous: FolderLayout | undefined;
  for (const focus of [null,'s0:Saffron','s0:Ash']) previous=engine(folderInput(folder,{open:['s0:root'],focus,previous}));
  previous=engine(folderInput(folder,{open:[],previous}));
  const restored=engine(folderInput(folder,{open:['s0:root'],focus:'s0:Ash',previous}));
  const cache=createBoundedCache<GraphLayout>(estimateLayoutBytes);
  rememberBands(restored,cache);
  const cold=folderInput(folder,{open:['s0:root'],focus:'s0:Ash'});
  expect(createDefaultEngine({bandCache:cache})(cold)).toEqual(createDefaultEngine({bandCache:null})(cold));
});
it('rejects malformed memory descriptors and valid JSON containing invalid geometry', () => {
  const input=folderInput(makeFolder({stacks:[handCase('screenshot')]}),{open:['s0:root']}),engine=createDefaultEngine();
  const before=engine(input);
  for (const displays of [{folder:''},{...before.displays,entries:null},
    {...before.displays,entries:[[before.displays!.entries[0][0],'[["ref",0],[["object",[]]]]']]},
    {...before.displays,entries:[[before.displays!.entries[0][0],'[1,[]]']]}]) {
    const result=engine({...input,previous:{...before,displays} as FolderLayout});
    expect(folderGeometryGate(result)).toBeNull();
    expect(drawing(result).cells).toEqual(drawing(before).cells);
  }
});

