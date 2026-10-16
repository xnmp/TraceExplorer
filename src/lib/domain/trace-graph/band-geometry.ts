/** Pure band allocation, ordered grid packing and exact cover attachment. */
import { gridFlow, type GridFlow, type GridItem, type GridMetrics, type GridBand, type GridCell } from "./grid-flow";
import { nearestFree, type GraphLayout, type PlacedNode } from "./layout";
import { packStackGroups, coverGutters } from "./stack-packing";
import { pathTailAtY } from "./path-geometry";
import { numberStart, pathNumbers, scanNumber, scanned } from "./path-data";
import { ARROW, STACK_STEM_ROOM, TRACK_HEIGHT, LANE_SEPARATION, tileSize, spacingFor, type TileMetrics } from "./metrics";
/** Reserve one child generation until a committed layout supplies the actual footprint.
 * Counts include hidden descendants/references, so they cannot predict the number of visible rows.
 * Use the current tile metrics and routing channel; the final layout may settle either way. */
export function estimatedBandExtent(tile: TileMetrics): { width: number; height: number; pending: true } {
  const spacing = spacingFor(tile.width);
  return { width: tile.width + 16,
    height: STACK_STEM_ROOM + tileSize({ foreign: false, hint: true }, tile).height + spacing.bottom, pending: true };
}

/** The child routing footprint; the fixed cover’s header displacement is attached after packing. */
export function bandExtent(layout: GraphLayout, key: string, padding = 8) {
  const cover = layout.nodes.get(key);
  if (layout.bandBounds) return { anchorY: layout.anchorY, anchorX: layout.anchorX, preferredX: layout.preferredX,
    ...layout.bandBounds, height: layout.nodes.size > Number(!!cover) ? Math.max(0, layout.height - layout.bandBounds.top + STACK_STEM_ROOM) : 0 };
  // The first child row: `Math.min` of the other nodes' y (a fold equals the spread, NaN and signed zeros included).
  let first = Infinity, children = 0;
  layout.nodes.forEach((node, id) => { if (id !== key) { first = Math.min(first, node.y); children++; } });
  const scanned = children <= SCANNED_COORDINATES ? scannedExtent(layout, key, first, padding) : null;
  if (scanned) return { anchorY: layout.anchorY, anchorX: layout.anchorX, preferredX: layout.preferredX, ...scanned };
  // The reference, whose spread `Math.min`/`Math.max` may throw on very long lists.
  const nodes = [...layout.nodes].filter(([id]) => id !== key).map(([, node]) => node);
  first = Math.min(...nodes.map((node) => node.y));
  const xs = nodes.flatMap((node) => [node.x - (layout.orientation === "right" ? 16 : 0), node.x + node.width]);
  for (const route of layout.routes) {
    const coordinates = pathNumbers(route.path);
    xs.push(...coordinates.filter((_, i) => i % 2 === 0 && (route.from.kind !== "node" || route.from.id !== key || coordinates[i + 1] >= first - 16)));
  }
  for (const dot of layout.junctions.values()) xs.push(dot.x);
  const left = xs.length ? Math.min(...xs) - padding : (cover?.x ?? 0);
  return { anchorY: layout.anchorY, anchorX: layout.anchorX, preferredX: layout.preferredX, left, width: xs.length ? Math.max(...xs) + padding - left : 0, height: nodes.length ? Math.max(0, layout.height - first + STACK_STEM_ROOM) : 0 };
}

/** Coordinates beyond which {@link bandExtent} keeps its spread `Math.min`/`Math.max`, whose argument limit can throw. */
const SCANNED_COORDINATES = 32768;

/**
 * {@link bandExtent}'s envelope without materialising the x list: min and max do not depend on
 * order (NaN and signed zeros included). Null when the list is long enough that the reference
 * spread calls might throw, so the reference path then runs and throws exactly as before.
 */
