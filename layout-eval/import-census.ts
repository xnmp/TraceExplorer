/** Lossless native-plan census of every proposed corpus, legal-tour and packing
 * state. Same populations/requests as bench.ts, reveals.ts and packing.ts; no
 * timing measurements and no changes to the acceptance populations. */
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { appendFileSync } from 'node:fs';
import { corpus, denseCorpus, handCases, requestFor, screenshot } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import { prefixCase, runEngine } from './packing-fixtures';
import { tileMetrics, tileSize } from '../src/lib/domain/trace-graph/metrics';
import type { GraphLayout } from '../src/lib/domain/trace-graph/layout';
import type { FolderLayout } from '../src/lib/domain/trace-graph/folder-layout';
import { geometryGate } from '../src/lib/domain/trace-graph/geometry-gate';
import { importRoutingPlan } from '../src/lib/domain/trace-graph/routing-plan';

const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const importer: typeof importRoutingPlan = option('importer') ? (await import(option('importer')!)).importRoutingPlan : importRoutingPlan;
const output = option('out') ?? 'layout-eval/out/import-census.json';
const digest = createHash('sha256');
const counts = Object.fromEntries(['corpus', 'tours', 'packing'].map(p => [p, { states: 0, drawings: 0, failures: 0 }]));
const failures: { population: string; state: string; graph: number; error: string }[] = [];
const census = (population: string, state: string, drawings: readonly GraphLayout[]) => {
  const count = counts[population]; count.states++;
  for (const [graph, drawing] of drawings.entries()) {
    count.drawings++;
    const nativeSnapshot=JSON.stringify([[...drawing.nodes],[...drawing.junctions],drawing.routes]);
    const routesSnapshot=JSON.stringify(drawing.routes),dotsSnapshot=JSON.stringify([...drawing.junctions.values()]);
    digest.update(JSON.stringify([population, state, graph, [...drawing.nodes], [...drawing.junctions], drawing.routes]));
    try {
      const plan = importer(drawing);
      assert.equal(JSON.stringify([[...drawing.nodes],[...drawing.junctions],drawing.routes]),nativeSnapshot,'import must not mutate any native pin');
      assert.equal(JSON.stringify(plan.paths.map(p=>p.route)),routesSnapshot,'route bytes, identities and consumer ranges');
      if(plan.junctions) assert.equal(JSON.stringify(plan.junctions),dotsSnapshot,'painted dots and historical declarations');
    } catch (error) {
      count.failures++; failures.push({ population, state, graph, error: String(error) });
      console.log('Import failure',population,state,graph,String(error));
      if(option('failed-drawings')) appendFileSync(option('failed-drawings')!,JSON.stringify({population,state,graph,drawing},(_key,value)=>value instanceof Map?{__map:[...value]}:value)+'\n');
    }
  }
};
for (const c of corpus()) for (const image of [48, 64, 96, 128]) for (const width of [360, 454, 640, 900, 1400]) {
  let previous: Optimized | undefined;
  for (const [step, focus] of c.focuses.entries()) {
    const request = requestFor(c, focus, width, image);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    assert.equal(geometryGate(next.placed, request.items, request.band!.key, width), null);
    census('corpus', `${c.id}/${width}/${image}/${step}/${focus}`, [next.placed]); previous = next;
  }
}
console.log('Corpus complete', counts.corpus);
for (const original of [...corpus(), ...denseCorpus()]) for (const width of [360, 454, 640, 900, 1400]) {
  const c = { ...original, full: false }, visited = new Set<string>();
  let focus: string | null = null, previous: Optimized | undefined;
  for (let step = 0; step < 9; step++) {
    const request = requestFor(c, focus, width, 96);
    if (focus) assert(previous?.placed.nodes.has(focus), 'tour click must already be visible');
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    assert.equal(geometryGate(next.placed, request.items, request.band!.key, width), null);
    census('tours', `${c.id}/${width}/96/${step}/${focus}`, [next.placed]); previous = next;
    const selected = request.items.filter(n => !visited.has(n.key) && request.band!.items.some(child => child.parents.includes(n.key)))
      .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
    if (!selected) { if (focus === null) break; focus = null; } else { focus = selected.key; visited.add(focus); }
  }
}
console.log('Tours complete', counts.tours);
for (const width of [360, 454, 640, 900, 1400]) for (const image of [48, 64, 96, 128]) {
  const tile = tileMetrics(image), columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16)));
  const gridWidth = columns * tile.width + (columns - 1) * 16, coverHeight = tileSize({ foreign: false, hint: true }, tile).height;
  const cases = ['screenshot', 'chain-20', 'merges-3', 'fan-8'].slice(0, columns).map((id, i) => prefixCase(handCases.find(c => c.id === id)!, i));
  const run = runEngine(cases, cases.map((c, i) => c.id === 'chain-20' ? `g${i}:n19` : c.id === 'screenshot' ? `g${i}:Saffron` : null), gridWidth, tile, coverHeight, null);
  assert.equal(run.independentFailure, null); census('packing', `${width}/${image}/static`, run.placed);
  const tour = Array.from({ length: Math.min(2, columns) }, (_, i) => prefixCase(screenshot, i));
  let previous: FolderLayout | null = null;
  for (const [step, name] of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null].entries()) {
    const focus = name ? `g${tour.length - 1}:${name}` : null;
    const next = runEngine(tour, tour.map((_, i) => i === tour.length - 1 ? focus : null), gridWidth, tile, coverHeight, previous);
    assert.equal(next.independentFailure, null); census('packing', `${width}/${image}/${step}/${focus}`, next.placed); previous = next.layout;
  }
}
assert.deepEqual(Object.values(counts).map(c => c.states), [6060, 3150, 140]);
const result = { counts, failures: failures.length, drawingDigest: digest.digest('hex'), details: failures };
await Bun.write(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, details: undefined }, null, 2));
if (failures.length && !process.argv.includes('--allow-failures')) process.exitCode = 1;
