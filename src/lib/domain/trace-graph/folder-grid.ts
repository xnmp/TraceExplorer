/**
 * Folder-order collapse, grid metrics and pins: the pure rules that turn a host listing and a
 * folder index into grid items, and a pane width into grid columns. No component identity
 * survives an index refresh, so stacks are identified by their cover key.
 */
import type { FileEntry } from "../file";
import type { ComponentSummary, TraceNode } from "./model";
import type { FolderIndex } from "./folder-data";
import type { GridFlow, GridItem } from "./grid-flow";
import type { PinnedCover } from "./layout";
import { tileSize, type TileMetrics } from "./metrics";

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

/** The node a closed stack's cover shows before its component has loaded. */
export function coverNode(cell: FolderCell): TraceNode {
  return { key: cell.coverKey!, artifactId: null, runId: null, parents: [], path: cell.summary?.cover?.path ?? null,
    scope: "current", location: cell.summary?.cover?.path ?? "", state: cell.summary?.cover?.present ? "present" : cell.summary?.active ? "running" : "missing",
    temporary: false, discarded: false, earlierRevision: false, order: 0, prompt: cell.summary?.title ?? "" };
}

/** Closed/virtualized stacks need no pin. Neighboring covers are above the shared child band,
 * so they are not graph obstacles and must not generate outer routing lanes.
 * Vertical packing changes keep the same pin: they change attachment, not graph layout. */
export function gridPins(flow: GridFlow, open: Iterable<string>, previous: ReadonlyMap<string, PinnedCover> = new Map()): ReadonlyMap<string, PinnedCover> {
  return new Map([...open].flatMap((id) => {
    const cell = flow.cells.get(id);
    if (!cell) return [];
    const x = cell.x + cell.width / 2, known = previous.get(id);
    return [[id, known?.key === id && known.x === x && known.obstacles?.length === 0 ? known : { key: id, x, obstacles: [] }] as const];
  }));
}

/** Host tile-grid metrics (`tileGridMetrics`), as the grid reads them. */
export interface HostGridMetrics {
  readonly contentWidth?: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly gap: number;
  readonly gridPadding: number;
}

/** The grid metrics used without a host tile renderer: the Trace tile itself, an 8 px gap and no padding. */
export const fallbackGridMetrics = (tile: TileMetrics): HostGridMetrics =>
  ({ contentWidth: tile.width, cellWidth: tile.width, cellHeight: tileSize({ foreign: false, hint: true }, tile).height, gap: 8, gridPadding: 0 });

/** The grid's inner width: the pane width less the grid padding on both sides, never negative. */
export const gridInnerWidth = (paneWidth: number, gridPadding: number): number => Math.max(0, paneWidth - 2 * gridPadding);

export interface FolderGridGeometry {
  readonly columns: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly gap: number;
}

/**
 * Columns and cell size for an inner width: as many cells of the wider of the host cell and the
 * Trace tile as fit, stretched to fill the width, and at least as tall as a cover tile.
 * Throws RangeError for a non-finite width or metric, a non-positive tile, or negative grid metrics;
 * a negative width counts as zero (one column).
 */
export function folderGridGeometry(width: number, tile: TileMetrics, grid: { readonly cellWidth: number; readonly cellHeight: number; readonly gap: number }): FolderGridGeometry {
  if (!Number.isFinite(width)) throw new RangeError("grid width must be finite");
  if (!Number.isFinite(tile?.width) || !Number.isFinite(tile?.image) || tile.width <= 0 || tile.image <= 0) throw new RangeError("tile metrics must be finite and positive");
  for (const value of [grid?.cellWidth, grid?.cellHeight, grid?.gap]) if (!Number.isFinite(value) || value < 0) throw new RangeError("grid metrics must be finite and nonnegative");
  const inner = Math.max(0, width), gap = grid.gap;
  const columns = Math.max(1, Math.floor((inner + gap) / (Math.max(grid.cellWidth, tile.width) + gap)));
  if (!Number.isSafeInteger(columns)) throw new RangeError("grid columns overflow");
  return { columns, gap, cellWidth: Math.max(tile.width, (inner - (columns - 1) * gap) / columns),
    cellHeight: Math.max(grid.cellHeight, tileSize({ foreign: false, hint: true }, tile).height) };
}
