import { layoutStage, countLayoutWork } from '../layout-profile';
/** Extend one committed folder drawing in world coordinates, so packing is also pinned. */
import { incrementalWorld } from '../band-incremental';
import { isLayoutShape, validHistory } from '../history-boundary';
import { bandHistorySignature } from '../band-history';
import { mapPathNumbers } from '../path-data';
import { filterRouteConsumers, eachConsumer } from '../route-consumers';
import type { Consumer } from '../junctions';
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedJunction, PlacedNode, PlacedRoute } from '../layout';
import type { BandScenePlan } from '../scene';
import type { GridBand, GridCell, GridRect } from '../grid-flow';
import { centeredCellFootprint, withCellFootprints } from './cell-footprints';
import { folderGeometryGate } from './geometry-gate';
import { paneRouteBounds, unionRect } from './route-bounds';
import type { FolderGraph, FolderLayout, FolderLayoutInput, GraphId, FolderPlacementHistory } from './types';

type Plan = { readonly plan: BandScenePlan };
const scope = (kind: string, id: string, key = '') => JSON.stringify([kind, id, key]);
const MARGIN = 16;
/** The router's leftmost legal lane is x=8; translating it back must stay nonnegative. */
const ORIGIN_X = 8;
const ROOT = JSON.stringify(['folder-placement-anchor']);

export function preservesFolderRectangles(result: FolderLayout, snapshot: FolderPlacementHistory['layout']): boolean {
  if (!(snapshot?.cells instanceof Map) || !(snapshot.graphs instanceof Map)) return false;
  const same = (a: GridRect, b: GridRect) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  for (const [id, cell] of snapshot.cells) {
    const now = result.cells.get(id);
    if (now && !same(cell, now)) return false;
  }
  for (const [id, graph] of snapshot.graphs) {
    if (!graph?.attached || !(graph.attached.nodes instanceof Map) || !graph.origin) return false;
    const now = result.graphs.get(id); if (!now) continue;
    for (const [key, old] of graph.attached.nodes) {
      if (!old) return false;
      const n = now.attached.nodes.get(key);
      if (n && !same({ ...old, x: old.x + graph.origin.x, y: old.y + graph.origin.y },
        { ...n, x: n.x + now.origin.x, y: n.y + now.origin.y })) return false;
    }
  }
  return true;
}

function mapRouteConsumers(routes: readonly PlacedRoute[], map: (c: Consumer) => Consumer): PlacedRoute[] {
  const tables = new Map<readonly Consumer[], readonly Consumer[]>();
  return routes.map(route => {
    const c = route.consumers;
    if (Array.isArray(c)) return { ...route, consumers: c.map(map) };
    const range = c as { readonly entries: readonly Consumer[]; readonly start: number; readonly end: number };
    let entries = tables.get(range.entries);
    if (!entries) { entries = range.entries.map(map); tables.set(range.entries, entries); }
    return { ...route, consumers: { ...range, entries } };
  });
}

/**
 * Existing tiles and wires from every component are obstacles to every insertion. The neutral
 * anchor has no edges: its only purpose is adapting the band router's root parameter. It is
 * removed before certification. A failed bounded search withholds this candidate; it does not
 * prove that retained placement is infeasible.
 */
export function pinnedFolderPlacement(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, Plan>, snapshot: FolderPlacementHistory['layout'], candidate: FolderLayout): FolderLayout | null {
  const endStage = layoutStage('pinned-folder'); try {

  try { return place(input, plans, snapshot, candidate); } catch { return null; }

  } finally { endStage(); }
}

