/** Folder-order collapse and geometry rules. No component identity survives an index refresh. */
import type { FileEntry } from "$lib/domain/file";
import type { ComponentSummary, TraceNode } from "$lib/domain/trace-graph/model";
import { gridFlow, type GridFlow, type GridItem, type GridRect, type GridMetrics, type GridBand, type GridCell } from "$lib/domain/trace-graph/grid-flow";
import { nearestFree, type GraphLayout, type PinnedCover } from "$lib/domain/trace-graph/layout";
import type { FolderIndex } from "./folder-session.svelte";
import { packStackGroups, coverGutters } from "./stack-packing";
import { pathTailAtY } from "$lib/domain/trace-graph/path-geometry";
import { ARROW, STACK_STEM_ROOM, TRACK_HEIGHT, tileSize, spacingFor, type TileMetrics } from "$lib/domain/trace-graph/metrics";

/** Reserve one child generation until a committed layout supplies the actual footprint.
 * Counts include hidden descendants/references, so they cannot predict the number of visible rows.
 * Use the current tile metrics and routing channel; the final layout may settle either way. */
export function estimatedBandExtent(tile: TileMetrics): { width: number; height: number } {
  const spacing = spacingFor(tile.width);
  return { width: tile.width + 16,
    height: STACK_STEM_ROOM + tileSize({ foreign: false, hint: true }, tile).height + spacing.bottom };
}

/** The child routing footprint; the fixed cover’s header displacement is attached after packing. */
export function bandExtent(layout: GraphLayout, key: string, padding = 8) {
  const cover = layout.nodes.get(key);
  const nodes = [...layout.nodes].filter(([id]) => id !== key).map(([, node]) => node);
  const first = Math.min(...nodes.map((node) => node.y));
  const xs = nodes.flatMap((node) => [node.x - (layout.orientation === "right" ? 16 : 0), node.x + node.width]);
  for (const route of layout.routes) {
    const coordinates = route.path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    xs.push(...coordinates.filter((_, i) => i % 2 === 0 && (route.from.kind !== "node" || route.from.id !== key || coordinates[i + 1] >= first - 16)));
  }
  for (const dot of layout.junctions.values()) xs.push(dot.x);
  const left = layout.bandBounds?.left ?? (xs.length ? Math.min(...xs) - padding : (cover?.x ?? 0));
  return { left, width: layout.bandBounds?.width ?? (xs.length ? Math.max(...xs) + padding - left : 0), height: nodes.length ? Math.max(0, layout.height - (layout.bandBounds?.top ?? Math.min(...nodes.map((node) => node.y))) + STACK_STEM_ROOM) : 0 };
}

export interface StackGridFlow extends GridFlow { readonly rowBands: readonly GridBand[] }
/** One physical band per folder row; each group's footprint reserves only its own interval. */
export function packedGridFlow(items: readonly GridItem[], open: ReadonlyMap<string, { width: number; height: number }>, columns: number, metrics: GridMetrics): StackGridFlow {
  const base = gridFlow(items, new Map(), columns, metrics);
  const cells = new Map(base.cells), bands: GridBand[] = [], rowBands: GridBand[] = [];
  const rows = new Map<number, GridCell[]>(), kinds = new Map(items.map((item) => [item.id, item.kind]));
  for (const cell of base.cells.values()) { const row = rows.get(cell.row) ?? []; row.push(cell); rows.set(cell.row, row); }
  let extra = 0;
  for (const [row, members] of rows) {
    for (const cell of members) cells.set(cell.id, { ...cell, y: cell.y + extra });
    const groups = members.flatMap((cell) => {
      const size = open.get(cell.id);
      return size && kinds.get(cell.id) === "stack" ? [{ id: cell.id, center: cell.x + cell.width / 2, ...size }] : [];
    });
    const header = Math.max(STACK_STEM_ROOM, TRACK_HEIGHT * groups.length + 2 * ARROW.length);
    const sized = groups.map((group, i) => ({ ...group, height: group.height + Math.max(header, TRACK_HEIGHT * (i + 1) + 2 * ARROW.length + TRACK_HEIGHT) - STACK_STEM_ROOM }));
    const initial = packStackGroups(sized, base.width, 16, 0);
    // Existing margins usually suffice. Reserve an outer gutter only when the
    // actual stem envelopes need it; a later opening otherwise moves no group.
    const gutterRoom = coverGutters(initial, base.width) ? 0 : 4 * groups.length + 4;
    const fits = (group: import("./stack-packing").PackedStackGroup, previous: readonly import("./stack-packing").PackedStackGroup[]) =>
      coverGutters([...previous, group].map((group) => ({ ...group, x: group.x + gutterRoom })), base.width) !== null;
    const packed = packStackGroups(sized, Math.max(1, base.width - gutterRoom), 16, 0, fits).map((group) => ({ ...group, x: group.x + gutterRoom }));
    const top = members[0].y + extra + metrics.cellHeight;
    const height = Math.max(0, ...packed.map((group) => group.y + group.height));
    for (const group of packed) bands.push({ id: group.id, row, x: group.x, y: top + group.y, width: group.width, height: group.height });
    if (packed.length) rowBands.push({ id: `row:${row}`, row, x: 0, y: top, width: Math.max(base.width, ...packed.map((group) => group.x + group.width)), height });
    extra += height;
    if (!Number.isFinite(base.height + extra)) throw new RangeError("grid height overflow");
  }
  return { ...base, width: Math.max(base.width, ...rowBands.map((band) => band.width)), height: base.height + extra, cells, bands, rowBands };
}

