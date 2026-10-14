/**
 * Width-aware layered layout with channel routing.
 *
 * Generations (bands) run top to bottom. A band whose tiles do not fit the
 * pixel budget wraps onto several display rows, so display rows are not
 * generation boundaries. Rows are separated by tile-free channels; routes cross
 * a channel as a vertical-tangent S-curve and pass intermediate rows through
 * the gaps between tiles, so they never cross a tile and never need long
 * detours along the border. A left-to-right layout (`orientation: "right"`)
 * is the same engine run on transposed tile sizes, its result transposed back.
 *
 * An ELK spike (see docs/trace-view-layout.md) showed that width-bounded ELK
 * layering counts nodes and overflowed the pixel budget on wide fan-outs, so
 * this engine sits behind the `layoutGraph(LayoutRequest) → GraphLayout`
 * boundary instead; callers never depend on how it works.
 */
import { layoutBand } from "./band-layout";
import type { NodeKey } from "./model";
import { buildInputJunctions, endpointKey, type Consumer, type Endpoint, type Junction } from "./junctions";
import { ARROW, bendZones, JUNCTION_BERTH, spacingFor, TRACK_HEIGHT } from "./metrics";

export interface LayoutItem {
  readonly key: NodeKey;
  readonly width: number;
  readonly height: number;
  /** Stable tie-break order. */
  readonly order: number;
  /** Parents; any not present in the request are ignored. */
  readonly parents: readonly NodeKey[];
}

/**
 * Which way generations run: "down" puts parents above their children,
 * "right" puts them to their left (dagre's `rankdir` TB and LR).
 */
export type Orientation = "down" | "right";

/** A cover anchored in the grid row above an open lineage band. */
export interface PinnedCover {
  readonly key: NodeKey;
  /** Absolute tile centre in the measured pane; unchanged even if routing widens the canvas. */
  readonly x: number;
  /** Neighbouring grid tiles' horizontal spans, occupying the cover's row. */
  readonly obstacles?: readonly { readonly x: number; readonly width: number }[];
}

export interface LayoutRequest {
  /** Complete lineage for captions and history compatibility; only items allocate geometry. */
  readonly band?: { readonly key: NodeKey; readonly items: readonly LayoutItem[] };
  readonly history?: BandHistory;
  readonly anchorKey?: NodeKey;
  /**
   * Root alone in row 0; remaining rows align toward its column. Ignored
   * running right, for an unavailable key, or if the tile would lie outside
   * the measured pane. Pins require a finite pane width up to 100,000 px.
   */
  readonly pinned?: PinnedCover;
  readonly items: readonly LayoutItem[];
  /** Pixel width available for the graph. Generations wrap to fit it when they run down; running right, they never wrap. */
  readonly maxWidth: number;
  /** Previous reading order, used to keep ordering stable between relayouts. */
  readonly hint?: ReadonlyMap<NodeKey, number>;
  /** Defaults to "down". */
  readonly orientation?: Orientation;
  /**
   * Running right, the narrowest canvas width to draw: the whole component's
   * estimated sideways width, so a canvas centred in its pane keeps its size,
   * and its tiles their places, while selection reveals or hides generations.
   * Ignored running down (the width budget governs) and when not a positive number.
   */
  readonly extent?: number;
  /**
   * The width of the view's tiles (`TileMetrics.width`), whichever way they
   * run: the spacing around them scales with it (`spacingFor`). Defaults to
   * the default tile.
   */
  readonly tileWidth?: number;
}

export interface PlacedNode {
  readonly key: NodeKey;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly band: number;
  readonly row: number;
}

export interface PlacedJunction {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly parents: readonly NodeKey[];
}

/**
 * One drawn connector. A trunk is the stretch several routes from one source
 * share: it carries all their consumers, has `to === from` and is never
 * terminal; those routes then start where they branch off it.
 */
export interface PlacedRoute {
  readonly id: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly consumers: readonly Consumer[];
  readonly path: string;
  /** Ends at a tile (draws the single arrowhead for that output). */
  readonly terminal: boolean;
}

/**
 * One display row of a generation. `top` and `bottom` bound it along the
 * direction generations run: y when they run down, x when they run right
 * (the row is then a column).
 */
export interface RowBox { readonly index: number; readonly band: number; readonly top: number; readonly bottom: number; readonly keys: readonly NodeKey[] }

export interface BandHistory {
  readonly signature: string;
  readonly layout: GraphLayout;
  /** Last committed geometry after real grid attachment, in cover-relative coordinates. */
  readonly placed: GraphLayout;
  readonly attachment?: { readonly bandTop: number; readonly placement: import("./band-geometry").BandPlacement };
}

export interface BandDecision {
  readonly candidate: string;
  readonly partition?: readonly number[];
  readonly stability: boolean;
  /** `gate-infeasible`: no candidate passed the hard gates (e.g. a cover that is not a root); the downward layout is shown as is. */
  readonly fallback?: "anchor-infeasible" | "packing-infeasible" | "gate-infeasible";
}

export interface GraphLayout {
  readonly decision?: BandDecision;
  /** Preferred child allocation x from committed history; packing may reject it. */
  readonly preferredX?: number;
  /** Active click group: packing preserves this x whenever ordered rectangles fit. */
  readonly anchorX?: number;
  readonly anchorY?: number;
  /** Explicit priced allocation for a retained visible embedding. */
  readonly bandBounds?: { readonly left: number; readonly width: number; readonly top: number };
  /** A non-root cannot be pinned without hiding parentage; the ordinary layout is returned. */
  readonly pinnedViolation?: "not-a-root";
  readonly orientation: Orientation;
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyMap<NodeKey, PlacedNode>;
  readonly junctions: ReadonlyMap<string, PlacedJunction>;
  readonly routes: readonly PlacedRoute[];
  readonly rows: readonly RowBox[];
  /** Reading order of the tiles, usable as the next layout's hint. */
  readonly readingOrder: ReadonlyMap<NodeKey, number>;
}

const round = (value: number) => Math.round(value * 100) / 100;
/** Inserts into a map of ascending number lists, keeping order (later sorts of concatenated runs stay linear). */
const insertSorted = <K>(map: Map<K, number[]>, key: K, value: number) => {
  const list = map.get(key) ?? [];
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle] < value) low = middle + 1; else high = middle; }
  list.splice(low, 0, value);
  map.set(key, list);
};
const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
/** Turn order within a zone: leftward bends by where they end, then where they start; rightward ones reversed. */
const leftwardFirst = (a: { readonly x1: number; readonly x2: number }, b: { readonly x1: number; readonly x2: number }) => a.x2 - b.x2 || a.x1 - b.x1;
const rightwardFirst = (a: { readonly x1: number; readonly x2: number }, b: { readonly x1: number; readonly x2: number }) => b.x2 - a.x2 || b.x1 - a.x1;
/** The root of `index` in a union-find array, compressing the path walked. */
const unitRoot = (unit: number[], index: number): number => unit[index] === index ? index : (unit[index] = unitRoot(unit, unit[index]));
/** The junctions a route from a tile belongs to: none. Shared, as it is never modified. */
const NO_JUNCTIONS: ReadonlySet<string> = new Set();
/** Narrowest separation between lanes sharing a gap. */
const MIN_LANE = 3;
/** Distance kept outside a forbidden interval when stepping past it. */
const FREE_STEP = 0.5;
/** No tile is anywhere near this big; larger sizes are clamped so coordinates stay exact. */
const MAX_TILE = 100_000;
/** A tile size as geometry uses it: not a finite, positive number counts as zero; capped at MAX_TILE. */
const boundSize = (value: number) => Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TILE) : 0;
export { TRACK_HEIGHT };

/** Splits an ordered sequence into the fewest rows, then balances row widths. */
export function wrapRow(widths: readonly number[], limit: number, gap: number): number[][] {
  if (!widths.length) return [];
  let widest = 0;
  for (let index = 0; index < widths.length; index++) if (index in widths) widest = Math.max(widest, widths[index]);
  const target = countWrapped(widths, Math.max(limit, widest), gap);
  if (target === 1) return greedyRows(widths, Math.max(limit, widest), gap);
  // Smallest bound that still needs no more rows: evens out the last row.
  let low = widest;
  let high = Math.max(limit, widest);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (countWrapped(widths, middle, gap) <= target) high = middle; else low = middle;
  }
  return greedyRows(widths, countWrapped(widths, low, gap) <= target ? low : high, gap);
}

/** {@link wrapRow}'s rows at one bound: each takes tiles while they fit (holes in `widths` are skipped). */
function greedyRows(widths: readonly number[], bound: number, gap: number): number[][] {
  const rows: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (let index = 0; index < widths.length; index++) {
    if (!(index in widths)) continue;
    const width = widths[index];
    const next = current.length ? used + gap + width : width;
    if (current.length && next > bound) { rows.push(current); current = [index]; used = width; }
    else { current.push(index); used = next; }
  }
  rows.push(current);
  return rows;
}

/** `greedyRows(widths, bound, gap).length`, without building the rows. */
function countWrapped(widths: readonly number[], bound: number, gap: number): number {
  let rows = 1, filled = 0, used = 0;
  for (let index = 0; index < widths.length; index++) {
    if (!(index in widths)) continue;
    const width = widths[index];
    const next = filled ? used + gap + width : width;
    if (filled && next > bound) { rows++; filled = 1; used = width; }
    else { filled++; used = next; }
  }
  return rows;
}

type Interval = readonly [number, number];

