/** Folder-order collapse and geometry rules. No component identity survives an index refresh. */
import type { FileEntry } from "$lib/domain/file";
import type { ComponentSummary, TraceNode } from "$lib/domain/trace-graph/model";
import type { GridFlow, GridItem, GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { GraphLayout, PinnedCover } from "$lib/domain/trace-graph/layout";
import type { FolderIndex } from "./folder-session.svelte";

export interface FolderCell extends GridItem {
  readonly entry?: FileEntry;
  readonly summary?: ComponentSummary;
  readonly coverKey?: string;
}

/** Newly listed paths cannot be classified against an older index. Hold them until the next
 * index read, whether the save came from this pane or elsewhere. Existing ordinary entries stay
 * visible, and paths already mapped by the index can be collapsed immediately. When the index read
 * failed nothing is held: a file must never stay hidden behind a refresh that may not come. */
export function pendingListingPaths(entries: readonly FileEntry[], index: FolderIndex | null, indexedPaths: ReadonlySet<string>, indexFailed = false): ReadonlySet<string> {
  if (indexFailed) return new Set();
  return new Set(entries.filter((entry) => !indexedPaths.has(entry.path) && !index?.members.has(entry.path)).map((entry) => entry.path));
}

/**
 * The cells in host listing order: a stack sits at its listed cover's position, and a stack with no
 * listed cover (unsaved) follows the listing. `held` names stacks (by cover key) that have been
 * unsaved in this layout: they keep their place after gaining a listed cover, so saving moves
 * no cell. `claimed` names listed paths the view knows belong to a stack (a file it just saved) before
 * the index maps them: they are not ordinary files. The caller forgets `held` when the grid is laid out afresh (resize, folder change).
 */
export function folderCells(entries: readonly FileEntry[], index: FolderIndex, held: ReadonlySet<string> = new Set(), claimed: ReadonlySet<string> = new Set()): FolderCell[] {
  const summaries = new Map(index.components.map((summary) => [summary.id, summary]));
  const emitted = new Set<string>();
  const result: FolderCell[] = [];
  for (const entry of entries) {
    const member = index.members.get(entry.path);
    const summary = member && summaries.get(member.componentId);
    if (!member && claimed.has(entry.path)) continue;
    if (!summary) { result.push({ id: entry.path, kind: entry.kind === "directory" ? "folder" : "file", entry }); continue; }
    if (summary.cover?.path !== entry.path || held.has(summary.coverKey)) continue;
    emitted.add(summary.id);
    result.push({ id: summary.coverKey, kind: "stack", entry, summary, coverKey: summary.coverKey });
  }
  // Unsaved-only lineages have no listed cover. Keep them reachable after the listing, in the order
  // their covers were created: the index lists components newest-activity first, so using its order
  // would swap two stacks' columns whenever the older one gains a member.
  const unlisted = index.components.filter((summary) => !emitted.has(summary.id)).sort((a, b) => compareCreation(a.coverKey, b.coverKey));
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const summary of unlisted) {
    const entry = held.has(summary.coverKey) && summary.cover ? byPath.get(summary.cover.path) : undefined;
    result.push({ id: summary.coverKey, kind: "stack", ...(entry ? { entry } : {}), summary, coverKey: summary.coverKey });
  }
  return result;
}

/** The stacks placed after the listing: with no listed cover, or held there. */
export const unlistedCovers = (cells: readonly FolderCell[], held: ReadonlySet<string>): ReadonlySet<string> =>
  new Set(cells.filter((cell) => cell.kind === "stack" && (!cell.entry || held.has(cell.coverKey!))).map((cell) => cell.coverKey!));