export interface BandPlacement {
  readonly x: number;
  readonly coverX: number;
  readonly coverHeight: number;
  readonly width: number;
  /** Connector envelope includes the fixed parent; child packing intervals remain disjoint. */
  readonly left: number;
  readonly right: number;
  /** A wrapped line's stem uses the empty side margin of earlier groups, above its own bend zone. */
  readonly track?: number;
  readonly stemRoom?: number;
  readonly coverColumns?: readonly number[];
  readonly bypassColumns?: readonly number[];
  readonly bridge?: { readonly top: number; readonly gutter: number };
}

export function bandPlacements(flow: StackGridFlow, coverHeight: number): ReadonlyMap<string, BandPlacement> {
  const rows = new Map<number, GridBand[]>();
  for (const band of flow.bands) { const row = rows.get(band.row) ?? []; row.push(band); rows.set(band.row, row); }
  const gutters = new Map([...rows].map(([row, bands]) => [row, coverGutters(bands.map((band) => ({ ...band, center: flow.cells.get(band.id)!.x + flow.cells.get(band.id)!.width / 2, line: 0 })), flow.width)]));
  return new Map(flow.bands.map((band) => {
    const cell = flow.cells.get(band.id)!, coverX = cell.x + cell.width / 2;
    const siblings = rows.get(band.row)!;
    const track = TRACK_HEIGHT * (siblings.indexOf(band) + 1);
    const earlier = siblings.filter((other) => other.y < band.y);
    // The padding inside each packed interval is empty. Pick the nearest column which stays
    // outside every earlier line's child footprint; never default to the pane's left edge.
    const gutter = gutters.get(band.row)?.get(band.id) ?? coverX;
    if (!gutters.get(band.row)) throw new RangeError("packed band has no cover routing lane");
    return [band.id, { x: band.x, coverX, coverHeight, width: flow.width, track, bypassColumns: [...gutters.get(band.row)!].filter(([id]) => id !== band.id).map(([, x]) => x), coverColumns: [...flow.cells.values()].filter((cell) => cell.row === band.row && cell.id !== band.id).map((cell) => cell.x + cell.width / 2), stemRoom: Math.max(STACK_STEM_ROOM, TRACK_HEIGHT * siblings.length + 2 * ARROW.length, track + 2 * ARROW.length + TRACK_HEIGHT),
      left: Math.min(band.x, coverX, gutter), right: Math.max(band.x + band.width, coverX, gutter),
      ...(earlier.length ? { bridge: { top: coverHeight + track, gutter } } : {}) }];
  }));
}
/** Translate the subtree as a unit while keeping its parent on its original folder cell. */
export function attachPackedBand(layout: GraphLayout, key: string, bandTop: number, placement: BandPlacement): GraphLayout {
  const first = layout.bandBounds?.top ?? Math.min(...[...layout.nodes].filter(([id]) => id !== key).map(([, node]) => node.y));
  const root = layout.nodes.get(key);
  const stemRoom = placement.stemRoom ?? STACK_STEM_ROOM;
  const attached = attachBand(layout, key, 0, bandTop + stemRoom - (Number.isFinite(first) && root ? first - root.y - root.height : 0));
  const cover = attached.nodes.get(key);
  if (!cover) return attached;
  const dx = placement.x - bandExtent(layout, key).left;
  const translate = (path: string) => {
    let coordinate = 0;
    return path.replace(/-?\d+(?:\.\d+)?/g, (number) => (++coordinate % 2 ? String(Number(number) + dx) : number));
  };
  return { ...attached, width: placement.width,
    nodes: new Map([...attached.nodes].map(([id, node]) => [id, id === key ? { ...node, x: placement.coverX - node.width / 2, height: placement.coverHeight } : { ...node, x: node.x + dx }])),
    junctions: new Map([...attached.junctions].map(([id, dot]) => [id, { ...dot, x: dot.x + dx }])),
    routes: attached.routes.map((route) => {
      const path = translate(route.path);
      const coordinates = route.path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (route.from.kind !== "node" || route.from.id !== key || Math.abs(coordinates[1] - cover.height) > .1) return { ...route, path };
      // Only the outgoing stem changes. Branches, junctions and descendant routes keep their
      // graph-engine geometry. Its bend is entirely above this group's first child row.
      const cut = pathTailAtY(path, bandTop + stemRoom - 16);
      const lane = bandTop + (placement.track ?? 12);
      // A displaced child approach must not descend along another cover’s
      // initial stem. Reach its entry only below all cover bend tracks.
      const dropX = nearestFree(cut.point.x, [...(placement.coverColumns ?? []), ...(placement.bypassColumns ?? [])].map((x): [number, number] => [x - 3.5, x + 3.5]), placement.left, placement.right) ?? cut.point.x;
      const points = [{ x: placement.coverX, y: placement.coverHeight },
        ...(placement.bridge ? [{ x: placement.coverX, y: placement.bridge.top },
          { x: placement.bridge.gutter, y: placement.bridge.top }, { x: placement.bridge.gutter, y: lane }] : [{ x: placement.coverX, y: lane }]),
        { x: dropX, y: lane }, { x: dropX, y: cut.point.y }, cut.point];
      return { ...route, path: `${roundedStem(points)} ${cut.tail}` };
    }),
  };
}

