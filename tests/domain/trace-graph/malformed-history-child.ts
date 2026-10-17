// A separate process bounds synchronous layout regressions, including non-advancing numeric loops.
import { deepStrictEqual, equal } from 'node:assert/strict';
import { layoutGraph, type GraphLayout, type LayoutRequest } from '../../../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../../../src/lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { sharedLaneLength } from '../../../src/lib/domain/trace-graph/layout-quality';
import { incrementalTree } from '../../../src/lib/domain/trace-graph/band-incremental';
import { createDefaultEngine } from '../../../src/lib/domain/trace-graph/folder-layout/default-engine';
import { folderInput, makeFolder } from './folder-layout-fixtures';
import { node } from '../../../layout-eval/corpus';

const geometry = (layout: GraphLayout) => ({ ...layout, decision: undefined });
const [mode, path] = process.argv.slice(2);
const attachmentField = path.startsWith('attachment:') ? path.slice('attachment:'.length) : null;
const corrupt = (graph: GraphLayout): GraphLayout => attachmentField ? graph : ({ ...graph, routes: graph.routes.map(route => ({ ...route, path })) });
if (mode === 'validation') {
  const routes = Array.from({ length: 65 }, (_, i) => ({ id: String(i), from: { kind: 'node' as const, id: String(i) }, to: { kind: 'node' as const, id: 'target' }, consumers: [], terminal: false, path }));
  const layout: GraphLayout = { orientation: 'down', width: 1e21, height: 1e21, nodes: new Map(), junctions: new Map(), rows: [], readingOrder: new Map(), routes };
  equal(sharedLaneLength(layout), 65 * 64 / 2 * 100);
} else if (mode === 'folder') {
  const input = (grown: boolean) => folderInput(makeFolder({ stacks: [[node('root'), node('a', ['root'], 1), ...(grown ? [node('b', ['a'], 2)] : [])]] }), {
    open: ['s0:root'], width: 640,
    expansion: { choices: new Map([['s0:root', true], ['s0:a', true]]), reveals: [] },
  });
  const before = createDefaultEngine()(input(false)), graph = before.graphs.get('s0:root')!;
  const previous = { ...before, graphs: new Map([['s0:root', { ...graph, layout: corrupt(graph.layout), attached: corrupt(graph.attached), placement: attachmentField ? { ...graph.placement, [attachmentField]: 1e20 } : graph.placement }]]) };
  const result = createDefaultEngine()({ ...input(true), previous });
  const fresh = createDefaultEngine()(input(true));
  deepStrictEqual(geometry(result.graphs.get('s0:root')!.layout), geometry(fresh.graphs.get('s0:root')!.layout));
  equal(result.graphs.get('s0:root')!.layout.decision?.fallback, 'invalid-history');
  deepStrictEqual(geometry(result.graphs.get('s0:root')!.attached), geometry(fresh.graphs.get('s0:root')!.attached));
} else {
  const items = [
    { key: 'root', parents: [], width: 92, height: 116, order: 0 },
    { key: 'a', parents: ['root'], width: 92, height: 116, order: 1 },
  ];
  const before: LayoutRequest = { items, maxWidth: 640, tileWidth: 92, pinned: { key: 'root', x: 300 }, band: { key: 'root', items } };
  const layout = layoutGraph(before), placed = attachSingleBand(layout, before);
  const grown = [...items, { key: 'b', parents: ['a'], width: 92, height: 100, order: 2 }];
  const request = { ...before, items: grown, band: { key: 'root', items: grown }, anchorKey: 'a' };
  if (mode === 'incremental') equal(incrementalTree(request, corrupt(placed)), null);
  else deepStrictEqual(geometry(layoutGraph({ ...request, history: { signature: bandHistorySignature(before), layout: corrupt(layout), placed: corrupt(placed), ...(attachmentField ? { attachment: { bandTop: 116, placement: { x: 0, coverX: 300, coverHeight: 116, width: 640, left: 0, right: 640, [attachmentField]: 1e20 } } } : {}) } })), geometry(layoutGraph(request)));
}
console.log('fresh geometry');
