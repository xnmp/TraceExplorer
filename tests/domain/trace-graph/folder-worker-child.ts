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
import { worldInput } from './folder-world-fixture';
import { readFileSync } from 'node:fs';
import { decode } from './routing-hint-next-click-codec';
import { profileLayout } from '../../../src/lib/domain/trace-graph/layout-profile';
try {
  if (mode === 'world-refresh') {
    const runtime = createFolderLayoutRuntime();
    for (let step = 0; step < 7; step++) {
      const input = worldInput(step > 0, previous, `save-${step}`);
      if (step === 6) (input.open as Map<string, unknown>).delete('s1:root');
      // Metadata refreshes keep the drawing inline. The arrival (step 1) and closing
      // another band (step 6) re-place the folder around retained world rectangles:
      // a bounded constrained search, which dispatch sends to the worker.
      equal(runtime.inline(input), step !== 1 && step !== 6);
      const inline = runtime.engine(structuredClone(input)), id = ++sequence;
      const reply: any = await new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data); worker.onerror = reject;
        worker.postMessage(ledger.message(id, input));
      });
      if (reply.error) throw new Error(reply.error);
      deepStrictEqual(reply.folder, inline);
      equal(folderGeometryGate(inline), null);
      equal(inline.size.width, input.width);
      if (step > 1 && step < 6) deepStrictEqual(inline.size, previous.size);
      runtime.remember(reply.folder);
      ledger.replied(id, reply.folder); previous = reply.folder;
    }
  } else if (mode === 'merges' || mode === 'routing-publication') {
    const runtime = createFolderLayoutRuntime(), fixture = twoChainsMerge(mode==='routing-publication');
    const saved = new Map<number,unknown>();
    const drawing = (layout:any) => [layout.cells,layout.bands,layout.rowBands,layout.size,layout.bounds,
      [...layout.graphs].map(([id,g]:any)=>[id,g.attached,g.origin,g.placement])];
    const rectangles = (layout:any):Map<string,any> => new Map([...layout.graphs.values()].flatMap((g:any)=>[...g.attached.nodes].map(([key,n]:any)=>[key,{...n,x:n.x+g.origin.x,y:n.y+g.origin.y}])));
    for (const [step,prepare] of fixture.steps.entries()) {
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
        equal(scene.graphs.size, [0,1,2,2,1,0,1,1,0,1][step]);
        if (step===6 || step===9) {
          equal(layout.revisited,true);
          deepStrictEqual(drawing(layout),saved.get(step===6?4:7));
        }
        if (step===7) {
          equal(layout.graphs.get('a:2').attached.nodes.has(fixture.arrived),true);
          for (const [key,before] of rectangles(previous)) {
            const after=rectangles(layout).get(key);
            if (!after) continue;
            equal(after.x,before.x, key+' arrival x');
            equal(after.y,before.y, key+' arrival y');
          }
        }
      }
      saved.set(step,structuredClone(drawing(inline)));
      runtime.remember(reply.folder);
      ledger.replied(id, reply.folder); previous = reply.folder;
    }
    equal(previous.graphs.get('a:2').attached.nodes.has(fixture.joined), true);
  } else if (mode === 'adoption') {
    // Constrained publication on the main thread and in the real worker: arrival,
    // the next click, then the exact revisit of the arrival state.
    let adopted = 0;
    for (const name of ['world-hint-1', 'world-hint-2', 'shrink-1', 'early-descent-1']) {
      const arrival = decode(readFileSync(new URL(`./fixtures/routing-adoption/${name}.json`, import.meta.url), 'utf8')).at(-1);
      const run = async (input: any) => {
        const { result: inline, profile } = profileLayout(() => engine(structuredClone(input)));
        adopted += Object.entries(profile.counters).filter(([k]) => /^adoption:.*:published$/.test(k)).reduce((n, [, v]) => n + v, 0);
        const id = ++sequence;
        const reply: any = await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data); worker.onerror = reject;
          worker.postMessage(ledger.message(id, input));
        });
        if (reply.error) throw new Error(reply.error);
        deepStrictEqual(reply.folder, inline);
        equal(folderGeometryGate(inline), null);
        ledger.replied(id, reply.folder);
        return reply.folder;
      };
      const published = await run(arrival);
      const clicked = await run({ ...arrival, previous: published, open: new Map([...arrival.open].map(([id, stack]: any) => [id,
        stack.members.includes('s0:p') ? { ...stack, anchor: 's0:p', expanded: new Map([...stack.expanded, ['s0:p', false]]) } : stack])) });
      const back = await run({ ...arrival, previous: clicked });
      equal(back.revisited, true);
      const drawing = (layout: any) => [layout.cells, layout.bands, layout.size, [...layout.graphs].map(([id, g]: any) => [id, g.attached, g.origin])];
      deepStrictEqual(drawing(back), drawing(published));
    }
    if (adopted < 4) throw new Error(`Constrained publication not exercised: ${adopted}`);
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