function scannedExtent(layout: GraphLayout, key: string, first: number, padding: number) {
  let left = Infinity, right = -Infinity, count = 0, children = 0;
  const shift = layout.orientation === "right" ? 16 : 0;
  layout.nodes.forEach((node, id) => {
    if (id === key) return;
    left = Math.min(left, node.x - shift, node.x + node.width); right = Math.max(right, node.x - shift, node.x + node.width); count += 2; children++;
  });
  for (const route of layout.routes) {
    // Even values are x; a cover route keeps an x only when its y lies at or below the child rows' stem room.
    if (!(route.from.kind === "node" && route.from.id === key)) {
      // Min and max of all the x at once: folding them in another grouping gives the same value.
      const xs = routeXs(route);
      if (xs.count) { left = Math.min(left, xs.min); right = Math.max(right, xs.max); count += xs.count; }
      continue;
    }
    const d = route.path;
    let x = 0, index = 0;
    for (let i = 0; i < d.length;) {
      const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
      if (end < 0) { i++; continue; }
      i = end;
      if (index++ % 2 === 0) x = scanned[0];
      else if (scanned[0] >= first - 16) { left = Math.min(left, x); right = Math.max(right, x); count++; }
    }
  }
  for (const dot of layout.junctions.values()) { left = Math.min(left, dot.x); right = Math.max(right, dot.x); count++; }
  if (count > SCANNED_COORDINATES) return null;
  if (!count) left = layout.nodes.get(key)?.x ?? 0;
  else left -= padding;
  return { left, width: count ? right + padding - left : 0, height: children ? Math.max(0, layout.height - first + STACK_STEM_ROOM) : 0 };
}

/** The x (even-indexed) values among a route path's numbers (as `pathNumbers` reads them): how many, and their min and max. */
interface PathXs {
  readonly path: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
}
/**
 * Per route object, checked against its path: retained routes are measured again on later
 * layouts. Only the summary is kept, so a route measured once costs one small object.
 */
const pathXs = new WeakMap<import("./layout").PlacedRoute, PathXs>();

function routeXs(route: import("./layout").PlacedRoute): PathXs {
  const cached = pathXs.get(route), d = route.path;
  if (cached && cached.path === d) return cached;
  let index = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < d.length;) {
    const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
    if (end < 0) { i++; continue; }
    i = end;
    if (index++ % 2 === 0) { min = Math.min(min, scanned[0]); max = Math.max(max, scanned[0]); }
  }
  const xs: PathXs = { path: d, count: (index + 1) >> 1, min, max };
  pathXs.set(route, xs);
  return xs;
}

/** `Math.min` of the y of the nodes other than `key` (by node key or by map id), as the reference spread computes it. */
function firstRow(layout: GraphLayout, key: string, byId: boolean): number {
  let first = Infinity, count = 0;
  layout.nodes.forEach((node, id) => { if ((byId ? id : node.key) !== key) { first = Math.min(first, node.y); count++; } });
  if (count > SCANNED_COORDINATES) first = byId ? Math.min(...[...layout.nodes].filter(([id]) => id !== key).map(([, node]) => node.y))
    : Math.min(...[...layout.nodes.values()].filter(n => n.key !== key).map(n => n.y));
  return first;
}

/** Capture an immutable candidate's envelope once; attachment only translates it. */
export function withBandBounds(layout: GraphLayout, key: string, padding = 8): GraphLayout {
  if (layout.bandBounds) return layout;
  const extent = bandExtent(layout, key, padding);
  const top = firstRow(layout, key, false);
  return { ...layout, bandBounds: { left: extent.left, width: extent.width, top: Number.isFinite(top) ? top : 0 } };
}

/** Preserve comfortable allocation padding unless the pane requires its painted minimum. */
export function withPaneBandBounds(layout: GraphLayout, key: string, paneWidth: number): GraphLayout {
  const extent = bandExtent(layout, key, 0);
  const padding = Math.max(ARROW.width / 2, Math.min(8, (paneWidth - extent.width) / 2));
  return withBandBounds(layout, key, padding);
}

/** A field of the bounds as `{ ...bandBounds }` copies it: own enumerable properties only. */
const boundsField = (bounds: object, field: "left" | "width"): number | undefined =>
  Object.prototype.propertyIsEnumerable.call(bounds, field) ? (bounds as Record<string, number>)[field] : undefined;

/** `bandExtent(layout, key).left` without building the extent when the bounds are captured. */
const extentLeft = (layout: GraphLayout, key: string) => layout.bandBounds ? boundsField(layout.bandBounds, "left")! : bandExtent(layout, key).left;
/** `bandExtent(layout, key).width` without building the extent when the bounds are captured. */
const extentWidth = (layout: GraphLayout, key: string) => layout.bandBounds ? boundsField(layout.bandBounds, "width")! : bandExtent(layout, key).width;