/** Round orthogonal stem corners, clamping the radius for short runs. */
function roundedStem(points: readonly { readonly x: number; readonly y: number }[]): string {
  const distinct = points.filter((point, i) => !i || point.x !== points[i - 1].x || point.y !== points[i - 1].y);
  const corners = distinct.filter((point, i) => !i || i === distinct.length - 1
    || !((distinct[i - 1].x === point.x && point.x === distinct[i + 1].x)
      || (distinct[i - 1].y === point.y && point.y === distinct[i + 1].y)));
  let path = `M${corners[0].x} ${corners[0].y}`;
  for (let i = 1; i < corners.length - 1; i++) {
    const before = corners[i - 1], corner = corners[i], after = corners[i + 1];
    const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2), k = .5522847498;
    const ux = (corner.x - before.x) / incoming, uy = (corner.y - before.y) / incoming;
    const vx = (after.x - corner.x) / outgoing, vy = (after.y - corner.y) / outgoing;
    const a = { x: corner.x - ux * radius, y: corner.y - uy * radius };
    const b = { x: corner.x + vx * radius, y: corner.y + vy * radius };
    path += ` L${a.x} ${a.y} C${a.x + ux * radius * k} ${a.y + uy * radius * k} ${b.x - vx * radius * k} ${b.y - vy * radius * k} ${b.x} ${b.y}`;
  }
  const end = corners.at(-1)!;
  return `${path} L${end.x} ${end.y}`;
}

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
    scope: "current", location: cell.summary?.cover?.path ?? "", state: cell.summary?.cover?.present ? "present" : cell.summary?.active ? "running" : "missing",
    temporary: false, discarded: false, earlierRevision: false, order: 0, prompt: cell.summary?.title ?? "" };
}

/** Attach a pinned layout to the cover row, inserting earlier same-row bands below its stem.
 * Layout emits absolute M/L/C paths. Mapping their y coordinates stretches only the empty stem.
 */
export function attachBand(layout: GraphLayout, key: string, coverTop: number, bandTop: number): GraphLayout {
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
    routes: layout.routes.map((route) => ({ ...route, path: path(route.path) })),
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

/** Closed/virtualized stacks need no pin. Neighboring covers are above the shared child band,
 * so they are not graph obstacles and must not generate outer routing lanes.
 * Vertical packing changes keep the same pin: they change attachment, not graph layout. */
export function gridPins(flow: GridFlow, open: ReadonlySet<string>, previous: ReadonlyMap<string, PinnedCover> = new Map()): ReadonlyMap<string, PinnedCover> {
  return new Map([...open].flatMap((id) => {
    const cell = flow.cells.get(id);
    if (!cell) return [];
    const x = cell.x + cell.width / 2, known = previous.get(id);
    return [[id, known?.key === id && known.x === x && known.obstacles?.length === 0 ? known : { key: id, x, obstacles: [] }] as const];
  }));
}
