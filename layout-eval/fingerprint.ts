/**
 * Geometry fingerprints of the production engine: one hash per corpus case over every
 * layout the evaluation produces (broad sequences, legal tours, timing workloads, packing).
 * `bun layout-eval/fingerprint.ts --out=a.json`, change the engine, run again, then
 * `--compare=a.json`: performance work must leave every hash unchanged. No timing.
 */
delete process.env.OPENAI_API_KEY;
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { layoutGraph as baselineLayout, type GraphLayout as BaselineLayout } from './baseline/layout';
import { corpus, handCases, requestFor, screenshot, type Case } from './corpus';
import { optimizedBand, type Optimized } from './engine';
import * as production from '../src/lib/domain/trace-graph/band-geometry';
import { layoutGraph, type GraphLayout, type LayoutRequest, type BandHistory } from '../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../src/lib/domain/trace-graph/band-layout';
import { attachSingleBand } from '../src/lib/domain/trace-graph/band-geometry';
import { tileMetrics, tileSize } from '../src/lib/domain/trace-graph/metrics';

const serial = (value: unknown): unknown => value instanceof Map ? [...value].map(([k, v]) => [k, serial(v)])
  : Array.isArray(value) ? value.map(serial)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serial(v)])) : value;
const text = (layout: GraphLayout | undefined, error?: unknown) => error !== undefined ? `error:${String(error)}` : JSON.stringify(serial(layout));
const hashes = new Map<string, ReturnType<typeof createHash>>();
const add = (id: string, value: string) => { let h = hashes.get(id); if (!h) hashes.set(id, h = createHash('sha256')); h.update(value).update('\n'); };

