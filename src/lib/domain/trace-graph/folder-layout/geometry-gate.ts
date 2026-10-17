/** Certify the completed folder after packing and connector attachment. */
import { geometryGate } from '../geometry-gate';
import { mapPathNumbers } from '../path-data';
import type { GraphLayout, LayoutItem, PlacedNode, PlacedJunction, PlacedRoute } from '../layout';
import type { FolderLayout } from './types';

export function folderGeometryGate(folder: FolderLayout): string | null {
  for (const cell of folder.cells.values()) if (!cell || ![cell.x, cell.y, cell.width, cell.height].every(Number.isFinite)
    || !(cell.width > 0) || !(cell.height > 0)) return 'invalid-cell';
  if (folder.cellFootprints !== undefined) {
    if (!(folder.cellFootprints instanceof Map)) return 'invalid-cell-footprint';
    for (const [id, rect] of folder.cellFootprints) {
      const cell = folder.cells.get(id);
      if (!cell || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
        || !(rect.width > 0) || rect.width > cell.width || rect.y !== cell.y || rect.height !== cell.height
        || Math.abs(rect.x + rect.width / 2 - cell.x - cell.width / 2) > 1e-7) return 'invalid-cell-footprint';
    }
  }
  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [], items: LayoutItem[] = [];
  const covers = new Set(folder.graphs.keys());
  for (const [id, cell] of folder.cells) if (!covers.has(id)) {
    const key = JSON.stringify(['cell', id]);
    const footprint = folder.cellFootprints?.get(id) ?? cell;
    nodes.set(key, { ...cell, ...footprint, key, band: 0 });
    items.push({ key, width: footprint.width, height: footprint.height, parents: [], order: items.length });
  }
  for (const [id, graph] of folder.graphs) {
    const key = (value: string) => JSON.stringify(['graph', id, value]);
    const { attached, origin } = graph;
    // The scene paints the cover from its cell, not from the attached node. Bind
    // both representations before checking routes against the attached drawing.
    const cell = folder.cells.get(id), cover = attached.nodes.get(id);
    const width = graph.plan.request.items.find(item => item.key === id)?.width;
    if (!cell || !cover || width === undefined || !Number.isFinite(width) || !(width > 0) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)
      || Math.abs(cover.x + origin.x - cell.x - (cell.width - width) / 2) > 1e-7
      || Math.abs(cover.y + origin.y - cell.y) > 1e-7
      || cover.width !== width || cover.height !== cell.height) return 'detached-cover';
    for (const n of attached.nodes.values()) nodes.set(key(n.key), { ...n, key: key(n.key), x: n.x + origin.x, y: n.y + origin.y });
    for (const j of attached.junctions.values()) junctions.set(key(j.id), { ...j, id: key(j.id), x: j.x + origin.x, y: j.y + origin.y, parents: j.parents.map(key) });
    const tables = new Map<readonly unknown[], readonly { parent: string; child: string }[]>();
    for (const r of attached.routes) {
      const c = r.consumers, range = Array.isArray(c) ? { entries: c, start: 0, end: c.length } : c as { entries: readonly { parent: string; child: string }[]; start: number; end: number };
      let entries = tables.get(range.entries);
      if (!entries) { entries = range.entries.map(c => ({ parent: key(c.parent), child: key(c.child) })); tables.set(range.entries, entries); }
      routes.push({ ...r, id: key(r.id), from: { ...r.from, id: key(r.from.id) }, to: { ...r.to, id: key(r.to.id) }, consumers: { entries, start: range.start, end: range.end },
        path: mapPathNumbers(r.path, (value, i) => value + (i % 2 ? origin.y : origin.x)) });
    }
    for (const item of graph.plan.request.items) {
      const n = attached.nodes.get(item.key);
      items.push({ ...item, key: key(item.key), parents: item.parents.map(key), width: n?.width ?? item.width, height: n?.height ?? item.height });
    }
  }
  if (!nodes.size) return null;
  const layout: GraphLayout = { nodes, junctions, routes, rows: [], readingOrder: new Map(), orientation: 'down', width: Math.max(folder.size.width, folder.bounds.x + folder.bounds.width), height: Math.max(folder.size.height, folder.bounds.y + folder.bounds.height) };
  return geometryGate(layout, items, nodes.keys().next().value!, layout.width);
}