function place(input: FolderLayoutInput, plans: ReadonlyMap<GraphId, Plan>, snapshot: FolderPlacementHistory['layout'], candidate: FolderLayout): FolderLayout | null {
  if (!(snapshot.cells instanceof Map) || !(snapshot.graphs instanceof Map)) return null;
  if (!Array.isArray(snapshot.bands)) return null;
  const oldBands = new Map(snapshot.bands.map(band => [band.id, band]));
  for (const [id, graph] of snapshot.graphs) {
    const cell = snapshot.cells.get(id), band = oldBands.get(id);
    if (!cell || !band || !isLayoutShape(graph.attached) || !isLayoutShape(graph.layout)
      || graph.origin?.x !== 0 || graph.origin?.y !== cell.y
      || !validHistory({ signature: bandHistorySignature(graph.plan.request), layout: graph.layout, placed: graph.attached,
        ...(!graph.worldPlaced ? { attachment: { bandTop: band.y - cell.y, placement: graph.placement } } : {}) }, id)) return null;
  }
  if (folderGeometryGate(snapshot)) return null;

  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [];
  const items: LayoutItem[] = [], identities = new Map<string, { graph: string; key: string }>();
  const oldJunctions = new Map<string, string>(), oldRoutes = new Map<string, string>();
  const cells = new Map<string, GridCell>();
  let appendedY = Math.max(snapshot.size.height, snapshot.bounds.y + snapshot.bounds.height) + MARGIN;
  let appendedRow = [...snapshot.cells.values()].reduce((row, c) => Math.max(row, c.row + 1), 0);
  for (const item of input.items) {
    const old = snapshot.cells.get(item.id), fresh = candidate.cells.get(item.id);
    if (!old && !fresh) return null;
    const cell = old ?? { ...fresh!, x: 0, y: appendedY, row: appendedRow++, col: 0 };
    cells.set(item.id, cell);
    if (!old) appendedY += cell.height + MARGIN;
  }
  for (const [id, cell] of cells) if (!plans.has(id)) {
    const key = scope('cell', id);
    const footprint = centeredCellFootprint(cell, candidate.cellFootprints?.get(id)?.width ?? cell.width);
    nodes.set(key, { ...cell, ...footprint, key, x: footprint.x + ORIGIN_X, band: 0 });
    items.push({ key, width: footprint.width, height: footprint.height, order: items.length, parents: [] });
  }
  for (const [id, { plan }] of plans) {
    const graph = snapshot.graphs.get(id), attached = graph?.attached, origin = graph?.origin;
    const cell = cells.get(id)!;
    const nodeKey = (key: string) => scope('node', id, key), joinKey = (key: string) => scope('junction', id, key);
    for (const item of plan.request.items) {
      const key = nodeKey(item.key), old = attached?.nodes.get(item.key);
      identities.set(key, { graph: id, key: item.key });
      items.push({ ...item, key, parents: item.parents.map(nodeKey), width: old?.width ?? item.width, height: old?.height ?? item.height });
      if (old) nodes.set(key, { ...old, key, x: old.x + origin!.x + ORIGIN_X, y: old.y + origin!.y });
      else if (item.key === id) nodes.set(key, { key, x: cell.x + (cell.width - item.width) / 2 + ORIGIN_X,
        y: cell.y, width: item.width, height: cell.height, row: 0, band: 0 });
    }
    for (const j of attached?.junctions.values() ?? []) {
      const key = joinKey(j.id); oldJunctions.set(key, j.id);
      junctions.set(key, { ...j, id: key, x: j.x + origin!.x + ORIGIN_X, y: j.y + origin!.y, parents: j.parents.map(nodeKey) });
    }
    const scoped = mapRouteConsumers(attached?.routes ?? [], c => ({ parent: nodeKey(c.parent), child: nodeKey(c.child) }));
    for (const route of scoped) {
      const key = scope('route', id, route.id); oldRoutes.set(key, route.id);
      const endpoint = (end: PlacedRoute['from']) => ({ ...end, id: end.kind === 'node' ? nodeKey(end.id) : joinKey(end.id) });
      routes.push({ ...route, id: key, from: endpoint(route.from), to: endpoint(route.to),
        path: mapPathNumbers(route.path, (v, i) => v + (i % 2 ? origin!.y : origin!.x + ORIGIN_X)) });
    }
  }
  const visible = new Set(items.map(item => item.key));
  const retainedRoutes = filterRouteConsumers(routes, c => visible.has(c.parent) && visible.has(c.child));
  const referenced = new Set(retainedRoutes.flatMap(r => [r.from, r.to].filter(e => e.kind === 'junction').map(e => e.id)));
  for (const key of junctions.keys()) if (!referenced.has(key)) junctions.delete(key);
  // Roots require no wiring. Seed them beyond the retained drawing before routing descendants.
  for (const item of items) if (!nodes.has(item.key) && !item.parents.length) {
    nodes.set(item.key, { ...item, x: ORIGIN_X, y: appendedY, row: appendedRow++, band: 0 });
    appendedY += item.height + MARGIN;
  }
  const missing = items.filter(item => !nodes.has(item.key));
  nodes.set(ROOT, { key: ROOT, x: 0, y: 0, width: 1, height: 1, row: 0, band: 0 });
  items.unshift({ key: ROOT, width: 1, height: 1, order: -1, parents: [] });
  const maxWidth = input.width + ORIGIN_X;
  const previous: GraphLayout = { nodes, junctions, routes: retainedRoutes, rows: [], readingOrder: new Map(), orientation: 'down',
    width: maxWidth, height: Math.max(snapshot.size.height, snapshot.bounds.y + snapshot.bounds.height, appendedY - MARGIN) };
  const request: LayoutRequest = { items, maxWidth, tileWidth: input.tile.width, band: { key: ROOT, items } };
  const placed = missing.length ? incrementalWorld(request, previous, undefined, ORIGIN_X)
    ?? incrementalWorld({ ...request, maxWidth: Math.min(100_000, maxWidth + missing.reduce((sum,n) => sum + n.width + 64,64)) }, previous, undefined, ORIGIN_X) : previous;
  if (!placed) return null;

  const graphs = new Map<GraphId, FolderGraph>(), bands: GridBand[] = [];
  const ownerRoutes = new Map<string, PlacedRoute[]>(), ownerJoins = new Map<string, Set<string>>();
  for (const r of placed.routes) {
    const consumer = eachConsumer(r)[Symbol.iterator]().next().value, owner = consumer && identities.get(consumer.parent)?.graph;
    if (!owner) return null;
    const list = ownerRoutes.get(owner) ?? []; list.push(r); ownerRoutes.set(owner, list);
    const joins = ownerJoins.get(owner) ?? new Set<string>();
    for (const e of [r.from, r.to]) if (e.kind === 'junction') joins.add(e.id);
    ownerJoins.set(owner, joins);
  }
  let bounds: GridRect | null = { x: 0, y: 0, width: snapshot.size.width, height: snapshot.size.height };
  for (const cell of cells.values()) bounds = unionRect(bounds, cell);
  for (const [id, { plan }] of plans) {
    const old = snapshot.graphs.get(id) ?? candidate.graphs.get(id)!, cell = cells.get(id)!, origin = { x: old.origin.x, y: cell.y };
    const localNodes = new Map<string, PlacedNode>(), localJoins = new Map<string, PlacedJunction>();
    const localNode = (key: string) => identities.get(key)!.key;
    const localJoin = (key: string) => oldJunctions.get(key) ?? scope('folder-junction', key);
    let envelope: GridRect | null = null;
    for (const item of plan.request.items) {
      const n = placed.nodes.get(scope('node', id, item.key)); if (!n) return null;
      const local = { ...n, key: item.key, x: n.x - origin.x - ORIGIN_X, y: n.y - origin.y };
      localNodes.set(item.key, local); bounds = unionRect(bounds, { ...n, x: n.x - ORIGIN_X });
      if (item.key !== id) envelope = unionRect(envelope, { ...n, x: n.x - ORIGIN_X });
    }
    for (const key of ownerJoins.get(id) ?? []) {
      const j = placed.junctions.get(key); if (!j) return null;
      const local = localJoin(key);
      localJoins.set(local, { ...j, id: local, x: j.x - origin.x - ORIGIN_X, y: j.y - origin.y, parents: j.parents.map(localNode) });
    }
    const localRoutes = mapRouteConsumers(ownerRoutes.get(id) ?? [], c => ({ parent: localNode(c.parent), child: localNode(c.child) })).map(r => {
      const endpoint = (e: PlacedRoute['from']) => ({ ...e, id: e.kind === 'node' ? localNode(e.id) : localJoin(e.id) });
      bounds = unionRect(bounds, paneRouteBounds(r.path, input.width, -ORIGIN_X));
      return { ...r, id: oldRoutes.get(r.id) ?? scope('folder-route', r.id), from: endpoint(r.from), to: endpoint(r.to),
        path: mapPathNumbers(r.path, (v, i) => v - (i % 2 ? origin.y : origin.x + ORIGIN_X)) };
    });
    const attached: GraphLayout = { ...old.attached, nodes: localNodes, junctions: localJoins, routes: localRoutes, rows: [],
      width: Math.max(0, Math.max(snapshot.size.width, placed.width - ORIGIN_X) - origin.x), height: placed.height - origin.y, bandBounds: undefined,
      decision: { candidate: 'folder-pinned-extension', stability: true } };
    // The raw band cache remains keyed by its request. World placement is only the attached
    // drawing; caching it as a raw band would reattach it and make later clicks path-dependent.
    graphs.set(id, { ...old, plan, layout: attached, attached, origin, worldPlaced: true,
      canonical: { request: plan.request, layout: candidate.graphs.get(id)!.layout } });
    const band = envelope ?? { x: cell.x, y: cell.y + cell.height, width: 0, height: 0 };
    bands.push({ ...band, id, row: cell.row });
  }
  const rowBounds = new Map<number, GridRect>();
  for (const band of bands) rowBounds.set(band.row, unionRect(rowBounds.get(band.row) ?? null, band)!);
  const rowBands = [...rowBounds].map(([row, rect]) => ({ ...rect, row, id: `row:${row}` }));
  const result: FolderLayout = { columns: snapshot.columns, size: { width: Math.max(snapshot.size.width, bounds!.x + bounds!.width), height: Math.max(snapshot.size.height, bounds!.y + bounds!.height) },
    bounds: bounds!, cells, bands, rowBands, graphs };
  const painted = withCellFootprints(result, input);
  return folderGeometryGate(painted) ? null : painted;
}