/** `bandExtent(layout, key)`'s `height` and `width`, without building the extent when the bounds are captured. */
export function extentSize(layout: GraphLayout, key: string): { readonly height: number; readonly width: number } {
  const bounds = layout.bandBounds;
  if (!bounds) return bandExtent(layout, key);
  const cover = layout.nodes.get(key);
  return { height: layout.nodes.size > Number(!!cover) ? Math.max(0, layout.height - bounds.top + STACK_STEM_ROOM) : 0, width: boundsField(bounds, "width")! };
}

const attachmentTrack = (count: number) => count > 1 ? 6 + LANE_SEPARATION + 1 : TRACK_HEIGHT;

export interface StackGridFlow extends GridFlow { readonly rowBands: readonly GridBand[] }
/** One physical band per folder row; each group's footprint reserves only its own interval. */
export function packedGridFlow(items: readonly GridItem[], open: ReadonlyMap<string, { width: number; height: number; preferredX?: number; anchorX?: number; anchorY?: number; pending?: boolean }>, columns: number, metrics: GridMetrics): StackGridFlow {
  const base = gridFlow(items, new Map(), columns, metrics);
  const cells = new Map(base.cells), bands: GridBand[] = [], rowBands: GridBand[] = [];
  const rows = new Map<number, GridCell[]>(), kinds = new Map(items.map((item) => [item.id, item.kind]));
  for (const cell of base.cells.values()) { const row = rows.get(cell.row) ?? []; row.push(cell); rows.set(cell.row, row); }
  let extra = 0;
  for (const [row, members] of rows) {
    for (const cell of members) cells.set(cell.id, { ...cell, y: cell.y + extra });
    const groups = members.flatMap((cell) => {
      const size = open.get(cell.id);
      // An unknown footprint cannot certify that another committed band fits beside it.
      // Reserve a whole line after the committed bands until its first layout arrives:
      // neither a speculative sideways squeeze nor a move of a committed band.
      return size && kinds.get(cell.id) === "stack" ? [{ id: cell.id, center: cell.x + cell.width / 2, ...size, width: size.pending ? base.width : size.width, deferred: !!size.pending }] : [];
    });
    const step = attachmentTrack(groups.length);
    const header = Math.max(STACK_STEM_ROOM, step * groups.length + 2 * ARROW.length);
    const sized = groups.map((group, i) => ({ ...group, height: group.height + Math.max(header, step * (i + 1) + 2 * ARROW.length + step) - STACK_STEM_ROOM }));
    const initial = packStackGroups(sized, base.width, 16, 0);
    // Existing margins usually suffice. Reserve an outer gutter only when the
    // actual stem envelopes need it; a later opening otherwise moves no group.
    const gutterRoom = coverGutters(initial, base.width) ? 0 : 4 * groups.length + 4;
    // A placeholder spans the row inside the gutter, never widening the grid.
    const rowWidth = Math.max(1, base.width - gutterRoom);
    const fits = (group: import("./stack-packing").PackedStackGroup, previous: readonly import("./stack-packing").PackedStackGroup[]) =>
      coverGutters([...previous, group].map((group) => ({ ...group, x: group.x + gutterRoom })), base.width) !== null;
    const packed = packStackGroups(sized.map((group) => group.deferred ? { ...group, width: rowWidth } : group), rowWidth, 16, 0, fits).map((group) => ({ ...group, x: group.x + gutterRoom }));
    const top = members[0].y + extra + metrics.cellHeight;
    const height = Math.max(0, ...packed.map((group) => group.y + group.height));
    // Bands keep their covers' order, so a band's stem track does not change when a placeholder resolves.
    for (const group of [...packed].sort((a, b) => a.center - b.center)) bands.push({ id: group.id, row, x: group.x, y: top + group.y, width: group.width, height: group.height });
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
    const step = attachmentTrack(siblings.length);
    const track = step * (siblings.indexOf(band) + 1);
    const earlier = siblings.filter((other) => other.y < band.y);
    // The padding inside each packed interval is empty. Pick the nearest column which stays
    // outside every earlier line's child footprint; never default to the pane's left edge.
    const gutter = gutters.get(band.row)?.get(band.id) ?? coverX;
    if (!gutters.get(band.row)) throw new RangeError("packed band has no cover routing lane");
    return [band.id, { x: band.x, coverX, coverHeight, width: flow.width, track, bypassColumns: [...gutters.get(band.row)!].filter(([id]) => id !== band.id).map(([, x]) => x), coverColumns: [...flow.cells.values()].filter((cell) => cell.row === band.row && cell.id !== band.id).map((cell) => cell.x + cell.width / 2), stemRoom: Math.max(STACK_STEM_ROOM, step * siblings.length + 2 * ARROW.length, track + 2 * ARROW.length + step),
      left: Math.min(band.x, coverX, gutter), right: Math.max(band.x + band.width, coverX, gutter),
      ...(earlier.length ? { bridge: { top: coverHeight + track, gutter } } : {}) }];
  }));
}
interface BandTransform {
  readonly root: import("./layout").PlacedNode;
  readonly bottom: number;
  readonly dx: number;
  readonly stemRoom: number;
  /** Child rows move by this; the cover row keeps its offset from the cover. */
  readonly childOffset: number;
  readonly mapY: (y: number) => number;
}