// Broad sequences, exactly as bench.ts feeds the production engine.
for (const c of corpus()) for (const imagePx of [48, 64, 96, 128]) for (const width of [360, 454, 640, 900, 1400]) {
  let prevBaseline: BaselineLayout | undefined, prev: Optimized | undefined;
  for (const focus of c.focuses) {
    const request = requestFor(c, focus, width, imagePx, prevBaseline?.readingOrder);
    try { prevBaseline = baselineLayout(request); } catch { /* baseline errors only affect the next hint */ }
    try {
      const next = optimizedBand({ ...request, hint: prev?.layout.readingOrder }, { previous: prev, stability: 1.5, anchorKey: focus ?? undefined });
      add(c.id, text(next.layout)); add(c.id, text(next.placed)); prev = next;
    } catch (e) { add(c.id, text(undefined, e)); }
  }
}
// Legal click tours (reveals.ts).
for (const original of corpus()) for (const width of [360, 454, 640, 900, 1400]) {
  const c = { ...original, full: false }, visited = new Set<string>();
  let focus: string | null = null, baseline: BaselineLayout | undefined, proposed: Optimized | undefined;
  for (let step = 0; step < 9; step++) {
    const req = requestFor(c, focus, width, 96, baseline?.readingOrder);
    baseline = baselineLayout(req);
    proposed = optimizedBand({ ...req, hint: proposed?.layout.readingOrder }, { previous: proposed, anchorKey: focus ?? undefined });
    add(`${original.id} / tour`, text(proposed.layout)); add(`${original.id} / tour`, text(proposed.placed));
    const expandable = req.items.filter(n => !visited.has(n.key) && req.band!.items.some(child => child.parents.includes(n.key))).sort((a, b) => b.order - a.order || a.key.localeCompare(b.key));
    const selected = expandable[0];
    if (!selected) { if (focus === null) break; focus = null; } else { focus = selected.key; visited.add(focus); }
  }
}
// Timing workloads (perf.ts).
for (const original of corpus()) {
  const focus = original.id === 'screenshot' ? 'Saffron' : original.id === 'chain-200' ? 'n199' : original.focuses.findLast(f => f !== null) ?? null;
  const fixture = original.id.startsWith('random-') ? { ...original, full: true } : original;
  add(`${original.id} / perf`, text(layoutGraph(requestFor(fixture, focus, 454, 96))));
  const legal = { ...original, full: false }, before = requestFor(legal, null, 454, 96);
  const click = before.items.filter(n => n.key !== before.band!.key && before.band!.items.some(child => child.parents.includes(n.key)))
    .sort((a, b) => b.order - a.order || a.key.localeCompare(b.key))[0];
  if (!click) continue;
  const previous = layoutGraph(before), next = requestFor(legal, click.key, 454, 96);
  add(`${original.id} / perf`, text(layoutGraph({ ...next, hint: previous.readingOrder, anchorKey: click.key,
    history: { signature: bandHistorySignature(before), layout: previous, placed: attachSingleBand(previous, before) } })));
}
// Packing with attachment history (packing.ts, production engine only).
const prefix = (c: Case, i: number): Case => ({ ...c, nodes: c.nodes.map(n => ({ ...n, key: `g${i}:${n.key}`, parents: n.parents.map(p => `g${i}:${p}`) })) });
for (const width of [360, 454, 640, 900, 1400]) for (const imagePx of [48, 64, 96, 128]) {
  const id = 'packing', tile = tileMetrics(imagePx), columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16))), gridWidth = columns * tile.width + (columns - 1) * 16;
  const coverHeight = tileSize({ foreign: false, hint: true }, tile).height;
  const pack = (requests: LayoutRequest[], layouts: GraphLayout[]) => {
    const items = requests.map(r => ({ id: r.band!.key, kind: 'stack' as const }));
    const flow = production.packedGridFlow(items, new Map(layouts.map((l, i) => [items[i].id, production.bandExtent(l, items[i].id)])), columns, { cellWidth: tile.width, cellHeight: coverHeight, columnGap: 16, rowGap: 16 });
    const placements = production.bandPlacements(flow, coverHeight);
    const placed = layouts.map((l, i) => production.attachPackedBand(l, items[i].id, flow.bands.find(b => b.id === items[i].id)!.y, placements.get(items[i].id)!));
    return { flow, placements, placed };
  };
  const pin = (r: LayoutRequest, i: number): LayoutRequest => ({ ...r, pinned: { ...r.pinned!, x: i * (tile.width + 16) + tile.width / 2 } });
  try {
    const fixtures = ['screenshot', 'chain-20', 'merges-3', 'fan-8'].slice(0, columns).map((cid, i) => prefix(handCases.find(c => c.id === cid)!, i));
    const requests = fixtures.map((c, i) => pin(requestFor(c, c.id === 'chain-20' ? `g${i}:n19` : c.id === 'screenshot' ? `g${i}:Saffron` : null, gridWidth, imagePx), i));
    const layouts = requests.map(layoutGraph);
    pack(requests, layouts).placed.forEach(l => add(id, text(l)));
    const tour = Array.from({ length: Math.min(2, columns) }, (_, i) => prefix(screenshot, i));
    let histories: (BandHistory | undefined)[] = [];
    const active = tour.length - 1;
    for (const name of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null]) {
      const focus = name ? `g${active}:${name}` : null;
      const rs = tour.map((c, i) => pin(requestFor(c, i === active ? focus : null, gridWidth, imagePx), i));
      const ls = rs.map((r, i) => layoutGraph({ ...r, history: histories[i] }));
      const scene = pack(rs, ls);
      ls.forEach(l => add(id, text(l)));
      histories = rs.map((r, i) => ({ signature: bandHistorySignature(r), layout: ls[i], placed: scene.placed[i], attachment: { bandTop: scene.flow.bands.find(b => b.id === r.band!.key)!.y, placement: scene.placements.get(r.band!.key)! } }));
    }
  } catch (e) { add(id, text(undefined, e)); }
}

const result = Object.fromEntries([...hashes].map(([id, h]) => [id, h.digest('hex').slice(0, 16)]));
const outFile = process.argv.find(a => a.startsWith('--out='))?.slice(6);
const compare = process.argv.find(a => a.startsWith('--compare='))?.slice(10);
if (outFile) await writeFile(outFile, JSON.stringify(result, null, 2));
if (compare) {
  const expected: Record<string, string> = JSON.parse(await readFile(compare, 'utf8'));
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(result)])];
  const differing = keys.filter(k => expected[k] !== result[k]);
  console.log(`${keys.length} cases, ${differing.length} differ${differing.length ? `: ${differing.join(', ')}` : ''}`);
  if (differing.length) process.exitCode = 1;
} else console.log(`${Object.keys(result).length} case fingerprints`);
