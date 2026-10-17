import { expect } from 'vitest';
import type { GraphLayout, PlacedNode } from '$lib/domain/trace-graph/layout';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { TILE } from '$lib/domain/trace-graph/metrics';
import { expectArrivalPinned } from './arrival-contract';

/** Compare actual world rectangles, including cells and tiles whose component identity changed. */
export function expectFolderArrivalPinned(before: FolderLayout, after: FolderLayout): void {
  const world = (folder: FolderLayout): GraphLayout => ({
    nodes: new Map<string, PlacedNode>([
      ...[...folder.cells].map(([key, cell]) => [key, { ...cell, ...(folder.cellFootprints?.get(key) ?? cell), key, band: 0 }] as const),
      ...[...folder.graphs.values()].flatMap(graph => [...graph.attached.nodes].map(([key, tile]) =>
        [key, { ...tile, x: tile.x + graph.origin.x, y: tile.y + graph.origin.y }] as const)),
    ]),
    routes: [], junctions: new Map(), rows: [], readingOrder: new Map(), orientation: 'down', width: folder.size.width, height: folder.size.height,
  });
  for (const [id, cell] of before.cells) if (after.cells.has(id)) expect(after.cells.get(id), `cell ${id}`).toEqual({ ...cell, y: after.cells.get(id)!.y });
  const previous = world(before), current = world(after);
  const parents = (folder: FolderLayout) => new Set([...folder.graphs.values()].flatMap(g => (g.plan.request.band?.items ?? g.plan.request.items).flatMap(n => n.parents)));
  const hadChildren = parents(before), hasChildren = parents(after);
  for (const [key, tile] of previous.nodes) if (current.nodes.get(key)?.height === tile.height + TILE.hint) {
    expect(hadChildren.has(key), `${key}: previously a leaf`).toBe(false);
    expect(hasChildren.has(key), `${key}: first output arrived`).toBe(true);
  }
  expectArrivalPinned(previous, current);
}