/** The one translation attachment applies: x by a constant, cover-row y relative to the cover, child y onto the band. */
function bandTransform(layout: GraphLayout, key: string, bandTop: number, placement: BandPlacement): BandTransform | null {
  const root = layout.nodes.get(key);
  if (!root) return null;
  const first = layout.bandBounds?.top ?? firstRow(layout, key, true);
  const stemRoom = placement.stemRoom ?? STACK_STEM_ROOM;
  const bottom = root.y + root.height;
  const childOffset = bandTop + stemRoom - (Number.isFinite(first) ? first : bottom);
  return { root, bottom, stemRoom, dx: placement.x - extentLeft(layout, key), childOffset, mapY: (y: number) => y <= bottom ? y - root.y : y + childOffset };
}

function attachedNodes(layout: GraphLayout, key: string, placement: BandPlacement, t: BandTransform): GraphLayout["nodes"] {
  const nodes = new Map<string, import("./layout").PlacedNode>();
  layout.nodes.forEach((node, id) => nodes.set(id, id === key
    ? { ...node, x: placement.coverX - node.width / 2, y: t.mapY(node.y), height: placement.coverHeight }
    : { ...node, x: node.x + t.dx, y: t.mapY(node.y) }));
  return nodes;
}

/**
 * `mapPathNumbers(path, (value, index) => index % 2 ? mapY(value) : value + dx)` for the attach
 * transform, also reporting the path's second number (its start y) in `translatedStart[0]`
 * (NaN when it has fewer than two numbers).
 */
function translatePath(d: string, t: BandTransform): string {
  const { dx, bottom, childOffset } = t, top = t.root.y;
  let out = "", copied = 0, index = 0;
  translatedStart[0] = NaN;
  for (let i = 0; i < d.length;) {
    const end = numberStart(d.charCodeAt(i)) ? scanNumber(d, i) : -1;
    if (end < 0) { i++; continue; }
    const value = scanned[0];
    if (index === 1) translatedStart[0] = value;
    out += d.slice(copied, i) + String(index++ % 2 ? (value <= bottom ? value - top : value + childOffset) : value + dx);
    copied = i = end;
  }
  return out + d.slice(copied);
}
const translatedStart = new Float64Array(1);

function translatedJunctions(layout: GraphLayout, dx: number, mapY: (y: number) => number): GraphLayout["junctions"] {
  const junctions = new Map<string, import("./layout").PlacedJunction>();
  layout.junctions.forEach((dot, id) => junctions.set(id, { ...dot, x: dot.x + dx, y: mapY(dot.y) }));
  return junctions;
}

/** `Math.hypot(dx, dy)`; on an axis (every stem run) exactly the other leg's magnitude, without the call. */
const runLength = (dx: number, dy: number): number => dx === 0 ? Math.abs(dy) : dy === 0 ? Math.abs(dx) : Math.hypot(dx, dy);

/**
 * Attached tile rectangles, canvas size and allocation without connector geometry.
 * Exact for every node, `height`, `width` and `bandBounds` of {@link attachPackedBand};
 * routes and junctions are deliberately empty, so it serves only for bounds and anchor checks.
 */
export function attachedSkeleton(layout: GraphLayout, key: string, bandTop: number, placement: BandPlacement): GraphLayout {
  const t = bandTransform(layout, key, bandTop, placement);
  if (!t) return { ...layout, routes: [], junctions: new Map() };
  return { ...layout, width: placement.width, height: t.mapY(layout.height),
    ...(layout.bandBounds ? { bandBounds: { ...layout.bandBounds, left: layout.bandBounds.left + t.dx, top: t.mapY(layout.bandBounds.top) } } : {}),
    nodes: attachedNodes(layout, key, placement, t), junctions: new Map(), routes: [], rows: [] };
}

