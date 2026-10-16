/** Certify the completed folder after packing and connector attachment. */
import { geometryGate } from '../geometry-gate';
import { mapPathNumbers } from '../path-data';
import type { GraphLayout, LayoutItem, PlacedNode, PlacedJunction, PlacedRoute } from '../layout';
import type { FolderLayout } from './types';

export function folderGeometryGate(folder: FolderLayout): string | null {
  const nodes = new Map<string, PlacedNode>(), junctions = new Map<string, PlacedJunction>(), routes: PlacedRoute[] = [], items: LayoutItem[] = [];
  const covers = new Set(folder.graphs.keys());
  for (const [id, cell] of folder.cells) if (!covers.has(id)) {
    const key = JSON.stringify(['cell', id]);
    nodes.set(key, { ...cell, key, band: 0 });
    items.push({ key, width: cell.width, height: cell.height, parents: [], order: items.length });
  }
  for (const [id, graph] of folder.graphs) {
    const key = (value: string) => JSON.stringify(['graph', id, value]);
    const { attached, origin } = graph;
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