/** Sorted, disjoint intervals; any closer than FREE_STEP are merged, so a point just past either end of one is free. */
export function mergeIntervals(intervals: readonly Interval[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + FREE_STEP) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Merges intervals already sorted by start. */
function mergeSortedStarts(intervals: readonly Interval[]): [number, number][] {
  return unionMerged(intervals, []);
}

/** The union of two merged lists, in linear time. */
function unionMerged(a: readonly Interval[], b: readonly Interval[]): [number, number][] {
  const result: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    const [start, end] = j >= b.length || (i < a.length && a[i][0] <= b[j][0]) ? a[i++] : b[j++];
    const last = result.at(-1);
    if (last && start <= last[1] + FREE_STEP) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** `nearestFree` over intervals already merged: a binary search. */
function nearestOutside(preferred: number, merged: readonly Interval[], low: number, high: number): number | null {
  if (!(low <= high)) return null;
  const point = Math.min(high, Math.max(low, preferred));
  let index = -1;
  for (let lo = 0, hi = merged.length - 1; lo <= hi;) {
    const middle = (lo + hi) >> 1;
    if (merged[middle][0] <= point) { index = middle; lo = middle + 1; } else hi = middle - 1;
  }
  if (index < 0 || merged[index][1] < point) return point;
  const [start, end] = merged[index];
  const below = start - FREE_STEP >= low ? start - FREE_STEP : low < start ? low : null;
  const above = end + FREE_STEP <= high ? end + FREE_STEP : high > end ? high : null;
  if (below === null) return above;
  if (above === null) return below;
  return Math.abs(above - preferred) < Math.abs(below - preferred) ? above : below;
}

/** The point nearest `preferred` within [low, high] that lies in none of the intervals (their ends count as inside). */
export function nearestFree(preferred: number, intervals: readonly Interval[], low: number, high: number): number | null {
  return nearestOutside(preferred, mergeIntervals(intervals), low, high);
}

/** A short, stable hash of a string (FNV-1a). */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

export function layoutGraph(request: LayoutRequest): GraphLayout {
  if (!request || !Array.isArray(request.items)) throw new RangeError("malformed layout request");
  return request.band ? layoutBand(request) : layoutLayered(request);
}

/** The reusable layered engine; band candidates call it without recursively planning bands. */
export function layoutLayered(request: LayoutRequest): GraphLayout {
  if (request.orientation !== "right") return layoutDown(request, spacingFor(request.tileWidth).minWidth);
  // Left to right: the same engine on transposed tiles, transposed back.
  // Generations then form columns that never wrap (no height budget), and
  // the canvas needs no minimum height.
  const turned = transposeLayout(layoutDown({ items: request.items.map((item) => ({ ...item, width: item.height, height: item.width })), maxWidth: Infinity, hint: request.hint, tileWidth: request.tileWidth }, 0));
  const extent = request.extent !== undefined && Number.isFinite(request.extent) && request.extent > 0 ? Math.ceil(request.extent) : 0;
  return extent > turned.width ? { ...turned, width: extent } : turned;
}

const isDigitCode = (code: number) => code >= 48 && code <= 57;
/** End of the longest `-?\d+(?:\.\d+)?` at `i`, or -1: the only way that pattern can match there. */
function plainNumberEnd(text: string, i: number): number {
  let j = text.charCodeAt(i) === 45 ? i + 1 : i;
  if (!isDigitCode(text.charCodeAt(j))) return -1;
  while (isDigitCode(text.charCodeAt(j))) j++;
  if (text.charCodeAt(j) === 46 && isDigitCode(text.charCodeAt(j + 1))) { j += 2; while (isDigitCode(text.charCodeAt(j))) j++; }
  return j;
}

/**
 * `text.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, "$2 $1")` without a regular expression.
 * A shorter first number is always followed by a digit or ".", never the space, so the
 * pattern matches at a position exactly when the longest first number is followed by a space
 * and a second number, which it then takes whole; the search resumes after the match, or one
 * character on.
 */
function swapPairs(text: string): string {
  let out = "", copied = 0;
  for (let i = 0; i < text.length;) {
    const first = plainNumberEnd(text, i);
    const second = first >= 0 && text.charCodeAt(first) === 32 ? plainNumberEnd(text, first + 1) : -1;
    if (second < 0) { i++; continue; }
    out += text.slice(copied, i) + text.slice(first + 1, second) + " " + text.slice(i, first);
    copied = i = second;
  }
  return copied ? out + text.slice(copied) : text;
}

/** Mirrors a layout across its diagonal: x and y (and widths and heights) trade places. */
export function transposeLayout(layout: GraphLayout): GraphLayout {
  const nodes = new Map<NodeKey, PlacedNode>();
  layout.nodes.forEach((node, key) => nodes.set(key, { ...node, x: node.y, y: node.x, width: node.height, height: node.width }));
  const junctions = new Map<string, PlacedJunction>();
  layout.junctions.forEach((junction, id) => junctions.set(id, { ...junction, x: junction.y, y: junction.x }));
  return {
    orientation: layout.orientation === "down" ? "right" : "down",
    width: layout.height,
    height: layout.width,
    nodes,
    junctions,
    routes: layout.routes.map((route) => ({ ...route, path: swapPairs(route.path) })),
    rows: layout.rows,
    readingOrder: layout.readingOrder,
  };
}

/** The top-to-bottom engine; `minWidth` is the narrowest canvas it draws (within the budget). */
function layoutDown(request: LayoutRequest, minWidth: number): GraphLayout {
  // Outer margins hold every lane that does not fit between tiles, and the
  // junctions a crowded channel has no column for. When they overflow, they
  // widen (the graph scrolls horizontally) rather than letting lanes merge or
  // dots stack. Legacy placement needs two retries. A pinned band can first
  // consume spare pane width; moving rows within that width changes gap slots,
  // so allow two further routing passes to settle the new slot choices.
  const prepared = prepare(request);
  let extra = { left: 0, right: 0 };
  const attempts = prepared.pinned ? 4 : 2;
  for (let attempt = 0; ; attempt++) {
    const { layout, shortfall } = layoutPass(prepared, extra, minWidth, attempt === attempts);
    if (layout) return layout;
    extra = { left: extra.left + Math.max(0, Math.ceil(shortfall.left)), right: extra.right + Math.max(0, Math.ceil(shortfall.right)) };
  }
}

/**
 * Lower bounds for the child band of the pinned downward layout of `request`
 * (as built by {@link layoutLayered} with `orientation: "down"`), computed from
 * its display rows alone, before any routing: the band's height (from the first
 * child row to the last row's bottom, plus the bottom margin and `stemRoom`), its
 * child allocation width (tile span plus 8 px padding each side) and the connector
 * ink of a tree (each non-cover source's routes reach a child at least one
 * generation channel below it). Mirrors {@link layoutPass}: longest-path
 * generations wrap greedily onto rows of the content width, a row is as tall as
 * its tallest tile, and the channel below a row is at least `rowChannel` inside a
 * generation and `bandChannel` below its last row. Null unless the cover is
 * generation 0's only tile (otherwise its first child row is not known here).
 */
export function downwardBandBound(request: LayoutRequest, coverKey: NodeKey, stemRoom: number): { readonly height: number; readonly width: number; readonly length: number } | null {
  const space = spacingFor(request.tileWidth), gap = space.column;
  // Index-based throughout (this runs on every band layout, mostly tiny ones):
  // item i's parents, children and generation live in arrays indexed by i.
  const list = request.items, count = list.length;
  const indexOf = new Map<NodeKey, number>();
  for (let i = 0; i < count; i++) indexOf.set(list[i].key, i);
  if (indexOf.size !== count || !indexOf.has(coverKey)) return null;
  const cover = indexOf.get(coverKey)!;
  const parents: number[][] = [], children: number[][] = [];
  for (let i = 0; i < count; i++) children.push([]);
  for (let i = 0; i < count; i++) {
    const key = list[i].key, own: number[] = [];
    // Distinct present parents other than the item itself, in first-seen order
    // (what spreading a Set of them, then filtering, gives).
    const given = list[i].parents;
    const distinct: readonly NodeKey[] = Array.isArray(given) ? given : [...new Set(given)];
    for (let p = 0; p < distinct.length; p++) {
      const parent = distinct[p];
      if (parent === key) continue;
      const at = indexOf.get(parent);
      if (at === undefined || own.includes(at)) continue;
      own.push(at);
    }
    parents.push(own);
    for (const at of own) children[at].push(i);
  }
  // Longest-path generations; a cycle has no defined generations here.
  const band = new Array<number>(count).fill(-1), waiting = new Array<number>(count);
  const ready: number[] = [];
  for (let i = 0; i < count; i++) { waiting[i] = parents[i].length; if (!waiting[i]) ready.push(i); }
  for (let r = 0; r < ready.length; r++) {
    const at = ready[r];
    let most = 0;
    for (const parent of parents[at]) if (band[parent] + 1 > most) most = band[parent] + 1;
    band[at] = most;
    for (const child of children[at]) if (!--waiting[child]) ready.push(child);
  }
  if (ready.length !== count || band[cover] !== 0) return null;
  // Generations' members in the order they became ready.
  const byBand: number[][] = [];
  for (const at of ready) (byBand[band[at]] ??= []).push(at);
  if (byBand[0].length !== 1 || byBand.length < 2) return null;
  const widths = new Array<number>(count), heights = new Array<number>(count);
  let widest = 0;
  for (let i = 0; i < count; i++) {
    widths[i] = boundSize(list[i].width); heights[i] = boundSize(list[i].height);
    if (widths[i] > widest) widest = widths[i];
  }
  let natural = 0;
  for (const members of byBand) {
    let sum = 0;
    for (const at of members) sum += widths[at];
    natural = Math.max(natural, sum + Math.max(0, members.length - 1) * gap);
  }
  const budget = Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : Infinity;
  const limit = Math.max(widest, Math.min(natural, Math.max(widest, budget - 2 * space.margin)));
  let height = 0, width = 0;
  for (let b = 1; b < byBand.length; b++) {
    const members = byBand[b], size = members.length, first = widths[members[0]];
    // Uniform widths wrap into exactly `perRow` tiles per full row whatever their order;
    // otherwise every row's tiles and gaps fit the content width.
    let uniform = true, tallest = 0, shortest = Infinity;
    for (const at of members) {
      if (widths[at] !== first) uniform = false;
      if (heights[at] > tallest) tallest = heights[at];
      if (heights[at] < shortest) shortest = heights[at];
    }
    let perRow = 1;
    if (uniform) for (let used = first; perRow < size && used + gap + first <= limit; perRow++) used += gap + first;
    let rows: number;
    if (uniform) rows = Math.ceil(size / perRow);
    else {
      let sum = 0;
      for (const at of members) sum = sum + widths[at] + gap;
      rows = Math.max(1, Math.ceil(sum / (limit + gap)));
    }
    // The i-th tallest row is at least as tall as the (i·perRow+1)-th tallest tile.
    if (uniform && rows > 1) {
      const sorted = members.map((at) => heights[at]).sort((x, y) => y - x);
      for (let row = 0; row < rows; row++) height += sorted[row * perRow];
    } else for (let row = 0; row < rows; row++) height += row ? shortest : tallest;
    height += (rows - 1) * space.rowChannel + (b < byBand.length - 1 ? space.bandChannel : 0);
    // Balanced or not, some row holds at least the average number of tiles.
    const fullest = uniform ? Math.ceil(size / rows) : 1;
    width = Math.max(width, uniform ? fullest * first + (fullest - 1) * gap : widest);
  }
  let tree = true, sources = 0;
  for (let i = 0; i < count; i++) {
    if (i !== cover && parents[i].length !== 1) tree = false;
    if (i !== cover && children[i].length) sources++;
  }
  if (!tree) sources = 0;
  // Tile x is rounded to 0.01 px and attachment reassociates sums: stay strictly below.
  return { height: height + space.bottom + stemRoom - 1e-6, width: Math.max(0, width + 16 - .02 - 1e-6),
    length: Math.max(0, sources * (space.bandChannel - ARROW.length) - 1e-6) };
}

/**
 * Everything about a request that does not depend on a pass's extra margins:
 * computed once and shared by every pass of {@link layoutDown}.
 */
function prepare(request: LayoutRequest) {
  // Malformed input never spreads through the geometry: a size that is not a
  // finite, non-negative number counts as zero, sizes are capped far above
  // any tile, and an order that is not a number sorts first (ties by key).
  const space = spacingFor(request.tileWidth);
  // Only these fields of an item are read here (a later duplicate key replaces the
  // earlier item but keeps its position, as a Map built from the list does).
  const items = new Map<NodeKey, { readonly width: number; readonly height: number; readonly order: number; readonly parents: readonly NodeKey[] }>();
  for (const item of request.items) items.set(item.key, { width: boundSize(item.width), height: boundSize(item.height), order: Number.isFinite(item.order) ? item.order : 0, parents: item.parents });
  const keys = [...items.keys()];
  // Distinct present parents other than the key itself, in first-seen order.
  const parentsByKey = new Map<NodeKey, NodeKey[]>();
  for (const key of keys) {
    const given = items.get(key)!.parents;
    const list: NodeKey[] = [];
    if (Array.isArray(given)) {
      // Distinct by SameValueZero, as a Set is; a duplicate passes the filter exactly when its first copy did.
      for (let i = 0; i < given.length; i++) { const parent = given[i]; if (parent !== key && items.has(parent) && !list.includes(parent)) list.push(parent); }
    } else for (const parent of new Set(given)) if (parent !== key && items.has(parent)) list.push(parent);
    parentsByKey.set(key, list);
  }
  const parentsOf = (key: NodeKey) => parentsByKey.get(key)!;

  // Longest-path bands, computed iteratively so deep edit chains cannot
  // exhaust the stack. Cycles (already rejected upstream) are cut at the back edge.
  const bands = new Map<NodeKey, number>();
  const visiting = new Set<NodeKey>();
  const stack: NodeKey[] = [];
  for (const start of keys) {
    if (bands.has(start)) continue;
    stack.push(start);
    while (stack.length) {
      const key = stack[stack.length - 1];
      if (bands.has(key)) { stack.pop(); continue; }
      visiting.add(key);
      // Parents still to visit go on the stack in order; the key is revisited after them.
      const parents = parentsOf(key), height = stack.length;
      for (const parent of parents) if (!bands.has(parent) && !visiting.has(parent)) stack.push(parent);
      if (stack.length > height) continue;
      let value = 0;
      for (const parent of parents) { const known = bands.get(parent); if (known !== undefined && known + 1 > value) value = known + 1; }
      bands.set(key, value);
      visiting.delete(key);
      stack.pop();
    }
  }
  let bandCount = 0;
  for (const value of bands.values()) if (value + 1 > bandCount) bandCount = value + 1;
  const pinnedViolation = request.pinned && bands.has(request.pinned.key) && bands.get(request.pinned.key) !== 0 ? "not-a-root" as const : undefined;

  const relationships: { child: NodeKey; parents: NodeKey[] }[] = [];
  for (const child of keys) relationships.push({ child, parents: parentsOf(child) });
  const plan = buildInputJunctions(relationships);
  const gap = space.column;
  const margin = space.margin;
  const widest = keys.reduce((most, key) => Math.max(most, items.get(key)!.width), 0);
  const byBand: NodeKey[][] = Array.from({ length: bandCount }, () => []);
  for (const key of keys) byBand[bands.get(key)!].push(key);
  const natural = byBand.reduce((most, members) => Math.max(most, members.reduce((sum, key) => sum + items.get(key)!.width, 0) + Math.max(0, members.length - 1) * gap), 0);
  const budget = Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : Infinity;
  // Pins are absolute grid coordinates. Reject malformed positions instead
  // of letting them escape the canvas or enter spatial buckets so large that
  // integer increments stop advancing. Ordinary layout still accepts an
  // unbounded width; a pinned grid requires a real, bounded measurement.
  const pin = request.pinned;
  const pinHalf = pin ? (items.get(pin.key)?.width ?? 0) / 2 : 0;
  const pinned = pin && bands.get(pin.key) === 0 && Number.isFinite(pin.x)
    && budget <= MAX_TILE && pin.x >= pinHalf && pin.x <= budget - pinHalf ? pin : undefined;
  const contentLimit = Math.max(widest, budget - 2 * margin);
  const contentWidth = Math.max(widest, Math.min(natural, contentLimit));

  // One total order for ties: hinted keys keep their previous relative order
  // and new keys merge in by creation order. A pairwise comparator mixing the
  // two criteria would not be transitive.
  const byOrder = (a: NodeKey, b: NodeKey) => items.get(a)!.order - items.get(b)!.order || a.localeCompare(b);
  const hint = request.hint;
  const hinted = keys.filter((key) => hint?.has(key)).sort((a, b) => hint!.get(a)! - hint!.get(b)! || byOrder(a, b));
  const fresh = keys.filter((key) => !hint?.has(key)).sort(byOrder);
  const rank = new Map<NodeKey, number>();
  for (let i = 0, j = 0; i < hinted.length || j < fresh.length;) {
    const next = j >= fresh.length || (i < hinted.length && byOrder(hinted[i], fresh[j]) <= 0) ? hinted[i++] : fresh[j++];
    rank.set(next, rank.size);
  }
  // Generation 0 has no parents to follow, so its order (rank alone) is the same every pass.
  const firstBand = byBand.length ? byBand[0].filter((key) => !pinned || key !== pinned.key).sort((a, b) => rank.get(a)! - rank.get(b)!) : [];

  const { joinFacts, ordered, targetsOf } = plan.joins.length ? junctionFacts(plan, bands) : NO_JOINS;
  // Route ids join endpoint keys with ">" (and trunk ids with "~"); while no key holds
  // either, the plan's routes (distinct by their ends) have ids distinct from each other and
  // from every trunk id, so they need no collision check.
  let plainKeys = true;
  for (const key of keys) if (typeof key !== "string" || key.includes(">") || key.includes("~")) { plainKeys = false; break; }
  return {
    space, items, keys, parentsOf, bandCount, byBand, pinnedViolation, plan, joinFacts, ordered, targetsOf, plainKeys,
    gap, margin, budget, pinned, contentWidth, rank, firstBand, firstRows: wrapRow(firstBand.map((key) => items.get(key)!.width), contentWidth, gap),
  };
}
type Prepared = ReturnType<typeof prepare>;

/** What does not move between passes about where a junction goes: its band, consumers, what it may sit on, and its nested junctions. */
interface JoinFacts { readonly bandIndex: number; readonly consumers: NodeKey[]; readonly own: ReadonlySet<NodeKey>; readonly nestedJoins: string[] }
interface JunctionFacts {
  readonly joinFacts: ReadonlyMap<string, JoinFacts>;
  /** Junctions in placement order: shallowest nesting first, then by id. */
  readonly ordered: readonly Junction[];
  /** What each source (an endpoint key) feeds directly, by endpoint key. */
  readonly targetsOf: ReadonlyMap<string, ReadonlySet<string>>;
}
/** A plan without junctions: nothing to place, and no pass reads the targets (only deferred junctions do). */
const NO_JOINS: JunctionFacts = { joinFacts: new Map(), ordered: [], targetsOf: new Map() };

/** The pass-invariant facts about a plan's junctions, given each tile's generation. */
function junctionFacts(plan: ReturnType<typeof buildInputJunctions>, bands: ReadonlyMap<NodeKey, number>): JunctionFacts {
  const joins = new Map(plan.joins.map((join) => [join.id, join]));
  const joinBands = new Map(plan.joins.map((join) => [join.id, join.parents.reduce((most, id) => Math.max(most, bands.get(id)!), 0)]));
  const depths = new Map<string, number>();
  const joinDepth = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const join = joins.get(id)!;
    const nested = join.inputs.filter((input) => input.kind === "junction" && joinBands.get(input.id) === joinBands.get(id));
    const depth = 1 + Math.max(0, ...nested.map((input) => joinDepth(input.id)));
    depths.set(id, depth);
    return depth;
  };
  plan.joins.forEach((join) => joinDepth(join.id));
  const consumersOf = new Map<string, Set<NodeKey>>();
  for (const route of plan.routes) {
    if (route.from.kind !== "junction") continue;
    const set = consumersOf.get(route.from.id) ?? new Set<NodeKey>();
    for (const item of route.consumers) set.add(item.child);
    consumersOf.set(route.from.id, set);
  }
  // What each source feeds directly: a junction may sit on a parent's exit
  // only if nothing else leaves that parent, or the other routes would run
  // straight through the dot.
  const targetsOf = new Map<string, Set<string>>();
  for (const route of plan.routes) {
    const source = endpointKey(route.from);
    const set = targetsOf.get(source) ?? new Set<string>();
    set.add(endpointKey(route.to));
    targetsOf.set(source, set);
  }
  const joinFacts = new Map(plan.joins.map((join) => {
    const consumers = [...consumersOf.get(join.id) ?? []];
    const self = endpointKey({ kind: "junction", id: join.id });
    const solelyHere = (parent: NodeKey) => [...targetsOf.get(endpointKey({ kind: "node", id: parent })) ?? []].every((target) => target === self);
    const own: ReadonlySet<NodeKey> = new Set<NodeKey>([...join.parents.filter(solelyHere), ...consumers]);
    const nestedJoins = join.inputs.filter((input) => input.kind === "junction").map((input) => input.id);
    return [join.id, { bandIndex: joinBands.get(join.id)!, consumers, own, nestedJoins }] as const;
  }));
  const ordered = [...plan.joins].sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || a.id.localeCompare(b.id));
  return { joinFacts, ordered, targetsOf };
}