/** Translate the subtree as a unit while keeping its parent on its original folder cell. */
export function attachPackedBand(layout: GraphLayout, key: string, bandTop: number, placement: BandPlacement): GraphLayout {
  const t = bandTransform(layout, key, bandTop, placement);
  if (!t) return layout;
  const { root, dx, mapY, stemRoom } = t;
  return { ...layout, width: placement.width, height: mapY(layout.height),
    ...(layout.bandBounds ? { bandBounds: { ...layout.bandBounds, left: layout.bandBounds.left + dx, top: mapY(layout.bandBounds.top) } } : {}),
    ...(((layout.anchorX ?? layout.preferredX) !== undefined && Math.abs(placement.x - (layout.anchorX ?? layout.preferredX)!) > .01
      || layout.anchorY !== undefined && Math.abs(bandTop - placement.coverHeight - layout.anchorY) > .01) && layout.decision
      ? { decision: { ...layout.decision, fallback: "packing-infeasible" as const } } : {}),
    nodes: attachedNodes(layout, key, placement, t),
    junctions: translatedJunctions(layout, dx, mapY),
    rows: layout.rows.map(row => ({ ...row, top: mapY(row.top), bottom: mapY(row.bottom) })),
    routes: layout.routes.map(route => {
      const path = translatePath(route.path, t);
      if (route.from.kind !== "node" || route.from.id !== key) return { ...route, path };
      // The untranslated start y (NaN, never near, when the path has no second number).
      const startY = translatedStart[0];
      if (!(Math.abs(mapY(startY) - root.height) <= .1)) return { ...route, path };
      // Only the outgoing stem changes. Branches, junctions and descendant routes keep their
      // graph-engine geometry. Its bend is entirely above this group's first child row.
      const stem = attachedStem(path, bandTop, stemRoom, placement);
      return { ...route, path: `${roundedStem(stem.points)} ${stem.tail}` };
    }),
  };
}

/** The unrounded attachment skeleton and exact child-side tail, also used by scene motion. */
export interface AttachedStem { readonly points: readonly { readonly x: number; readonly y: number }[]; readonly tail: string }
export function attachedStem(path: string, bandTop: number, stemRoom: number, placement: BandPlacement): AttachedStem {
  const cut = pathTailAtY(path, bandTop + stemRoom - 16);
  const lane = bandTop + (placement.track ?? 12);
  const dropX = nearestFree(cut.point.x, [...(placement.coverColumns ?? []), ...(placement.bypassColumns ?? [])].map((x): [number, number] => [x - 3.5, x + 3.5]), placement.left, placement.right) ?? cut.point.x;
  const points = [{ x: placement.coverX, y: placement.coverHeight },
    ...(placement.bridge ? [{ x: placement.coverX, y: placement.bridge.top },
      { x: placement.bridge.gutter, y: placement.bridge.top }, { x: placement.bridge.gutter, y: lane }] : [{ x: placement.coverX, y: lane }]),
    { x: dropX, y: lane }, { x: dropX, y: cut.point.y }, cut.point];
  return { points, tail: cut.tail };
}

/** A root route's attachment, before corners are rounded. Non-root routes have no stem. */
export function bandRouteStem(layout: GraphLayout, key: string, bandTop: number, placement: BandPlacement, route: import("./layout").PlacedRoute): AttachedStem | null {
  const t = bandTransform(layout, key, bandTop, placement);
  if (!t || route.from.kind !== "node" || route.from.id !== key) return null;
  const path = translatePath(route.path, t);
  return Math.abs(t.mapY(translatedStart[0]) - t.root.height) <= .1 ? attachedStem(path, bandTop, t.stemRoom, placement) : null;
}

