/**
 * Static packing plus legal reveals using actual committed grid attachments. The baseline runs
 * the frozen grid pipeline; the candidate runs a registered folder layout engine through the
 * seam (`--engine=<name>`, default `default`), with the previous committed output as its history.
 */
delete process.env.OPENAI_API_KEY;
import { mkdir, writeFile } from 'node:fs/promises';
import * as baseline from './baseline/band-geometry';
import { layoutGraph as baselineLayout } from './baseline/layout';
import type { GraphLayout, LayoutRequest } from '../src/lib/domain/trace-graph/layout';
import { tileMetrics, tileSize, type TileMetrics } from '../src/lib/domain/trace-graph/metrics';
import { projectDag, projectReferenceBadges } from '../src/lib/domain/trace-graph/projection';
import { engines, type FolderLayout, type FolderLayoutEngine, type OpenStack } from '../src/lib/domain/trace-graph/folder-layout';
import { focusExpanded, handCases, requestFor, screenshot, type Case } from './corpus';
import { measure } from './geometry';
const engineName = process.argv.find(a => a.startsWith('--engine='))?.slice(9) ?? 'default';
const folderEngine: FolderLayoutEngine | undefined = engines[engineName];
if (!folderEngine) throw new Error(`unknown folder layout engine "${engineName}"; registered: ${Object.keys(engines).join(', ')}`);
/** The candidate engine's folder: one stack per case, each pinned in its own column of a grid exactly `gridWidth` wide. */
function runEngine(cases: readonly Case[], focuses: readonly (string | null)[], gridWidth: number, tile: TileMetrics, coverHeight: number, previous: FolderLayout | null) {
  const open = new Map<string, OpenStack>(cases.map((c, i) => {
    if (c.full) throw new Error(`${c.id}: full-lineage requests have no folder equivalent`);
    const graph = projectReferenceBadges(projectDag(c.nodes)), members = graph.dag.order;
    return [members[0], { id: members[0], graph, members, anchor: focuses[i], expanded: focusExpanded(graph, members, members[0], focuses[i]) }];
  }));
  const items = [...open.keys()].map(id => ({ id, kind: 'stack' as const }));
  const layout = folderEngine!({ items, open, width: gridWidth, tile, grid: { cellWidth: tile.width, cellHeight: coverHeight, gap: 16 }, previous });
  const ids = items.map(item => item.id), graphs = ids.map(id => layout.graphs.get(id)!);
  // The grid box, as the packed flow reports it: rows end at their last band, columns span the input width.
  const width = Math.max(gridWidth, ...layout.rowBands.map(b => b.x + b.width)), height = Math.max(0, ...[...layout.cells.values(), ...layout.rowBands].map(r => r.y + r.height));
  const placed = graphs.map(g => g.attached), requests = graphs.map(g => g.plan.request);
  const combined: GraphLayout = { orientation: 'down', width, height, nodes: new Map(placed.flatMap(l => [...l.nodes])), routes: placed.flatMap(l => l.routes), junctions: new Map(placed.flatMap(l => [...l.junctions])), rows: [], readingOrder: new Map() };
  return { layout, placed, rowHeight: layout.rowBands[0]?.height ?? 0, metrics: measure(combined, 'no-cover', gridWidth, requests.flatMap(r => r.items)) };
}
const rows: any[] = [];
const prefix = (c: Case, i: number): Case => ({ ...c, nodes: c.nodes.map(n => ({ ...n, key: `g${i}:${n.key}`, parents: n.parents.map(p => `g${i}:${p}`) })) });
for (const width of [360, 454, 640, 900, 1400]) for (const imagePx of [48, 64, 96, 128]) for (const engine of ['baseline', 'proposed']) {
  const tile = tileMetrics(imagePx), columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16))), gridWidth = columns * tile.width + (columns - 1) * 16;
  const coverHeight = tileSize({ foreign: false, hint: true }, tile).height;
  const pack = (requests: LayoutRequest[], layouts: GraphLayout[]) => {
    const items = requests.map(r => ({ id: r.band!.key, kind: 'stack' as const }));
    const flow = baseline.packedGridFlow(items, new Map(layouts.map((l, i) => [items[i].id, baseline.bandExtent(l, items[i].id)])), columns, { cellWidth: tile.width, cellHeight: coverHeight, columnGap: 16, rowGap: 16 });
    const placements = baseline.bandPlacements(flow, coverHeight);
    const placed = layouts.map((l, i) => baseline.attachPackedBand(l, items[i].id, flow.bands.find(b => b.id === items[i].id)!.y, placements.get(items[i].id)!));
    const combined: GraphLayout = { orientation: 'down', width: flow.width, height: flow.height, nodes: new Map(placed.flatMap(l => [...l.nodes])), routes: placed.flatMap(l => l.routes), junctions: new Map(placed.flatMap(l => [...l.junctions])), rows: [], readingOrder: new Map() };
    return { placed, rowHeight: flow.rowBands[0]?.height ?? 0, metrics: measure(combined, 'no-cover', gridWidth, requests.flatMap(r => r.items)) };
  };
  const pin = (r: LayoutRequest, i: number): LayoutRequest => ({ ...r, pinned: { ...r.pinned!, x: i * (tile.width + 16) + tile.width / 2 } });
  try {
    const fixtures = ['screenshot', 'chain-20', 'merges-3', 'fan-8'].slice(0, columns).map((id, i) => prefix(handCases.find(c => c.id === id)!, i));
    const focusOf = (c: Case, i: number) => c.id === 'chain-20' ? `g${i}:n19` : c.id === 'screenshot' ? `g${i}:Saffron` : null;
    if (engine === 'baseline') {
      const requests = fixtures.map((c, i) => pin(requestFor(c, focusOf(c, i), gridWidth, imagePx), i));
      const packed = pack(requests, requests.map(baselineLayout));
      rows.push({ width, imagePx, engine, kind: 'static', groups: fixtures.length, rowHeight: packed.rowHeight, metrics: packed.metrics });
    } else {
      const packed = runEngine(fixtures, fixtures.map(focusOf), gridWidth, tile, coverHeight, null);
      rows.push({ width, imagePx, engine, kind: 'static', groups: fixtures.length, rowHeight: packed.rowHeight, metrics: packed.metrics });
    }
    const tour = Array.from({ length: Math.min(2, columns) }, (_, i) => prefix(screenshot, i));
    let previous: GraphLayout[] | undefined, committed: FolderLayout | null = null;
    const active = tour.length - 1;
    for (const [step, name] of [null, 'Saffron', 'Ash', 'Cerulean', 'Saffron', null].entries()) {
      const focus = name ? `g${active}:${name}` : null;
      if (focus && previous && !previous[active].nodes.has(focus)) throw new Error('packing tour selected an unavailable tile');
      const focuses = tour.map((_, i) => i === active ? focus : null);
      let scene: { placed: GraphLayout[]; rowHeight: number; metrics: ReturnType<typeof measure> };
      if (engine === 'baseline') { const rs = tour.map((c, i) => pin(requestFor(c, focuses[i], gridWidth, imagePx), i)); scene = pack(rs, rs.map(baselineLayout)); }
      else { const run = runEngine(tour, focuses, gridWidth, tile, coverHeight, committed); committed = run.layout; scene = run; }
      const a = focus && previous?.[active].nodes.get(focus), b = focus && scene.placed[active].nodes.get(focus);
      const clickDisplacement = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
      rows.push({ width, imagePx, engine, kind: 'tour', step, focus, groups: tour.length, rowHeight: scene.rowHeight, metrics: scene.metrics, clickDisplacement, decision: scene.placed[active].decision });
      previous = scene.placed;
    }
  } catch (e) { rows.push({ width, imagePx, engine, error: String(e) }); }
}
await mkdir('layout-eval/out', { recursive: true });
await writeFile('layout-eval/out/packing.json', JSON.stringify(rows, null, 2));
console.log(JSON.stringify({ engine: engineName, scenarios: rows.length, baseline: rows.filter(r => r.engine === 'baseline').length, proposed: rows.filter(r => r.engine === 'proposed').length, errors: rows.filter(r => r.error) }, null, 2));
