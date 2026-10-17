// Exercise the real worker entry point, bounded by the parent test's process timeout.
import { deepStrictEqual, equal } from 'node:assert/strict';
import { createDefaultEngine } from '../../../src/lib/domain/trace-graph/folder-layout/default-engine';
import { createReplyLedger } from '../../../src/lib/plugins/trace/view/layout-protocol';
import { folderGeometryGate } from '../../../src/lib/domain/trace-graph/folder-layout/geometry-gate';
import { folderInput, makeFolder, handCase, corpusNode } from './folder-layout-fixtures';
import { tileMetrics } from '../../../src/lib/domain/trace-graph/metrics';
const worker = new Worker(new URL('../../../src/lib/plugins/trace/view/layout.worker.ts', import.meta.url).href);
const engine = createDefaultEngine({bandCache: null}), ledger = createReplyLedger();
let previous: any = null, sequence = 0;
const mode = process.argv[2];
import { NO_EXPANSION, openStack, toggleNode } from '../../../src/lib/domain/trace-graph/expansion';
import { corpus, rng } from '../../../layout-eval/corpus';
import { twoChainsMerge } from './folder-merge-fixture';
import { createFolderLayoutRuntime } from '../../../src/lib/plugins/trace/view/folder-layout-runtime';
import { buildFolderScene } from '../../../src/lib/domain/trace-graph/folder-scene';
import { staticPresentation } from '../../../src/lib/plugins/trace/view/presentation';
try {
  if (mode === 'merges') {
    const runtime = createFolderLayoutRuntime(), fixture = twoChainsMerge();
    for (const prepare of fixture.steps) {
      const { input, sources } = prepare(previous), inline = runtime.engine(structuredClone(input)), id = ++sequence;
      const message = ledger.message(id, input);
      if (id > 1) equal(message.previous, id - 1);
      const reply: any = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data); worker.onerror = reject;
        worker.postMessage(message);
      });
      if (reply.error) throw new Error(reply.error);
      deepStrictEqual(reply.folder, inline);
      for (const layout of [inline, reply.folder]) {
        equal(folderGeometryGate(layout), null);
        const scene = buildFolderScene({ scope: { paneId: 'merge', directory: '/pictures', generation: 1 },
          layoutInput: input, layout, sources,
          styling: { focus: 'o:11:0', selectedKeys: new Set(['o:11:0']), selectedPaths: new Set(), badgeHover: null } });
        equal(staticPresentation(scene).live.size, scene.records.size);
        equal(scene.graphs.size, [0, 1, 2, 2, 1][id - 1]);
      }
      ledger.replied(id, reply.folder); previous = reply.folder;
    }
    equal(previous.graphs.get('a:2').attached.nodes.has(fixture.joined), true);
  } else if (mode === 'revisits') {
    let revisits = 0;
    for (const fixture of corpus().filter(c => c.nodes.length > 2 && c.nodes.length <= 16).slice(0,16)) {
      const folder = makeFolder({stacks:[fixture.nodes]}), stack = [...folder.stacks.values()][0];
      const scope = {graph:stack.graph,members:stack.graph.dag.order,cover:stack.cover};
      let expansion = openStack(NO_EXPANSION,stack.cover);
      const seen = new Map<string,unknown>(), random = rng(fixture.nodes.length*137);
      previous = null;
      for (let step=0;step<48;step++) {
        const input = folderInput(folder,{open:[stack.cover],expansion,previous,width:900,tile:tileMetrics(64)});
        const inline = engine(structuredClone(input)), id = ++sequence;
        const reply: any = await new Promise((resolve,reject) => {
          worker.onmessage=e=>resolve(e.data); worker.onerror=reject;
          worker.postMessage(ledger.message(id,input));
        });
        if(reply.error) throw new Error(reply.error);
        deepStrictEqual(reply.folder,inline);
        equal(folderGeometryGate(inline),null);
        const graph = inline.graphs.get(stack.cover)!;
        const state = JSON.stringify([...graph.plan.tiles].map(([k,t])=>[k,t.expanded,t.togglable]));
        const drawing = [inline.cells,inline.bands,inline.rowBands,inline.size,inline.bounds,
          [...inline.graphs].map(([id,g])=>[id,g.attached,g.origin,g.placement])];
        if(seen.has(state)) { deepStrictEqual(drawing,seen.get(state)); revisits++; }
        else seen.set(state,structuredClone(drawing));
        ledger.replied(id,reply.folder); previous=reply.folder;
        const choices=[...graph.plan.tiles].filter(([,t])=>t.togglable).map(([k])=>k);
        if(!choices.length) break;
        expansion=toggleNode(expansion,scope,choices[Math.floor(random()*choices.length)]);
      }
    }
    if(revisits < 100) throw new Error(`Insufficient revisits: ${revisits}`);
  } else
  for (const width of [360, 640, 900, 1400]) for (const focus of [null, 's0:Saffron', 's0:Ash', 's0:Cerulean', null]) {
    const nodes = handCase('screenshot');
    if (sequence >= 10 && mode === 'arrivals') nodes.push(corpusNode('arrival', ['Ash'], 99));
    const folder = makeFolder({stacks: [nodes, handCase('merges-3'), handCase('chain-20')], files: 3, directories: 1});
    const open = mode === 'closing' && sequence % 3 === 1 ? ['s0:root'] : [...folder.stacks.keys()];
    const input = folderInput(folder, {open, focus, width, tile: tileMetrics(mode === 'small' ? 48 : 96), previous});
    const inline = engine(input), id = ++sequence;
    const reply: any = await new Promise((resolve, reject) => {
      worker.onmessage = event => resolve(event.data);
      worker.onerror = reject;
      worker.postMessage(ledger.message(id, input));
    });
    if (reply.error) throw new Error(reply.error);
    deepStrictEqual(reply.folder, inline);
    equal(folderGeometryGate(reply.folder), null);
    ledger.replied(id, reply.folder); previous = reply.folder;
  }
  console.log(sequence);
} finally { worker.terminate(); }
