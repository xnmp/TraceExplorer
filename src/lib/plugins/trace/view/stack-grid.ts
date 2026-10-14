/** View-only grid helpers (roving focus, spatial navigation). Folder rules live in the domain (`folder-grid.ts`, `band-geometry.ts`) and are re-exported here for existing imports. */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";

export { estimatedBandExtent, bandExtent, packedGridFlow, bandPlacements, attachPackedBand, attachBand, type StackGridFlow, type BandPlacement } from "$lib/domain/trace-graph/band-geometry";
export { type FolderCell, pendingListingPaths, folderCells, unlistedCovers, compareCreation, coverNode, gridPins } from "$lib/domain/trace-graph/folder-grid";

/** Roving tabindex: the stop is the last focused cell while it is rendered, otherwise the stack
 * that held it, otherwise the first cell, so the grid always has exactly one tab stop. */
export function rovingStop(stop: string | null, rendered: ReadonlySet<string>, ownerOf: (key: string) => string | undefined, first: string | null): string | null {
  if (stop && rendered.has(stop)) return stop;
  const owner = stop ? ownerOf(stop) : undefined;
  return owner && rendered.has(owner) ? owner : first;
}

/** Spatial keyboard navigation includes ordinary entries, covers and visible band tiles. */
export function gridNeighbor(rects: ReadonlyMap<string, GridRect>, key: string, direction: string): string | null {
  const from = rects.get(key);
  if (!from) return null;
  if (direction === "Home" || direction === "End") {
    const ordered = [...rects].sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
    return (direction === "Home" ? ordered[0] : ordered.at(-1))?.[0] ?? null;
  }
  const vertical = direction === "ArrowUp" || direction === "ArrowDown";
  const sign = direction === "ArrowUp" || direction === "ArrowLeft" ? -1 : 1;
  if (!vertical && direction !== "ArrowLeft" && direction !== "ArrowRight") return null;
  const x = from.x + from.width / 2, y = from.y + from.height / 2;
  if (vertical) {
    // Next row, then nearest by x. Tiles differ in height, so rows are not aligned: a candidate lies
    // wholly below (or above) the current tile, the next row is the first such tile's vertical extent,
    // and a tile starting inside that extent shares it.
    const edge = sign > 0 ? from.y + from.height : from.y;
    const beyond = [...rects].filter(([id, rect]) => id !== key && (sign > 0 ? rect.y >= edge - .5 : rect.y + rect.height <= edge + .5));
    if (!beyond.length) return null;
    const nearness = ([, rect]: [string, GridRect]) => sign > 0 ? rect.y - edge : edge - (rect.y + rect.height);
    const [, first] = beyond.reduce((best, candidate) => nearness(candidate) < nearness(best) ? candidate : best);
    const inRow = beyond.filter(([, rect]) => sign > 0 ? rect.y < first.y + first.height : rect.y + rect.height > first.y);
    return inRow.reduce((best, [id, rect]) => {
      const across = Math.abs(rect.x + rect.width / 2 - x);
      return across < best.across ? { id, across } : best;
    }, { id: null as string | null, across: Infinity }).id;
  }
  let best: string | null = null, score = Infinity;
  for (const [id, rect] of rects) {
    if (id === key) continue;
    const dx = rect.x + rect.width / 2 - x, dy = rect.y + rect.height / 2 - y;
    const along = dx * sign, across = Math.abs(dy);
    if (along <= .5 || Math.abs(dy) > Math.max(from.height, rect.height) / 2) continue;
    const candidate = along + across * 3;
    if (candidate < score) { best = id; score = candidate; }
  }
  return best;
}