/**
 * One routing pass with `extra` room in the margins. Its layout is null when
 * the margins fall short and a further pass (not the `last`) will widen them:
 * the shortfall is known once lanes and junctions are placed, so such a pass
 * stops there instead of drawing what would be thrown away.
 */
function layoutPass(prepared: Prepared, extra: { readonly left: number; readonly right: number }, minWidth: number, last: boolean): { layout: GraphLayout | null; shortfall: { left: number; right: number } } {
  const { space, items, parentsOf, bandCount, byBand, pinnedViolation, plan, joinFacts, ordered, targetsOf, plainKeys, gap, margin, budget, pinned, contentWidth, rank } = prepared;
  // A pinned band already spans the pane. Spend its unused horizontal room
  // on extra routing margins before widening it; centred legacy canvases
  // start tightly around their content and still widen by the full shortfall.
  let width = Math.max(contentWidth + 2 * margin, Math.min(minWidth, budget), pinned ? budget : 0)
    + (pinned ? 0 : extra.left + extra.right);

  // 1. Horizontal placement. Each band is ordered, wrapped onto display rows
  // and centered (or aligned toward the pinned cover). Vertical positions come last, once junction levels and
  // bend tracks have claimed the channel space they need.
  interface Column { readonly x: number; readonly row: number; readonly band: number }
  const columns = new Map<NodeKey, Column>();
  const rowKeys: { band: number; keys: NodeKey[] }[] = [];
  const reading = new Map<NodeKey, number>();
  const lastRowOfBand = new Map<number, number>();
  const center = (key: NodeKey) => columns.get(key)!.x + items.get(key)!.width / 2;
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
    if (bandIndex === 0 && pinned) {
      columns.set(pinned.key, { x: pinned.x - items.get(pinned.key)!.width / 2, row: 0, band: 0 });
      reading.set(pinned.key, reading.size);
      rowKeys.push({ band: 0, keys: [pinned.key] });
      lastRowOfBand.set(0, 0);
    }
    let members: NodeKey[], wrapped: number[][];
    if (bandIndex === 0) ({ firstBand: members, firstRows: wrapped } = prepared);
    else {
      // Barycenter of parents in reading order (row first, then x) keeps
      // children near their parents even when parent rows wrapped. Parents
      // lie in earlier bands, already placed, so each score is computed once.
      const score = new Map<NodeKey, number>();
      for (const key of byBand[bandIndex]) {
        const parents = parentsOf(key);
        let sum = 0;
        for (const parent of parents) sum = sum + columns.get(parent)!.row * 1e6 + center(parent);
        score.set(key, sum / parents.length);
      }
      members = byBand[bandIndex].filter((key) => !pinned || key !== pinned.key).sort((a, b) => score.get(a)! - score.get(b)! || rank.get(a)! - rank.get(b)!);
      const widths: number[] = [];
      for (const key of members) widths.push(items.get(key)!.width);
      wrapped = wrapRow(widths, contentWidth, gap);
    }
    for (const indices of wrapped) {
      const keysInRow: NodeKey[] = [];
      let rowWidth = 0;
      for (const index of indices) { keysInRow.push(members[index]); rowWidth += items.get(members[index])!.width; }
      rowWidth += (keysInRow.length - 1) * gap;
      if (pinned) width = Math.max(width, rowWidth + 2 * margin + extra.left + extra.right);
      const left = extra.left + margin;
      const right = width - extra.right - margin - rowWidth;
      let x = pinned
        ? Math.max(left, Math.min(right, pinned.x - rowWidth / 2))
        : extra.left + (width - extra.left - extra.right - rowWidth) / 2;
      const row = rowKeys.length;
      for (const key of keysInRow) {
        columns.set(key, { x: round(x), row, band: bandIndex });
        reading.set(key, reading.size);
        x += items.get(key)!.width + gap;
      }
      rowKeys.push({ band: bandIndex, keys: keysInRow });
      lastRowOfBand.set(bandIndex, row);
    }
  }
  const spanCache = new Map<number, { key: NodeKey; x: number; width: number }[]>();
  const spans = (row: number) => {
    let cached = spanCache.get(row);
    if (!cached) {
      // Tile placement already orders spans by x. Only grid obstacles need merging.
      cached = (rowKeys[row]?.keys ?? []).map((key) => ({ key, x: columns.get(key)!.x, width: items.get(key)!.width }));
      if (row === 0 && pinned) cached = [
        ...cached,
        ...(pinned.obstacles ?? [])
          .filter((box) => Number.isFinite(box.x) && Number.isFinite(box.width) && box.width > 0 && box.x >= 0 && box.x + box.width <= budget)
          .map((box, index) => ({ ...box, key: `__grid_obstacle_${index}` })),
      ].sort((a, b) => a.x - b.x);
      spanCache.set(row, cached);
    }
    return cached;
  };

  // 2. Junctions. Each prefers a point between its parents and consumers and
  // takes the nearest x, at the shallowest level allowed by its nesting, that
  // keeps it apart from junctions on its level, off every other junction's
  // column in its channel, and off the vertical runs other routes may take
  // (tile exits above, arrow entries below, and the gaps and margins lanes
  // use). A full level opens a deeper one. A junction finding no such x is
  // placed after lanes (step 3b), against the runs routes actually take; and
  // junctions on one level never overlap.
  type Keepout = { readonly low: number; readonly high: number; readonly key: NodeKey | null };
  const berth = JUNCTION_BERTH + 2;
  const runs = (row: number): Keepout[] => {
    const boxes = spans(row);
    if (!boxes.length) return [];
    const first = boxes[0], last = boxes.at(-1)!;
    return [
      ...boxes.map((box) => ({ low: box.x + box.width / 2 - berth, high: box.x + box.width / 2 + berth, key: box.key })),
      ...boxes.slice(1).map((box, index) => ({ low: boxes[index].x + boxes[index].width - berth, high: box.x + berth, key: null })),
      { low: -Infinity, high: first.x, key: null },
      { low: last.x + last.width, high: Infinity, key: null },
    ];
  };
  const placed = new Map<string, { x: number; level: number; channel: number }>();
  const runsNear = new Map<number, Keepout[]>();
  const onLevel = new Map<string, number[]>();
  const inChannel = new Map<number, number[]>();
  const channelDepth = new Map<number, number>();
  const bandLevels = new Map<number, number>();
  /** Where a junction wants to be, and what it may sit on. */
  const situate = (join: Junction) => {
    const { bandIndex, consumers, own, nestedJoins } = joinFacts.get(join.id)!;
    const parentX = join.parents.reduce((sum, id) => sum + center(id), 0) / join.parents.length;
    const targetX = consumers.length ? consumers.reduce((sum, id) => sum + center(id), 0) / consumers.length : parentX;
    const channel = lastRowOfBand.get(bandIndex)!;
    let deepestNested = 0;
    for (const id of nestedJoins) { const spot = placed.get(id); if (spot?.channel === channel) deepestNested = Math.max(deepestNested, spot.level); }
    const minLevel = 1 + deepestNested;
    const preferred = Math.min(width - 14, Math.max(14, parentX * 0.6 + targetX * 0.4));
    return { bandIndex, channel, own, minLevel, preferred };
  };
  type Situation = ReturnType<typeof situate>;
  const onLevelOf = (channel: number, level: number) => onLevel.get(`${channel}:${level}`) ?? [];
  /**
   * The nearest x on the shallowest level allowed, clear of `keepouts` (sorted
   * by start); `stacking` also keeps it off every other dot's column.
   */
  const search = ({ channel, minLevel, preferred }: Situation, keepouts: readonly Interval[], stacking: boolean, deepest: number) => {
    // Every list here is sorted already, so merging stays linear.
    const merged = stacking
      ? unionMerged(mergeSortedStarts(keepouts), mergeSortedStarts((inChannel.get(channel) ?? []).map((other) => [other - berth, other + berth] as const)))
      : mergeSortedStarts(keepouts);
    // Levels only add same-level spacing: no room here means none on any level.
    if (nearestOutside(preferred, merged, 14, width - 14) === null) return null;
    for (let level = minLevel; level <= deepest; level++) {
      // Junctions on a level are kept sorted, so their spacing needs no sort.
      const spacing = mergeSortedStarts(onLevelOf(channel, level).map((other) => [other - space.junctionSpacing, other + space.junctionSpacing] as const));
      const x = nearestOutside(preferred, spacing.length ? unionMerged(merged, spacing) : merged, 14, width - 14);
      if (x !== null) return { x, level };
    }
    return null;
  };
  const settle = (join: Junction, { bandIndex, channel }: Situation, { x, level }: { x: number; level: number }) => {
    insertSorted(onLevel, `${channel}:${level}`, x);
    insertSorted(inChannel, channel, x);
    channelDepth.set(channel, Math.max(channelDepth.get(channel) ?? 0, level));
    bandLevels.set(bandIndex, Math.max(bandLevels.get(bandIndex) ?? 0, level));
    placed.set(join.id, { x: round(x), level, channel });
  };
  // First pass: every constraint, with the vertical runs other routes may
  // take (whole gaps and margins) kept out. A junction finding no such spot,
  // or nesting one that did not, is deferred until lanes are known; it holds
  // a provisional spot meanwhile, which only steers lane choice.
  const deferred: { join: Junction }[] = [];
  const isDeferred = new Set<string>();
  for (const join of ordered) {
    const situation = situate(join);
    const { channel, own, minLevel, preferred } = situation;
    if (!runsNear.has(channel)) runsNear.set(channel, [...runs(channel), ...runs(channel + 1)].sort((a, b) => a.low - b.low));
    const keepouts = runsNear.get(channel)!.filter((run) => !run.key || !own.has(run.key)).map((run) => [run.low, run.high] as const);
    const nestsDeferred = join.inputs.some((input) => input.kind === "junction" && isDeferred.has(input.id));
    const choice = nestsDeferred ? null : search(situation, keepouts, true, Math.max(minLevel, channelDepth.get(channel) ?? 0) + 1);
    if (choice) { settle(join, situation, choice); continue; }
    isDeferred.add(join.id);
    deferred.push({ join });
    placed.set(join.id, { x: round(preferred), level: minLevel, channel });
  }

  // 3. Lanes. A route crosses each intermediate row through a gap between
  // tiles or an outer margin. Gaps are identified by their geometry, so rows
  // with the same gap share one lane assignment and a route continuing
  // through both never meets another route's lane. Routes from one source
  // share a lane, so a fan-out reads as one trunk that branches; different
  // sources get distinct lanes spread evenly across the gap. A full gap sends
  // further sources elsewhere.
  interface Slot { readonly id: string; readonly x: number; readonly low: number; readonly high: number; readonly margin: boolean }
  const slotCache = new Map<number, Slot[]>();
  const gapsOf = (row: number) => {
    const cached = slotCache.get(row);
    if (cached) return cached;
    const boxes = spans(row);
    const clear = space.clearance;
    const options: Slot[] = [];
    const first = boxes[0];
    const last = boxes.at(-1)!;
    // Each outer margin is one slot for the whole graph: a source keeps one
    // x in it, placed once every source is known (below).
    if (first.x - clear >= clear) options.push({ id: "L", x: first.x - space.column / 2, low: clear, high: first.x - clear, margin: true });
    for (let index = 1; index < boxes.length; index++) {
      const low = boxes[index - 1].x + boxes[index - 1].width + clear;
      const high = boxes[index].x - clear;
      if (high >= low) options.push({ id: `G:${round(low)}:${round(high)}`, x: (low + high) / 2, low, high, margin: false });
    }
    if (width - clear >= last.x + last.width + clear) options.push({ id: "R", x: last.x + last.width + space.column / 2, low: last.x + last.width + clear, high: width - clear, margin: true });
    slotCache.set(row, options);
    return options;
  };
  interface Lane { readonly slot: Slot; readonly sources: Map<string, number>; readonly xs: Map<string, number> }
  const lanes = new Map<string, Lane>();
  /** A source's x in a lane, once lanes are placed. */
  const laneX = (slot: string, source: string) => lanes.get(slot)!.xs.get(source);
  // Margins take any number of lanes; they widen on the next pass if needed.
  const capacity = (slot: Slot) => slot.margin ? Infinity : Math.floor((slot.high - slot.low) / MIN_LANE) + 1;
  // Room the outer margins lack: for their lanes, and for junctions that
  // found no column of their own. The next pass widens them by this much.
  const shortfall = { left: 0, right: 0 };
  const slotsInRow = new Map<number, Set<string>>();
  /** The rows each source passes through in each outer margin, by margin. */
  const marginRows = new Map<string, Map<string, number[]>>();
  const claim = (row: number, desired: number, source: string, sourceX: number): string | null => {
    const slots = gapsOf(row);
    if (!slots.length) return null;
    // Slots are tried by cost, then x, then row order (a stable sort); the
    // first with room takes the source, else the least loaded. With finite
    // keys that order is total, so the first is a minimum and needs no sort.
    // Outer margins cost a little extra: a gap between tiles keeps the route nearer the graph.
    const cost = (slot: Slot) => Math.abs(slot.x - desired) + (slot.margin ? 8 : 0);
    const load = (slot: Slot) => (lanes.get(slot.id)?.sources.size ?? 0) / capacity(slot);
    const hasRoom = (slot: Slot) => {
      const lane = lanes.get(slot.id);
      return !lane || lane.sources.has(source) || lane.sources.size < capacity(slot);
    };
    let open: Slot | undefined, finite = true, openCost = 0;
    for (const slot of slots) {
      const value = cost(slot);
      if (!Number.isFinite(value) || !Number.isFinite(slot.x)) { finite = false; break; }
      if (open && (value > openCost || (value === openCost && !(slot.x < open.x)))) continue;
      const lane = lanes.get(slot.id);
      if (!lane || lane.sources.has(source) || lane.sources.size < capacity(slot)) { open = slot; openCost = value; }
    }
    if (!finite) {
      const costs = slots.map(cost);
      const options = slots.map((_, index) => index).sort((a, b) => costs[a] - costs[b] || slots[a].x - slots[b].x).map((index) => slots[index]);
      open = options.find(hasRoom) ?? options.reduce((best, slot) => load(slot) < load(best) ? slot : best);
    } else if (!open) {
      let bestLoad = 0, bestCost = 0;
      for (const slot of slots) {
        const value = cost(slot), used = load(slot);
        if (!open || used < bestLoad || (used === bestLoad && (value < bestCost || (value === bestCost && slot.x < open.x)))) { open = slot; bestLoad = used; bestCost = value; }
      }
    }
    open = open!;
    let lane = lanes.get(open.id);
    if (!lane) lanes.set(open.id, lane = { slot: open, sources: new Map<string, number>(), xs: new Map<string, number>() });
    if (!lane.sources.has(source)) lane.sources.set(source, sourceX);
    // Only deferred junctions read which lanes each row uses.
    if (deferred.length) {
      let used = slotsInRow.get(row);
      if (!used) slotsInRow.set(row, used = new Set());
      used.add(open.id);
    }
    if (open.margin) {
      let bySource = marginRows.get(open.id);
      if (!bySource) marginRows.set(open.id, bySource = new Map());
      const rowsUsed = bySource.get(source);
      if (rowsUsed) rowsUsed.push(row); else bySource.set(source, [row]);
    }
    return open.id;
  };

  // Courses. Routes from one source that cross a row through the same lane
  // share everything above it, so passes form a trie per source: each node is
  // one row crossing, computed (and later drawn) once however many routes
  // run through it. Work then grows with each source's trunk, not with
  // routes × rows.
  /** `tile`: a tile root's key as its source names it (`source` without "node:"). */
  interface PassNode { readonly parent: number; readonly source: string; readonly row: number; x: number; readonly from: Anchor; readonly own: ReadonlySet<string>; readonly tile?: string }
  const trie: PassNode[] = [];
  // Each node's children by lane id, or by end x (a number) where the row has
  // no lane; a child is always one row down. Most nodes have one child, kept
  // inline; further ones go in a map (keys compare as map keys do).
  const firstKey: (string | number)[] = [], firstChild: number[] = [];
  const moreChildren = new Map<number, Map<string | number, number>>();
  const sameKey = (a: string | number, b: string | number) => a === b || (a !== a && b !== b);
  const childOf = (node: number, key: string | number): number | undefined =>
    firstChild[node] === undefined ? undefined : sameKey(firstKey[node], key) ? firstChild[node] : moreChildren.get(node)?.get(key);
  const addChild = (node: number, key: string | number, child: number) => {
    if (firstChild[node] === undefined) { firstKey[node] = key; firstChild[node] = child; return; }
    let more = moreChildren.get(node);
    if (!more) moreChildren.set(node, more = new Map());
    more.set(key, child);
  };
  const sourceRoot = new Map<string, number>();
  /** Lane claims by source, then rounded end x, then row. */
  const claimed = new Map<string, Map<number, Map<number, string | null>>>();
  const pending: { node: number; slot: string | null; desired: number }[] = [];
  /** The trie root for a route's start; `source` is its endpoint key. */
  const rootOf = (endpoint: Endpoint, source: string): number => {
    const known = sourceRoot.get(source);
    if (known !== undefined) return known;
    const node: PassNode = endpoint.kind === "node"
      ? { parent: -1, source, row: columns.get(endpoint.id)!.row, x: center(endpoint.id), from: { row: columns.get(endpoint.id)!.row, edge: "bottom" }, own: NO_JUNCTIONS, tile: `${endpoint.id}` }
      : { parent: -1, source, row: placed.get(endpoint.id)!.channel, x: placed.get(endpoint.id)!.x, from: { junction: endpoint.id }, own: new Set([endpoint.id]) };
    trie.push(node);
    sourceRoot.set(source, trie.length - 1);
    return trie.length - 1;
  };
  const courses = plan.routes.map((route) => {
    const source = endpointKey(route.from);
    let node = rootOf(route.from, source);
    const sourceX = trie[node].x;
    let endX: number; let endChannel: number; let to: Anchor;
    if (route.to.kind === "node") {
      const row = columns.get(route.to.id)!.row;
      endX = center(route.to.id); endChannel = row - 1; to = { row, edge: "arrow" };
    } else {
      const join = placed.get(route.to.id)!;
      endX = join.x; endChannel = join.channel; to = { junction: route.to.id };
    }
    if (trie[node].row + 1 <= endChannel) {
      const endKey = round(endX);
      let byEnd = claimed.get(source);
      if (!byEnd) claimed.set(source, byEnd = new Map());
      let byRow = byEnd.get(endKey);
      if (!byRow) byEnd.set(endKey, byRow = new Map());
      for (let row = trie[node].row + 1; row <= endChannel; row++) {
        let slot = byRow.get(row);
        if (slot === undefined) byRow.set(row, slot = claim(row, endX, source, sourceX));
        const key = slot ?? endKey;
        let child = childOf(node, key);
        if (child === undefined) {
          child = trie.length;
          trie.push({ parent: node, source, row, x: 0, from: { row, edge: "bottom" }, own: trie[node].own });
          addChild(node, key, child);
          pending.push({ node: child, slot, desired: endX });
        }
        node = child;
      }
    }
    const own = route.to.kind === "junction" ? new Set([...trie[node].own, route.to.id]) : trie[node].own;
    return { route, source, last: node, end: { x: endX, to }, own };
  });

  // Margin lanes. Each source keeps one x in a margin, just outside the rows
  // it passes there, and clear of every other source whose rows (with the
  // channel either side) overlap its own, so two sources never meet in a
  // margin. Inner sources are placed first and nearest the tiles, which
  // avoids most crossings. Lanes take the roomier spacing where it all fits
  // the canvas; otherwise the minimum, overflowing it by exactly what the
  // next pass widens the margin by (placement is relative to the tiles, so
  // that pass fits).
  for (const side of ["L", "R"] as const) {
    const lane = lanes.get(side);
    if (!lane) continue;
    const left = side === "L";
    const entries = [...lane.sources].map(([source, sourceX]) => {
      const used = marginRows.get(side)!.get(source)!;
      // Math.min and Math.max do not depend on argument order, so folds match the spreads.
      let edge = left ? Infinity : -Infinity, lo = Infinity, hi = -Infinity;
      for (const row of used) {
        lo = Math.min(lo, row); hi = Math.max(hi, row);
        const boxes = spans(row);
        if (!boxes.length) continue;
        const last = boxes[boxes.length - 1];
        edge = left ? Math.min(edge, boxes[0].x - space.clearance) : Math.max(edge, last.x + last.width + space.clearance);
      }
      return { source, sourceX, lo: lo - 1, hi: hi + 1, edge, anchor: left ? edge - space.column / 2 + space.clearance : edge + space.column / 2 - space.clearance };
    }).sort((a, b) => (left ? b.sourceX - a.sourceX : a.sourceX - b.sourceX) || a.source.localeCompare(b.source));
    const bound = left ? space.clearance : width - space.clearance;
    /** Every entry's x at one separation; the outer side is unbounded, so each always finds one. */
    const place = (separation: number) => {
      const xs: number[] = [];
      // Placed lanes kept sorted by x, so the intervals around an entry come
      // out sorted by start and merge in one sweep (as `nearestFree` would).
      const byX: { x: number; lo: number; hi: number }[] = [];
      let overflow = 0;
      for (const entry of entries) {
        const around: [number, number][] = [];
        for (const other of byX) {
          if (!(other.lo <= entry.hi && entry.lo <= other.hi)) continue;
          const start = other.x - separation + FREE_STEP, end = other.x + separation - FREE_STEP;
          const last = around.at(-1);
          if (last && start <= last[1] + FREE_STEP) last[1] = Math.max(last[1], end);
          else around.push([start, end]);
        }
        const x = nearestOutside(entry.anchor, around, left ? -Infinity : entry.edge, left ? entry.edge : Infinity)!;
        let at = byX.length;
        while (at > 0 && byX[at - 1].x > x) at--;
        byX.splice(at, 0, { x, lo: entry.lo, hi: entry.hi });
        xs.push(x);
        overflow = Math.max(overflow, left ? bound - x : x - bound);
      }
      return { xs, overflow };
    };
    const roomy = place(space.lane);
    const chosen = roomy.overflow <= 0 ? roomy : place(MIN_LANE);
    shortfall[left ? "left" : "right"] = Math.max(shortfall[left ? "left" : "right"], chosen.overflow);
    entries.forEach((entry, index) => lane.xs.set(entry.source, chosen.xs[index]));
  }

  // Lane positions, once every source in a gap is known: ordered by where the
  // sources sit (fewer crossings), centered on the gap and kept inside it.
  for (const { slot, sources, xs } of lanes.values()) {
    if (slot.margin) continue;
    const order = [...sources].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const spacing = order.length > 1 ? Math.min(space.lane, (slot.high - slot.low) / (order.length - 1)) : 0;
    const span = spacing * (order.length - 1);
    const first = Math.min(slot.high - span, Math.max(slot.low, slot.x - span / 2));
    order.forEach(([source], index) => xs.set(source, first + index * spacing));
  }
  for (const { node, slot, desired } of pending) trie[node].x = slot ? laneX(slot, trie[node].source)! : desired;

  // 3b. Deferred junctions, now kept off the columns routes actually
  // use (lanes, tile exits and arrow entries) rather than whole gaps and
  // margins. If even that is full, a dot may sit above another; at worst only
  // same-level spacing holds.
  if (deferred.length) {
    const laneColumns = (row: number) => [...slotsInRow.get(row) ?? []].flatMap((slot) => [...lanes.get(slot)!.sources.keys()].map((source) => laneX(slot, source)!));
    const columnsNear = new Map<number, { x: number; key: NodeKey | null }[]>();
    const columnsOf = (channel: number) => {
      let cached = columnsNear.get(channel);
      if (!cached) {
        const exits = spans(channel).filter((box) => targetsOf.has(endpointKey({ kind: "node", id: box.key })));
        const entries = spans(channel + 1).filter((box) => parentsOf(box.key).length > 0);
        columnsNear.set(channel, cached = [
          ...[...exits, ...entries].map((box) => ({ x: box.x + box.width / 2, key: box.key })),
          ...[...laneColumns(channel), ...laneColumns(channel + 1)].map((x) => ({ x, key: null })),
        ].sort((a, b) => a.x - b.x));
      }
      return cached;
    };
    const moved = new Map<string, number>();
    // Widening for junctions stops at two more view widths; beyond that a
    // crowded channel stacks dots (see the layout notes' known limits).
    let wideningLeft = 2 * (Number.isFinite(budget) ? budget : width) - extra.left - extra.right;
    for (const { join } of deferred) {
      const situation = situate(join);
      const { channel, own, minLevel } = situation;
      const keepouts = columnsOf(channel).filter((column) => !column.key || !own.has(column.key)).map((column) => [column.x - berth, column.x + berth] as const);
      const deepest = Math.max(minLevel, channelDepth.get(channel) ?? 0);
      const ownColumn = search(situation, keepouts, true, deepest + 1);
      const choice = ownColumn ?? search(situation, keepouts, false, deepest + 1) ?? search(situation, [], false, deepest + 1)!;
      // A dot above another can leave no clean way for their routes; ask for
      // a column of its own in the margin nearer its preferred spot.
      if (!ownColumn && wideningLeft > 0) {
        shortfall[situation.preferred < width / 2 ? "left" : "right"] += berth + FREE_STEP;
        wideningLeft -= berth + FREE_STEP;
      }
      settle(join, situation, choice);
      moved.set(join.id, placed.get(join.id)!.x);
    }
    // Routes from and to moved junctions start and end at their final spots.
    for (const [id, x] of moved) {
      const root = sourceRoot.get(endpointKey({ kind: "junction", id }));
      if (root !== undefined) trie[root].x = x;
    }
    for (const course of courses) if (course.end.to && "junction" in course.end.to && moved.has(course.end.to.junction)) course.end.x = moved.get(course.end.to.junction)!;
  }

  if (!last && !(shortfall.left <= 0 && shortfall.right <= 0)) return { layout: null, shortfall };

  // Channels in level space. The channel below row c holds levelCount(c)
  // junction levels; bend zone i lies between level i and level i + 1
  // (level 0 is the row above, the last zone ends at the row below). Bends
  // happen only inside zones, so a route never bends across a junction level.
  const levelCount = (channel: number) => lastRowOfBand.get(rowKeys[channel].band) === channel ? bandLevels.get(rowKeys[channel].band) ?? 0 : 0;
  type Anchor = { readonly row: number; readonly edge: "top" | "bottom" | "arrow" } | { readonly junction: string };
  interface Leg {
    readonly channel: number; readonly source: string; readonly target: string | null;
    readonly x1: number; readonly x2: number; readonly from: Anchor; readonly to: Anchor;
    readonly own: ReadonlySet<string>; readonly lo: number; readonly hi: number;
    zone: number; track: number;
  }
  const leg = (channel: number, source: string, target: string | null, x1: number, x2: number, from: Anchor, to: Anchor, own: ReadonlySet<string>): Leg => {
    const lo = "junction" in from ? placed.get(from.junction)!.level : 0;
    const hi = Math.max(lo, "junction" in to ? placed.get(to.junction)!.level - 1 : levelCount(channel));
    return { channel, source, target, x1, x2, from, to, own, lo, hi, zone: lo, track: 0 };
  };
  // The leg into each trie node (none for roots), then each route's final leg.
  const nodeLegs = trie.map((item) => {
    if (item.parent < 0) return null;
    const parent = trie[item.parent];
    return leg(parent.row, item.source, null, parent.x, item.x, parent.from, { row: item.row, edge: "top" }, item.own);
  });
  const finalLegs = courses.map(({ route, source, last, end, own }) => {
    const from = trie[last];
    return leg(from.row, source, endpointKey(route.to), from.x, end.x, from.from, end.to, own);
  });
  const allLegs: Leg[] = [];
  for (const item of nodeLegs) if (item !== null) allLegs.push(item);
  for (const item of finalLegs) allLegs.push(item);
  const bends = (item: Leg) => Math.abs(item.x1 - item.x2) >= 0.5;
  const near = (a: number, b: number) => Math.abs(a - b) < MIN_LANE;
  // Routes from one source (a branching trunk) or into one junction may meet.
  const compatible = (a: Leg, b: Leg) => a.source === b.source || (a.target !== null && a.target === b.target && a.target.startsWith("junction:"));

  // 4. Zones. Each bend takes the zone whose vertical runs stay clear of
  // junctions it does not belong to (touching one would read as one more
  // input combined there) and of other routes' vertical runs; among equally
  // clear zones, the roomiest.
  // Default zone heights (`bendZones`); the orientation estimate sizes channels from the same.
  const zoneDefaults = new Map<number, readonly number[]>();
  const defaultZone = (channel: number, zone: number) => {
    let heights = zoneDefaults.get(channel);
    if (!heights) zoneDefaults.set(channel, heights = bendZones(space, levelCount(channel), lastRowOfBand.get(rowKeys[channel].band) === channel));
    return heights[zone];
  };
  // Channels choose zones independently, and only for a bend with more than one
  // zone (none without junction levels, as in any tree): with none, skip the step.
  let choosing = false;
  for (const item of allLegs) if (item.lo !== item.hi && bends(item)) { choosing = true; break; }
  const legsIn = new Map<number, Leg[]>();
  if (choosing) for (const item of allLegs) append(legsIn, item.channel, item);
  type Run = { readonly x: number; readonly from: number; readonly to: number; readonly bend: number | null; readonly leg: Leg };
  const bucket = (x: number) => Math.floor(x / MIN_LANE);
  const junctionsByChannel = new Map<number, { id: string; x: number; level: number }[]>();
  if (choosing) for (const [id, join] of placed) append(junctionsByChannel, join.channel, { id, x: join.x, level: join.level });
  for (const [channel, legs] of legsIn) {
    // A bend with a single zone (most channels have no junction levels) has
    // no choice to make: it keeps that zone, its initial one. Runs are only
    // read to choose, so a channel with no choice to make needs none.
    const bending = legs.filter(bends);
    if (bending.every((item) => item.lo === item.hi)) continue;
    // Foreign junctions by x, to find those on a bend's columns.
    const junctionAt = new Map<number, { id: string; x: number; level: number }[]>();
    for (const join of junctionsByChannel.get(channel) ?? []) append(junctionAt, Math.floor(join.x / JUNCTION_BERTH), join);
    const levelsNear = (item: Leg, x: number) => {
      const found: number[] = [];
      const home = Math.floor(x / JUNCTION_BERTH);
      for (let key = home - 1; key <= home + 1; key++) {
        const list = junctionAt.get(key);
        if (list) for (const join of list) if (!item.own.has(join.id) && Math.abs(join.x - x) < JUNCTION_BERTH) found.push(join.level);
      }
      return found;
    };
    // Vertical runs by x bucket; a bend's runs are replaced when it moves zone.
    // Only counts are read from these, so the order within a bucket is free.
    const runsAt = new Map<number, Run[]>();
    const runsOf = new Map<Leg, Run[]>();
    const register = (item: Leg, list: Run[]) => {
      runsOf.set(item, list);
      for (const run of list) {
        const key = bucket(run.x), at = runsAt.get(key);
        if (at) at.push(run); else runsAt.set(key, [run]);
      }
    };
    const unregister = (item: Leg) => {
      for (const run of runsOf.get(item) ?? []) {
        const at = runsAt.get(bucket(run.x));
        const index = at ? at.indexOf(run) : -1;
        if (index >= 0) { at![index] = at![at!.length - 1]; at!.pop(); }
      }
      runsOf.delete(item);
    };
    /** Other routes' runs that a run at `x` from level `from` to `to`, bending at `bend`, would touch. */
    const clashes = (item: Leg, x: number, from: number, to: number, bend: number | null) => {
      let count = 0;
      const home = bucket(x), source = item.source;
      for (let key = home - 1; key <= home + 1; key++) {
        const list = runsAt.get(key);
        if (list) for (const other of list) {
          if (other.leg.source === source || !near(other.x, x) || compatible(other.leg, item)) continue;
          const top = Math.max(other.from, from), bottom = Math.min(other.to, to);
          if (top > bottom || (other.bend !== null && other.bend === bend && top === bottom)) continue;
          count++;
        }
      }
      return count;
    };
    const runsFor = (item: Leg, zone: number): Run[] => [{ x: item.x1, from: item.lo, to: zone, bend: zone, leg: item }, { x: item.x2, from: zone, to: item.hi, bend: zone, leg: item }];
    for (const item of legs) if (!bends(item)) register(item, [{ x: item.x1, from: item.lo, to: item.hi, bend: null, leg: item }]);
    // Zones are tried cheapest first (fewest junction contacts, then roomiest)
    // and the first without crossings is taken, so tall channels stay cheap.
    const choose = (item: Leg) => {
      const above = levelsNear(item, item.x1), beneath = levelsNear(item, item.x2);
      const options: { zone: number; touches: number; room: number }[] = [];
      for (let zone = item.lo; zone <= item.hi; zone++) {
        let touches = 0;
        for (const level of above) if (level > item.lo && level <= zone) touches++;
        for (const level of beneath) if (level > zone && level <= item.hi) touches++;
        options.push({ zone, touches, room: defaultZone(channel, zone) });
      }
      options.sort((a, b) => a.touches - b.touches || b.room - a.room || a.zone - b.zone);
      let best: { zone: number; cost: number } | null = null;
      for (const option of options) {
        if (best && option.touches * 1000 > best.cost) break;
        const zone = option.zone;
        const crowding = clashes(item, item.x1, item.lo, zone, zone) + clashes(item, item.x2, zone, item.hi, zone);
        const cost = option.touches * 1000 + crowding * 10 - option.room / 100;
        if (!best || cost < best.cost) best = { zone, cost };
        if (!crowding) break;
      }
      item.zone = best!.zone;
      register(item, runsFor(item, item.zone));
    };
    // Single-zone bends still register their runs, which others' choices see.
    for (const item of bending) if (item.lo === item.hi) register(item, runsFor(item, item.lo)); else choose(item);
    // A second pass lets earlier bends react to later ones.
    for (const item of bending) if (item.lo !== item.hi) { unregister(item); choose(item); }
  }

  // 5. Tracks. Bends in one zone whose spans overlap bend in separate
  // horizontal slices of it (left-edge channel routing), so two routes never
  // run side by side at a shallow angle: wherever they cross, one of them runs
  // vertically. Within a direction the bend reaching furthest turns first, so
  // parallel routes never cross; and a route leaving a column bends before
  // another route arriving in it, so their vertical runs never overlap.
  // Track counts and zone boxes by channel, then zone.
  const trackCount: number[][] = [];
  // Bends by channel, then zone (both small non-negative integers), in leg order.
  // Groups are independent (each sets only its own bends' tracks and count), so
  // the order they are visited in is free.
  const zoneGroups: Leg[][][] = [];
  for (const item of allLegs) if (bends(item)) ((zoneGroups[item.channel] ??= [])[item.zone] ??= []).push(item);
  for (let channel = 0; channel < zoneGroups.length; channel++) {
    const byZone = zoneGroups[channel];
    if (byZone) for (let zone = 0; zone < byZone.length; zone++) if (byZone[zone]) assignTracks(channel, zone, byZone[zone]);
  }
  function assignTracks(channel: number, zone: number, legs: readonly Leg[]) {
    // Bends from one source never conflict: all keep track 0.
    let mixed = false;
    for (const item of legs) if (item.source !== legs[0].source) { mixed = true; break; }
    if (!mixed) return;
    // Every bend runs left or right (it moves at least half a pixel).
    const ordered = legs.filter((item) => item.x2 < item.x1).sort(leftwardFirst);
    for (const item of legs.filter((item) => item.x2 > item.x1).sort(rightwardFirst)) ordered.push(item);
    const count = ordered.length;
    const reachLow: number[] = [], reachHigh: number[] = [];
    for (const item of ordered) { reachLow.push(Math.min(item.x1, item.x2) - MIN_LANE); reachHigh.push(Math.max(item.x1, item.x2) + MIN_LANE); }
    const conflict = (i: number, j: number) => reachLow[i] < reachHigh[j] && reachLow[j] < reachHigh[i] && !compatible(ordered[i], ordered[j]);
    // Two bends trading columns (a swap) form one unit: swapping bends move as
    // one unit; forced order: a bend leaving a column turns before one arriving in it.
    const unit: number[] = [];
    for (let i = 0; i < count; i++) unit.push(i);
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const a = ordered[i], b = ordered[j];
      if (near(a.x1, b.x2) && near(b.x1, a.x2) && !compatible(a, b)) unit[unitRoot(unit, j)] = unitRoot(unit, i);
    }
    // Units are named by their root bend and listed by first member.
    const unitOf: number[] = [], units: number[] = [], members: number[][] = [];
    for (let i = 0; i < count; i++) {
      const id = unitRoot(unit, i);
      unitOf.push(id);
      if (members[id]) members[id].push(i); else { members[id] = [i]; units.push(id); }
    }
    const forced: (Set<number> | undefined)[] = [];
    const pending = new Array<number>(count).fill(0);
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      if (!near(ordered[i].x1, ordered[j].x2) || near(ordered[j].x1, ordered[i].x2) || unitOf[i] === unitOf[j] || !conflict(i, j)) continue;
      const later = (forced[unitOf[i]] ??= new Set());
      if (later.has(unitOf[j])) continue;
      later.add(unitOf[j]);
      pending[unitOf[j]]++;
    }
    // Turn order: the forced constraints, otherwise the sort order above (a
    // cycle of forced constraints is broken in sort order).
    const sequenced: boolean[] = [];
    // Bends already given a track, in turn order.
    const done: number[] = [];
    for (let step = 0; step < units.length; step++) {
      let next = -1;
      for (const id of units) if (!sequenced[id] && pending[id] === 0) { next = id; break; }
      if (next < 0) for (const id of units) if (!sequenced[id]) { next = id; break; }
      sequenced[next] = true;
      const later = forced[next];
      if (later) for (const id of later) pending[id]--;
      const group = members[next];
      let track = 0;
      for (const earlier of done) {
        if (!(ordered[earlier].track + 1 > track)) continue;
        for (const index of group) if (conflict(earlier, index)) { track = ordered[earlier].track + 1; break; }
      }
      // Swapping bends take consecutive slices: each leaves its column just
      // as the other arrives, so they neither overlap nor cross at a shallow angle.
      for (let offset = 0; offset < group.length; offset++) { ordered[group[offset]].track = track + offset; done.push(group[offset]); }
    }
    let most = 1;
    for (const item of ordered) most = Math.max(most, item.track + 1);
    (trackCount[channel] ??= [])[zone] = most;
  }
  const tracksIn = (channel: number, zone: number) => trackCount[channel]?.[zone] ?? 1;

  // 6. Vertical placement. Each zone is as tall as its tracks need (crowded
  // channels grow instead of squeezing bends), and junction levels sit
  // between zones.
  const nodes = new Map<NodeKey, PlacedNode>();
  const rows: RowBox[] = [];
  /** Zone boxes by channel, then zone. */
  const zoneBoxes: { top: number; bottom: number }[][] = [];
  let y: number = space.top;
  rowKeys.forEach(({ band, keys: keysInRow }, index) => {
    for (const key of keysInRow) {
      const item = items.get(key)!;
      nodes.set(key, { key, x: columns.get(key)!.x, y, width: item.width, height: item.height, band, row: index });
    }
    const bottom = y + keysInRow.reduce((most, key) => Math.max(most, items.get(key)!.height), 0);
    rows.push({ index, band, top: y, bottom, keys: keysInRow });
    y = bottom;
    const count = levelCount(index);
    const boxes: { top: number; bottom: number }[] = zoneBoxes[index] = [];
    for (let zone = 0; zone <= count; zone++) {
      const tall = Math.max(defaultZone(index, zone), tracksIn(index, zone) * TRACK_HEIGHT);
      boxes[zone] = { top: y, bottom: y + tall };
      y += tall + (zone < count ? 2 * JUNCTION_BERTH : 0);
    }
    // No bend below the last zone: routes into the next row run straight.
    y += space.approach;
  });
  const height = rows.length ? rows.at(-1)!.bottom + space.bottom : 0;
  const junctions = new Map<string, PlacedJunction>();
  for (const join of plan.joins) {
    const { x, level, channel } = placed.get(join.id)!;
    junctions.set(join.id, { id: join.id, parents: join.parents, x, y: round(zoneBoxes[channel][level - 1].bottom + JUNCTION_BERTH) });
  }
  const at = (anchor: Anchor): number => {
    if ("junction" in anchor) return junctions.get(anchor.junction)!.y;
    const row = rows[anchor.row];
    // A route into a tile ends at its arrowhead's base; the tip lies on the tile's edge.
    return anchor.edge === "bottom" ? row.bottom : anchor.edge === "top" ? row.top : row.top - ARROW.length;
  };

  // 7. Paths: vertical to the bend's slice, an S-curve within it, vertical on.
  // Bend zones end `approach` above the next row, so a route into a tile ends
  // in a straight, vertical stem at least as long as its arrowhead.
  const draw = (item: Leg): string => {
    const y1 = at(item.from), y2 = at(item.to);
    const { x1, x2 } = item;
    // Each coordinate is formatted once, however often the path repeats it.
    const right = `${round(x2)}`;
    if (!bends(item)) {
      // Too slight an offset to bend; the stem into an arrowhead is still exactly vertical.
      const stem = "edge" in item.to && item.to.edge === "arrow" && round(x1) !== round(x2) ? ` L${right} ${round(y2 - ARROW.length)}` : "";
      return `${stem} L${right} ${round(y2)}`;
    }
    const box = zoneBoxes[item.channel][item.zone];
    const top = Math.max(box.top, y1), bottom = Math.min(box.bottom, y2);
    const slice = (bottom - top) / tracksIn(item.channel, item.zone);
    const start = top + slice * item.track, end = start + slice;
    const left = `${round(x1)}`, middle = `${round((start + end) / 2)}`;
    return `${start > y1 ? ` L${left} ${round(start)}` : ""} C${left} ${middle},${right} ${middle},${right} ${round(end)}${end < y2 ? ` L${right} ${round(y2)}` : ""}`;
  };
  // Shared stretches are drawn once, as trunks carrying the consumers of
  // every route through them; each route draws only from where it branches
  // off. A trunk ends where routes leave it, so its highlight is exact.
  const usage = trie.map(() => 0);
  for (const { last } of courses) usage[last] += 1;
  for (let node = trie.length - 1; node >= 0; node--) if (trie[node].parent >= 0) usage[trie[node].parent] += usage[node];
  // A node's continuation is the child every route through it continues to.
  const continuation: (number | undefined)[] = [];
  trie.forEach((item, node) => { if (item.parent >= 0 && usage[node] === usage[item.parent]) continuation[item.parent] = node; });
  const startOf = (node: number): string => {
    const item = trie[node];
    if (item.parent >= 0) { const into = nodeLegs[node]!; return `M${round(into.x1)} ${round(at(into.from))}`; }
    if ("junction" in item.from) return `M${round(item.x)} ${round(at(item.from))}`;
    const tile = nodes.get(item.tile!)!;
    const bottom = rows[tile.row].bottom, x = round(item.x);
    return `M${x} ${round(tile.y + tile.height)}${tile.y + tile.height < bottom ? ` L${x} ${round(bottom)}` : ""}`;
  };
  // The crossing into a node's row and the run through it.
  const piece = (node: number): string => {
    const into = nodeLegs[node];
    return into ? `${draw(into)} L${round(into.x2)} ${round(rows[trie[node].row].bottom)}` : "";
  };
  const shared = (node: number) => usage[node] >= 2;
  const chainStart = (node: number) => shared(node) && (trie[node].parent < 0 || usage[trie[node].parent] !== usage[node]);
  // Usage never grows down the trie, so the shared nodes of a route's trail
  // (root to end) are a prefix of it: the route draws from the first unshared.
  // Each trunk's consumers are listed by route, whatever the walk's direction.
  const trunkConsumers = new Map<number, Consumer[]>();
  for (const { route, last } of courses) {
    for (let node = last; node >= 0; node = trie[node].parent) if (chainStart(node)) {
      const list = trunkConsumers.get(node);
      if (list) for (const entry of route.consumers) list.push(entry); else trunkConsumers.set(node, [...route.consumers]);
    }
  }
  const routes: PlacedRoute[] = [];
  // Ids key the rendered connectors, so they must be unique; a hash collision
  // in trunk names (vanishingly rare) is resolved here deterministically.
  const ids = new Set<string>();
  const unique = (id: string) => { let result = id; for (let n = 2; ids.has(result); n++) result = `${id}#${n}`; ids.add(result); return result; };
  /** Each source's endpoint, as the last route from it gives it; only trunks need it. */
  let endpointOf: Map<string, Endpoint> | undefined;
  trie.forEach((item, node) => {
    if (!chainStart(node)) return;
    let path = startOf(node);
    // Follow the single continuation that keeps every route of this trunk.
    for (let current: number | undefined = node; current !== undefined; current = continuation[current]) path += piece(current);
    if (path.includes("L") || path.includes("C")) {
      const distinct = new Map<string, Consumer>();
      for (const entry of trunkConsumers.get(node)!) distinct.set(`${entry.parent}>${entry.child}`, entry);
      const consumers = [...distinct.values()];
      if (!endpointOf) { endpointOf = new Map(); for (const { route, source } of courses) endpointOf.set(source, route.from); }
      const from = endpointOf.get(item.source)!;
      // Named by what it carries, not where it runs, so a trunk keeps its id
      // (and morphs) across relayouts that move it.
      const carried = hashOf([...distinct.keys()].sort().join("|"));
      routes.push({ id: unique(`${item.source}~${carried}`), from, to: from, consumers, path, terminal: false });
    }
  });
  const unsharedTrail: number[] = [];
  courses.forEach(({ route, source, last }, index) => {
    const final = finalLegs[index];
    let path: string;
    if (shared(last)) path = `M${round(final.x1)} ${round(at(final.from))}`;
    else {
      // The unshared end of the trail, gathered upwards, drawn downwards.
      unsharedTrail.length = 0;
      for (let node = last; node >= 0 && !shared(node); node = trie[node].parent) unsharedTrail.push(node);
      path = startOf(unsharedTrail[unsharedTrail.length - 1]);
      for (let at = unsharedTrail.length - 1; at >= 0; at--) path += piece(unsharedTrail[at]);
    }
    path += draw(final);
    // The final leg's target is the route's end, as an endpoint key.
    const id = `${source}>${final.target}`;
    routes.push({ id: plainKeys ? id : unique(id), from: route.from, to: route.to, consumers: route.consumers, path, terminal: route.to.kind === "node" });
  });

  return {
    shortfall,
    layout: {
      orientation: "down", width, height, nodes, rows, routes, readingOrder: reading,
      ...(pinnedViolation ? { pinnedViolation } : {}),
      junctions,
    },
  };
}

export type Direction = "left" | "right" | "up" | "down";

/** Spatial arrow-key navigation between tiles. */
export function nearestInDirection(layout: GraphLayout, key: NodeKey, direction: Direction): NodeKey | null {
  const from = layout.nodes.get(key);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const candidates = [...layout.nodes.values()].filter((node) => node.key !== key && (
    direction === "left" ? node.x < from.x : direction === "right" ? node.x > from.x : direction === "up" ? node.y < from.y : node.y > from.y));
  // Cross-axis distance weighs more, so arrows prefer tiles in the same row or column.
  const score = (node: PlacedNode) => horizontal
    ? Math.abs(node.x - from.x) + Math.abs(node.y - from.y) * 3
    : Math.abs(node.y - from.y) + Math.abs(node.x - from.x) * 3;
  return candidates.reduce<PlacedNode | null>((best, node) => !best || score(node) < score(best) ? node : best, null)?.key ?? null;
}