/** Oldest first by the number in a node key (`a:<artifact>` or `o:<run>:<output>`), ties by the key itself. */
export function compareCreation(a: string, b: string): number {
  const parse = (key: string) => { const match = /^[ao]:(\d+)(?::(\d+))?$/.exec(key); return match ? [Number(match[1]), match[2] === undefined ? -1 : Number(match[2])] : null; };
  const [left, right] = [parse(a), parse(b)];
  // A key of another shape sorts after every parsed one.
  if (left && !right) return -1;
  if (!left && right) return 1;
  if (left && right) for (let i = 0; i < 2; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Roving tabindex: the stop is the last focused cell while it is rendered, otherwise the stack
 * that held it, otherwise the first cell, so the grid always has exactly one tab stop. */
export function rovingStop(stop: string | null, rendered: ReadonlySet<string>, ownerOf: (key: string) => string | undefined, first: string | null): string | null {
  if (stop && rendered.has(stop)) return stop;
  const owner = stop ? ownerOf(stop) : undefined;
  return owner && rendered.has(owner) ? owner : first;
}

export function coverNode(cell: FolderCell): TraceNode {
  return { key: cell.coverKey!, artifactId: null, runId: null, parents: [], path: cell.summary?.cover?.path ?? null,
    scope: "current", location: cell.summary?.cover?.path ?? "", state: cell.summary?.active ? "running" : cell.summary?.cover?.present ? "present" : "missing",
    temporary: false, discarded: false, earlierRevision: false, order: 0, prompt: cell.summary?.title ?? "" };
}

/** Attach a pinned layout to the cover row, inserting earlier same-row bands below its stem.
 * Layout emits absolute M/L/C paths. Mapping their y coordinates stretches only the empty stem.
 */
export function attachBand(layout: GraphLayout, key: string, coverTop: number, bandTop: number, bridge?: { readonly top: number; readonly gutter: number }): GraphLayout {
  const cover = layout.nodes.get(key);
  if (!cover) return layout;
  const bottom = cover.y + cover.height;
  const mapY = (y: number) => y <= bottom ? y - cover.y + coverTop : y - bottom + bandTop;
  const path = (value: string) => {
    let coordinate = 0;
    return value.replace(/-?\d+(?:\.\d+)?/g, (number) => (++coordinate % 2 === 0 ? String(mapY(Number(number))) : number));
  };
  return { ...layout, height: mapY(layout.height),
    nodes: new Map([...layout.nodes].map(([id, node]) => [id, { ...node, y: mapY(node.y) }])),
    junctions: new Map([...layout.junctions].map(([id, dot]) => [id, { ...dot, y: mapY(dot.y) }])),
    routes: layout.routes.map((route) => {
      const mapped = path(route.path);
      const start = /^M\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/.exec(mapped);
      const exitsCover = route.from.kind === "node" && route.from.id === key && start && Math.abs(Number(start[2]) - (coverTop + cover.height)) < .1;
      if (!bridge || !exitsCover || bandTop <= bridge.top) return { ...route, path: mapped };
      // A later band's cover stem bypasses every earlier band's tiles through
      // the empty outer routing gutter, returning before its own bend zone.
      const x = Number(start![1]), y = Number(start![2]);
      return { ...route, path: `M${x} ${y} L${x} ${bridge.top} L${bridge.gutter} ${bridge.top} L${bridge.gutter} ${bandTop} L${x} ${bandTop}${mapped.slice(start![0].length)}` };
    }),
    rows: layout.rows.map((row) => ({ ...row, top: mapY(row.top), bottom: mapY(row.bottom) })) };
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

/** Index neighbors once; closed/virtualized stacks do not need layout pins. */
export function gridPins(flow: GridFlow, open: ReadonlySet<string>): ReadonlyMap<string, PinnedCover> {
  const rows = new Map<number, { id: string; x: number; width: number }[]>();
  for (const cell of flow.cells.values()) {
    const row = rows.get(cell.row) ?? [];
    row.push(cell); rows.set(cell.row, row);
  }
  return new Map([...open].flatMap((id) => {
    const cell = flow.cells.get(id);
    return cell ? [[id, { key: id, x: cell.x + cell.width / 2, obstacles: rows.get(cell.row)!.filter((other) => other.id !== id).map(({ x, width }) => ({ x, width })) }] as const] : [];
  }));
}
