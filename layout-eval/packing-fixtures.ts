import { folderGeometryGate } from '../src/lib/domain/trace-graph/folder-layout/geometry-gate';
import { isDeepStrictEqual } from 'node:util';
import { displayIdentity, recallDisplay } from '../src/lib/domain/trace-graph/folder-layout/display-memory';
import { geometrySignature } from '../src/lib/domain/trace-graph/layout-signature';
import type { GraphLayout } from '../src/lib/domain/trace-graph/layout';
import type { TileMetrics } from '../src/lib/domain/trace-graph/metrics';
import { projectDag, projectReferenceBadges } from '../src/lib/domain/trace-graph/projection';
import { engines, type FolderLayout, type FolderLayoutEngine, type OpenStack } from '../src/lib/domain/trace-graph/folder-layout';
import { focusExpanded, type Case } from './corpus';
import { measure } from './geometry';
import { mapPathNumbers } from '../src/lib/domain/trace-graph/path-data';
/** The candidate engine's folder: one stack per case, each pinned in its own column of a grid exactly `gridWidth` wide. */
export function runEngine(cases: readonly Case[], focuses: readonly (string | null)[], gridWidth: number, tile: TileMetrics, coverHeight: number, previous: FolderLayout | null, folderEngine: FolderLayoutEngine = engines.default) {
  const open = new Map<string, OpenStack>(cases.map((c, i) => {
    if (c.full) throw new Error(`${c.id}: full-lineage requests have no folder equivalent`);
    const graph = projectReferenceBadges(projectDag(c.nodes)), members = graph.dag.order;
    return [members[0], { id: members[0], graph, members, anchor: focuses[i], expanded: focusExpanded(graph, members, members[0], focuses[i]) }];
  }));
  const items = [...open.keys()].map(id => ({ id, kind: 'stack' as const }));
  const input = { items, open, width: gridWidth, tile, grid: { cellWidth: tile.width, cellHeight: coverHeight, gap: 16 }, previous };
  const layout = folderEngine(input);
  const identity = displayIdentity(input, layout.graphs);
  const saved = recallDisplay(previous?.displays, identity);
  const drawing = (value: FolderLayout) => [value.cells, value.rowBands,
    [...value.graphs].map(([id, graph]) => [id, graph.origin, geometrySignature(graph.attached)])];
  const revisited = !!saved && isDeepStrictEqual(drawing(saved), drawing(layout));
  if (saved && !revisited) throw new Error('Identical displayed state key did not restore exact folder geometry');
  const ids = items.map(item => item.id), graphs = ids.map(id => layout.graphs.get(id)!);
  // The grid box, as the packed flow reports it: rows end at their last band, columns span the input width.
  const width = Math.max(gridWidth, ...layout.rowBands.map(b => b.x + b.width)), height = Math.max(0, ...[...layout.cells.values(), ...layout.rowBands].map(r => r.y + r.height));
  // Attached drawings are cover-relative; measure the same world coordinates the view paints.
  const placed = graphs.map(({attached,origin}) => ({...attached,
    nodes:new Map([...attached.nodes].map(([id,n])=>[id,{...n,x:n.x+origin.x,y:n.y+origin.y}])),
    junctions:new Map([...attached.junctions].map(([id,j])=>[id,{...j,x:j.x+origin.x,y:j.y+origin.y}])),
    routes:attached.routes.map(r=>({...r,path:mapPathNumbers(r.path,(v,i)=>v+(i%2?origin.y:origin.x))})),
  })), requests = graphs.map(g => g.plan.request);
  const combined: GraphLayout = { orientation: 'down', width, height, nodes: new Map(placed.flatMap(l => [...l.nodes])), routes: placed.flatMap(l => l.routes), junctions: new Map(placed.flatMap(l => [...l.junctions])), rows: [], readingOrder: new Map() };
  return { independentFailure: folderGeometryGate(layout), layout, placed, revisited, displayKey: identity.key, rowHeight: layout.rowBands[0]?.height ?? 0, metrics: measure(combined, 'no-cover', gridWidth, requests.flatMap(r => r.items)) };
}

export const prefixCase = (c: Case, i: number): Case => ({ ...c, nodes: c.nodes.map(n => ({ ...n, key: `g${i}:${n.key}`, parents: n.parents.map(p => `g${i}:${p}`) })) });
