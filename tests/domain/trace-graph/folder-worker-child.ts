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
try {
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
