/** Static packing plus legal reveals using actual committed grid attachments. */
delete process.env.OPENAI_API_KEY;
import { mkdir, writeFile } from 'node:fs/promises';
import * as baseline from './baseline/band-geometry';
import * as production from '../src/lib/domain/trace-graph/band-geometry';
import { layoutGraph as baselineLayout } from './baseline/layout';
import { layoutGraph, type GraphLayout, type LayoutRequest, type BandHistory } from '../src/lib/domain/trace-graph/layout';
import { bandHistorySignature } from '../src/lib/domain/trace-graph/band-layout';
import { tileMetrics, tileSize } from '../src/lib/domain/trace-graph/metrics';
import { handCases, requestFor, screenshot, type Case } from './corpus';
import { measure } from './geometry';
const rows: any[] = [];
const prefix = (c: Case, i: number): Case => ({ ...c, nodes: c.nodes.map(n => ({ ...n, key: `g${i}:${n.key}`, parents: n.parents.map(p => `g${i}:${p}`) })) });
for (const width of [360, 454, 640, 900, 1400]) for (const imagePx of [48, 64, 96, 128]) for (const engine of ['baseline', 'proposed']) {
  const tile = tileMetrics(imagePx), columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16))), gridWidth = columns * tile.width + (columns - 1) * 16;
  const coverHeight = tileSize({ foreign: false, hint: true }, tile).height;
  const geometry = engine === 'baseline' ? baseline : production;
  const pack = (requests: LayoutRequest[], layouts: GraphLayout[]) => {
    const items = requests.map(r => ({ id: r.band!.key, kind: 'stack' as const }));
    const flow = geometry.packedGridFlow(items, new Map(layouts.map((l, i) => [items[i].id, geometry.bandExtent(l, items[i].id)])), columns, { cellWidth: tile.width, cellHeight: coverHeight, columnGap: 16, rowGap: 16 });
    const placements = geometry.bandPlacements(flow, coverHeight);
    const placed = layouts.map((l, i) => geometry.attachPackedBand(l, items[i].id, flow.bands.find(b => b.id === items[i].id)!.y, placements.get(items[i].id)!));
    const combined: GraphLayout = { orientation: 'down', width: flow.width, height: flow.height, nodes: new Map(placed.flatMap(l => [...l.nodes])), routes: placed.flatMap(l => l.routes), junctions: new Map(placed.flatMap(l => [...l.junctions])), rows: [], readingOrder: new Map() };
    return { flow, placements, placed, metrics: measure(combined, 'no-cover', gridWidth, requests.flatMap(r => r.items)) };
  };
  const pin = (r: LayoutRequest, i: number): LayoutRequest => ({ ...r, pinned: { ...r.pinned!, x: i * (tile.width + 16) + tile.width / 2 } });
  try {
    const fixtures = ['screenshot', 'chain-20', 'merges-3', 'fan-8'].slice(0, columns).map((id, i) => prefix(handCases.find(c => c.id === id)!, i));
    const requests = fixtures.map((c, i) => pin(requestFor(c, c.id === 'chain-20' ? `g${i}:n19` : c.id === 'screenshot' ? `g${i}:Saffron` : null, gridWidth, imagePx), i));
    const layouts = requests.map(engine === 'baseline' ? baselineLayout : layoutGraph);
    const packed = pack(requests, layouts);
    rows.push({ width, imagePx, engine, kind: 'static', groups: fixtures.length, rowHeight: packed.flow.rowBands[0]?.height ?? 0, metrics: packed.metrics });
    const tour = Array.from({ length: Math.min(2, columns) }, (_, i) => prefix(screenshot, i));
    let histories: (BandHistory | undefined)[] = [], previous: GraphLayout[] | undefined;
    const active = tour.length - 1;
    for (const [step, name] of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null].entries()) {
      const focus = name ? `g${active}:${name}` : null;
      if (focus && previous && !previous[active].nodes.has(focus)) throw new Error('packing tour selected an unavailable tile');
      const rs = tour.map((c, i) => pin(requestFor(c, i === active ? focus : null, gridWidth, imagePx), i));
      const ls = rs.map((r, i) => engine === 'baseline' ? baselineLayout(r) : layoutGraph({ ...r, history: histories[i] }));
      const scene = pack(rs, ls);
      const a = focus && previous?.[active].nodes.get(focus), b = focus && scene.placed[active].nodes.get(focus);
      const clickDisplacement = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
      rows.push({ width, imagePx, engine, kind: 'tour', step, focus, groups: tour.length, rowHeight: scene.flow.rowBands[0]?.height ?? 0, metrics: scene.metrics, clickDisplacement, decision: scene.placed[active].decision });
      histories = rs.map((r, i) => ({ signature: bandHistorySignature(r), layout: ls[i], placed: scene.placed[i], attachment: { bandTop: scene.flow.bands.find(b => b.id === r.band!.key)!.y, placement: scene.placements.get(r.band!.key)! } }));
      previous = scene.placed;
    }
  } catch (e) { rows.push({ width, imagePx, engine, error: String(e) }); }
}
await mkdir('layout-eval/out', { recursive: true });
await writeFile('layout-eval/out/packing.json', JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ scenarios: rows.length, baseline: rows.filter(r => r.engine === 'baseline').length, proposed: rows.filter(r => r.engine === 'proposed').length, errors: rows.filter(r => r.error) }, null, 2));