/** Round orthogonal stem corners, clamping the radius for short runs. */
export function roundedStem(points: readonly { readonly x: number; readonly y: number }[]): string {
  // Drop repeated points, then points inside straight runs, until neither is left: a run that
  // doubles back leaves two equal corners, whose zero-length run has no direction to round.
  let corners: readonly { readonly x: number; readonly y: number }[] = points;
  for (let changed = true; changed;) {
    const distinct: { readonly x: number; readonly y: number }[] = [];
    for (let i = 0; i < corners.length; i++) if (!i || corners[i].x !== corners[i - 1].x || corners[i].y !== corners[i - 1].y) distinct.push(corners[i]);
    const kept: { readonly x: number; readonly y: number }[] = [];
    for (let i = 0; i < distinct.length; i++) {
      const point = distinct[i];
      if (!i || i === distinct.length - 1 || !((distinct[i - 1].x === point.x && point.x === distinct[i + 1].x) || (distinct[i - 1].y === point.y && point.y === distinct[i + 1].y))) kept.push(point);
    }
    changed = kept.length !== corners.length;
    corners = kept;
  }
  let path = `M${corners[0].x} ${corners[0].y}`;
  for (let i = 1; i < corners.length - 1; i++) {
    const before = corners[i - 1], corner = corners[i], after = corners[i + 1];
    const incoming = runLength(corner.x - before.x, corner.y - before.y), outgoing = runLength(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(6, incoming / 2, outgoing / 2), k = .5522847498;
    const ux = (corner.x - before.x) / incoming, uy = (corner.y - before.y) / incoming;
    const vx = (after.x - corner.x) / outgoing, vy = (after.y - corner.y) / outgoing;
    const ax = corner.x - ux * radius, ay = corner.y - uy * radius;
    const bx = corner.x + vx * radius, by = corner.y + vy * radius;
    path += ` L${ax} ${ay} C${ax + ux * radius * k} ${ay + uy * radius * k} ${bx - vx * radius * k} ${by - vy * radius * k} ${bx} ${by}`;
  }
  const end = corners[corners.length - 1];
  return `${path} L${end.x} ${end.y}`;
}

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
    ...(layout.bandBounds ? { bandBounds: { ...layout.bandBounds, top: mapY(layout.bandBounds.top) } } : {}),
    nodes: new Map([...layout.nodes].map(([id, node]) => [id, { ...node, y: mapY(node.y) }])),
    junctions: new Map([...layout.junctions].map(([id, dot]) => [id, { ...dot, y: mapY(dot.y) }])),
    routes: layout.routes.map((route) => ({ ...route, path: path(route.path) })),
    rows: layout.rows.map((row) => ({ ...row, top: mapY(row.top), bottom: mapY(row.bottom) })) };
}


/** Single-stack scoring uses the same skyline and attachment as the rendered grid. */
/** Host cover chrome can differ from the Trace tile; preserve track offsets when scoring locally. */
export function localBandPlacement(placement: BandPlacement, coverHeight: number): BandPlacement {
  return { ...placement, coverHeight, ...(placement.bridge ? { bridge: { ...placement.bridge, top: placement.bridge.top - placement.coverHeight + coverHeight } } : {}) };
}

/** The placement a lone band gets: the committed packing context when known, else the pane centre or pin. */
function singleBandPlacement(layout: GraphLayout, request: import("./layout").LayoutRequest): BandPlacement | null {
  const key = request.band!.key, cover = layout.nodes.get(key);
  if (!cover) return null;
  const extentWidth_ = extentWidth(layout, key);
  const width = Math.max(request.maxWidth, extentWidth_, cover.width);
  const x = Number.isFinite(layout.preferredX) && layout.preferredX! >= 0 && layout.preferredX! + extentWidth_ <= width
    ? layout.preferredX! : Math.max(0, Math.min(width - extentWidth_, (request.pinned?.x ?? width / 2) - extentWidth_ / 2));
  const context = request.history?.attachment?.placement;
  return { ...(context ? localBandPlacement(context, cover.height) : {}), x, coverX: request.pinned?.x ?? width / 2, coverHeight: cover.height, width, left: 0, right: width };
}

export function attachSingleBand(layout: GraphLayout, request: import("./layout").LayoutRequest): GraphLayout {
  if (layout.pinnedViolation) return layout;
  const placement = singleBandPlacement(layout, request);
  return placement ? attachPackedBand(layout, request.band!.key, placement.coverHeight, placement) : layout;
}

/** {@link attachedSkeleton} for {@link attachSingleBand}: nodes and allocation only. */
export function singleBandSkeleton(layout: GraphLayout, request: import("./layout").LayoutRequest): GraphLayout {
  const placement = singleBandPlacement(layout, request);
  return placement ? attachedSkeleton(layout, request.band!.key, placement.coverHeight, placement) : layout;
}
