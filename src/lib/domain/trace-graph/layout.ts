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
import { layoutBand, type BandOptions } from "./band-layout";
import type { NodeKey } from "./model";
import { buildInputJunctions, endpointKey, type Consumer, type Endpoint, type Junction } from "./junctions";
import { ARROW, bendZones, JUNCTION_BERTH, LANE_SEPARATION, PORT_BERTH, spacingFor, TRACK_HEIGHT } from "./metrics";
import { orderLayers } from "./layer-order";
import { packRuns, passageRuns, planPassage, runCrossings, type ChannelRun, type ChannelRuns, type Passage, type RunPrice } from "./passing-plan";

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
  /**
   * `gate-infeasible`: no candidate passed the hard gates (e.g. a cover that is not a root); the downward layout is shown as is.
   * `lane-infeasible`: every candidate ran connectors from different sources along a shared lane; the best of them, priced, is shown.
   * `anchor-yield`: an anchor-preserving layout existed, but crossed far more than the best unanchored one (the crossing cap), or,
   * as the component grew, was far taller (the height cap) or moved the other tiles more than an unanchored one moves any (the stability cap); the anchors moved.
   */
  readonly fallback?: "anchor-infeasible" | "anchor-yield" | "packing-infeasible" | "gate-infeasible" | "lane-infeasible";
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
  /** The latest growth of a tile in place (`band-history`), so shrinking it back can undo it exactly. */
  readonly resized?: ResizeRecord;
}

/**
 * A tile's growth in place, as recorded on the layout it gave (`resizedLayout`): what it changed,
 * as it was before. Shrinking the tile back restores it, when growing it again confirms that
 * nothing else changed since.
 */
export interface ResizeRecord {
  readonly key: NodeKey;
  /** The tile's height before it grew, and after. */
  readonly from: number;
  readonly to: number;
  readonly nodes: readonly PlacedNode[];
  readonly junctions: readonly (readonly [string, PlacedJunction])[];
  /** Routes by index, with their paths. */
  readonly routes: readonly (readonly [number, string])[];
  /** All rows, when any changed. */
  readonly rows?: readonly RowBox[];
  readonly height: number;
  readonly bandBounds?: GraphLayout["bandBounds"];
  /** The growth before this one, undone next. */
  readonly previous?: ResizeRecord;
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
/**
 * Widest column swap whose two bends cross in one shared slice: two minimal slices, less the
 * insets, 9 px tall, which S-curves 9 px wide cross at about 53°. Wider swaps take a dogleg.
 */
const CROSSING_SWAP = 2 * TRACK_HEIGHT - LANE_SEPARATION;
/** Farthest beyond its bend's own span a dogleg breaking a cycle of turn orders may take its column. */
const DOGLEG_REACH = 4 * MIN_LANE;
/** Widest offset, from its junction's column, at which an input ends its bend (see the fan-in step). */
const FAN_IN = 3;
/** Distance kept outside a forbidden interval when stepping past it. */
const FREE_STEP = 0.5;
/** Beyond any tile: where `fewest-crossings` passing counts an outer margin's lanes as running. */
const MARGIN_ORDER = 1e9;
/**
 * What `fewest-crossings` passing pays, in crossings, for a bend that makes its channel a track
 * taller: 8, the price `layout:eval` puts on a crossing in height (0.00625 tile widths of
 * 120 px each, so 0.75 px a crossing) applied to one track (TRACK_HEIGHT, 6 px).
 */
const PASSING_TRACK = 8;
/** Run reads (`fewest-crossings` passing) a layout's re-planning may take, keeping very large graphs fast. */
const PASSING_WORK = 3_000_000;
/** Rounds of re-planning the courses that cross others (`fewest-crossings` passing); most settle in one. */
const PASSING_ROUNDS = 3;
/** A slot's cost per px away from the route's straight line (in crossings: one crossing is worth a 100 px detour in one row). */
const PASSING_DETOUR = 0.01;
/** The cost of a slot whose lane the route's source does not hold yet (its trunk splits there), in crossings. */
const PASSING_NEW_LANE = 0.1;
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

export function layoutGraph(request: LayoutRequest, options?: BandOptions): GraphLayout {
  if (!request || !Array.isArray(request.items)) throw new RangeError("malformed layout request");
  return request.band ? layoutBand(request, options) : layoutLayered(request);
}

/**
 * How a generation is ordered: `barycenter` sorts each generation once by its parents' mean
 * reading position; `median-sweep` runs Gansner et al.'s iterated median and transpose sweeps
 * (`layer-order.ts`) on the generations, long edges split by virtual nodes.
 */
export type Ordering = "barycenter" | "median-sweep" | {
  /** An explicit position for each key within its generation (evaluation oracles inject exact orders); unknown keys follow by rank. */
  readonly positions: ReadonlyMap<NodeKey, number>;
};

/**
 * Which gap a route takes through each display row it passes, and its lane's place in the gap.
 * `straight`: the open gap nearest the straight line from the route's source to its end, at that
 * row, and lanes ordered by where those lines cross the row; it is the usual placement of a long
 * edge's dummy nodes (Sugiyama, Tagawa and Toda 1981; Gansner et al. 1993, §4) with tiles as the
 * fixed obstacles. Snapping to the nearest gap can still cross other routes where a gap a little
 * further away would not: `fewest-crossings` (the default) starts from the straight choice and
 * then re-plans every route that crosses another to the slots crossing the others least, its
 * straight line breaking ties (`passing-plan.ts`). `nearest-end`, as merged in plan phase 3: the
 * gap nearest the route's end at every row, lanes ordered by source x.
 */
export type Passing = "fewest-crossings" | "straight" | "nearest-end";

export interface LayeredOptions { readonly ordering?: Ordering; readonly passing?: Passing }

/** The reusable layered engine; band candidates call it without recursively planning bands. */
export function layoutLayered(request: LayoutRequest, options: LayeredOptions = {}): GraphLayout {
  if (request.orientation !== "right") return layoutDown(request, spacingFor(request.tileWidth).minWidth, options);
  // Left to right: the same engine on transposed tiles, transposed back.
  // Generations then form columns that never wrap (no height budget), and
  // the canvas needs no minimum height.
  const turned = transposeLayout(layoutDown({ items: request.items.map((item) => ({ ...item, width: item.height, height: item.width })), maxWidth: Infinity, hint: request.hint, tileWidth: request.tileWidth }, 0, { passing: options.passing }));
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
function layoutDown(request: LayoutRequest, minWidth: number, options: LayeredOptions = {}): GraphLayout {
  // Outer margins hold every lane that does not fit between tiles, and the
  // junctions a crowded channel has no column for. When they overflow, they
  // widen (the graph scrolls horizontally) rather than letting lanes merge or
  // dots stack. Legacy placement needs two retries. A pinned band can first
  // consume spare pane width; moving rows within that width changes gap slots,
  // so allow two further routing passes to settle the new slot choices.
  const ordering = options.ordering ?? "barycenter", passing = options.passing ?? "fewest-crossings";
  const prepared = prepare(request, ordering, passing);
  // Rows wrapped within narrower side margins hold more tiles when the pane has room for them;
  // kept only if every lane then still fits beside the rows within the pane.
  const narrow = narrowerRows(prepared) ? prepare(request, ordering, passing, tightMargin(prepared.space)) : null;
  if (narrow) {
    const layout = settle(narrow, minWidth);
    if (layout.width <= prepared.budget + 1e-6) return layout;
  }
  return settle(prepared, minWidth);
}

/** Every routing pass of a prepared layout, widening the margins until the lanes fit (the last pass draws regardless). */
function settle(prepared: Prepared, minWidth: number): GraphLayout {
  let extra = { left: 0, right: 0 };
  const attempts = prepared.pinned ? 4 : 2;
  for (let attempt = 0; ; attempt++) {
    const { layout, shortfall } = layoutPass(prepared, extra, minWidth, attempt === attempts);
    if (layout) return layout;
    extra = { left: extra.left + Math.max(0, Math.ceil(shortfall.left)), right: extra.right + Math.max(0, Math.ceil(shortfall.right)) };
  }
}

/**
 * The narrowest side margin a row of a pinned band may keep: room for the one outer lane the
 * passing slots open beside a row (twice the clearance). The usual margin (`Spacing.margin`)
 * reserves room for several; a layout whose lanes need more than this one widens past the pane
 * and is not kept (`layoutDown`).
 */
export const tightMargin = (space: ReturnType<typeof spacingFor>) => 2 * space.clearance;

/** Whether wrapping a pinned band's generations within {@link tightMargin} would put some generation on fewer display rows. */
function narrowerRows(prepared: Prepared): boolean {
  const { space, items, byBand, gap, margin, budget, pinned, contentWidth } = prepared;
  if (!pinned || !Number.isFinite(budget)) return false;
  const tight = tightMargin(space);
  if (tight >= margin) return false;
  for (let band = 0; band < byBand.length; band++) {
    const widths: number[] = [];
    let widest = 0;
    for (const key of byBand[band]) if (band || key !== pinned.key) { const width = items.get(key)!.width; widths.push(width); widest = Math.max(widest, width); }
    if (widths.length < 2) continue;
    if (countWrapped(widths, Math.max(widest, budget - 2 * tight), gap) < countWrapped(widths, Math.max(widest, contentWidth), gap)) return true;
  }
  return false;
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
  // A pinned layout may wrap its rows within the narrowest side margin it keeps (`layoutDown`) or
  // the usual one: heights are bounded with the first (fewer rows), widths with the second (fuller rows).
  const limitFor = (margin: number) => Math.max(widest, Math.min(natural, Math.max(widest, budget - 2 * margin)));
  const limit = limitFor(request.pinned ? tightMargin(space) : space.margin), wideLimit = limitFor(space.margin);
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
    const perRowWithin = (bound: number) => {
      let perRow = 1;
      if (uniform) for (let used = first; perRow < size && used + gap + first <= bound; perRow++) used += gap + first;
      return perRow;
    };
    const rowsWithin = (bound: number) => {
      if (uniform) return Math.ceil(size / perRowWithin(bound));
      let sum = 0;
      for (const at of members) sum = sum + widths[at] + gap;
      return Math.max(1, Math.ceil(sum / (bound + gap)));
    };
    const perRow = perRowWithin(limit), rows = rowsWithin(limit), wideRows = rowsWithin(wideLimit);
    // The i-th tallest row is at least as tall as the (i·perRow+1)-th tallest tile.
    if (uniform && rows > 1) {
      const sorted = members.map((at) => heights[at]).sort((x, y) => y - x);
      for (let row = 0; row < rows; row++) height += sorted[row * perRow];
    } else for (let row = 0; row < rows; row++) height += row ? shortest : tallest;
    height += (rows - 1) * space.rowChannel + (b < byBand.length - 1 ? space.bandChannel : 0);
    // Balanced or not, some row holds at least the average number of tiles.
    const fullest = uniform ? Math.ceil(size / Math.max(rows, wideRows)) : 1;
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
function prepare(request: LayoutRequest, ordering: Ordering = "barycenter", passing: Passing = "fewest-crossings", sideMargin?: number) {
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
  const margin = sideMargin ?? space.margin;
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

  // Swept generation orders (real nodes, pinned cover excluded), or null to sort by barycenters per pass.
  const given = typeof ordering === "object" ? ordering.positions : null;
  const swept = given ? byBand.map((members) => members.filter((key) => !pinned || key !== pinned.key)
      .sort((a, b) => (given.get(a) ?? 1e15) - (given.get(b) ?? 1e15) || rank.get(a)! - rank.get(b)!))
    : ordering === "median-sweep" && bandCount > 1
    ? orderLayers({ layers: byBand.map((members, b) => b ? members : [...(pinned ? [pinned.key] : []), ...firstBand]), parents: parentsOf, rank: (key) => rank.get(key)! }).map((layer) => layer.filter((key) => !pinned || key !== pinned.key))
    : null;
  const { joinFacts, ordered, targetsOf } = plan.joins.length ? junctionFacts(plan, bands) : NO_JOINS;
  // Route ids join endpoint keys with ">" (and trunk ids with "~"); while no key holds
  // either, the plan's routes (distinct by their ends) have ids distinct from each other and
  // from every trunk id, so they need no collision check.
  let plainKeys = true;
  for (const key of keys) if (typeof key !== "string" || key.includes(">") || key.includes("~")) { plainKeys = false; break; }
  return {
    space, items, keys, parentsOf, bandCount, byBand, pinnedViolation, plan, joinFacts, ordered, targetsOf, plainKeys, swept, passing,
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
  const { space, items, parentsOf, bandCount, byBand, pinnedViolation, plan, joinFacts, ordered, targetsOf, plainKeys, gap, margin, budget, pinned, contentWidth, rank, passing } = prepared;
  /** Whether routes head along their straight lines (`fewest-crossings` starts from them too). */
  const straightLines = passing !== "nearest-end";
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
    else if (prepared.swept) {
      members = prepared.swept[bandIndex];
      const widths: number[] = [];
      for (const key of members) widths.push(items.get(key)!.width);
      wrapped = wrapRow(widths, contentWidth, gap);
    } else {
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
  // tiles or an outer margin: the open one nearest its straight line at that
  // row (`Passing`). Gaps are identified by their geometry, so rows
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
  /** The rows each inner gap's lanes pass, by gap id. */
  const rowsOfSlot = new Map<string, Set<number>>();
  /** The rows each source passes through in each outer margin, by margin. */
  const marginRows = new Map<string, Map<string, number[]>>();
  /** Stems in the channels either side of a row: other sources' exits from the row above, entries into the row below. */
  const stemCache = new Map<number, { readonly x: number; readonly exit?: NodeKey; readonly entry?: NodeKey }[]>();
  const stemsAround = (row: number) => {
    let cached = stemCache.get(row);
    if (!cached) stemCache.set(row, cached = [
      ...spans(row - 1).filter((box) => targetsOf.has(endpointKey({ kind: "node", id: box.key }))).map((box) => ({ x: box.x + box.width / 2, exit: box.key })),
      ...spans(row + 1).filter((box) => parentsOf(box.key).length > 0).map((box) => ({ x: box.x + box.width / 2, entry: box.key })),
    ]);
    return cached;
  };
  /** Whether a stem belongs to `source`: its own exit, or an entry it feeds directly. */
  const ownStem = (source: string, stem: { readonly exit?: NodeKey; readonly entry?: NodeKey }) =>
    stem.exit !== undefined ? source === endpointKey({ kind: "node", id: stem.exit }) : !!targetsOf.get(source)?.has(endpointKey({ kind: "node", id: stem.entry! }));
  /** An inner gap leaves `source` a lane only if some x in it keeps MIN_LANE from every other source's stem. */
  const clearFor = (slot: Slot, row: number, source: string) => {
    if (slot.margin) return true;
    const blocked = stemsAround(row).filter((stem) => stem.x > slot.low - MIN_LANE && stem.x < slot.high + MIN_LANE && !ownStem(source, stem)).map((stem) => [stem.x - MIN_LANE, stem.x + MIN_LANE] as const);
    return !blocked.length || nearestFree(slot.x, blocked, slot.low, slot.high) !== null;
  };
  /** The sources each slot's lane holds so far, with how many of their claims (a source's routes to one end column, at one row) use it. */
  const held = new Map<string, Map<string, number>>();
  const hold = (slot: Slot, source: string, delta: number) => {
    let bySource = held.get(slot.id);
    if (!bySource) held.set(slot.id, bySource = new Map());
    const count = (bySource.get(source) ?? 0) + delta;
    if (count > 0) bySource.set(source, count); else bySource.delete(source);
  };
  const hasRoom = (slot: Slot, source: string) => {
    const holders = held.get(slot.id);
    return !holders || !holders.size || holders.has(source) || holders.size < capacity(slot);
  };
  /** The slots `source` may pass `row` through: straight passing skips gaps whose every x meets another source's stem, while any other is left. */
  const slotsKnown = new Map<number, Map<string, readonly Slot[]>>();
  const slotsFor = (row: number, source: string): readonly Slot[] => {
    let bySource = slotsKnown.get(row);
    if (!bySource) slotsKnown.set(row, bySource = new Map());
    const known = bySource.get(source);
    if (known) return known;
    const all = gapsOf(row);
    const clear = straightLines ? all.filter((slot) => clearFor(slot, row, source)) : all;
    const slots = clear.length ? clear : all;
    bySource.set(source, slots);
    return slots;
  };
  /** The open slot nearest `desired` for `source` at `row` (a margin costs a little extra); with none open, the least loaded. */
  const choose = (row: number, desired: number, source: string): Slot | null => {
    if (!gapsOf(row).length) return null;
    const slots = slotsFor(row, source);
    // Slots are tried by cost, then x, then row order (a stable sort); the
    // first with room takes the source, else the least loaded. With finite
    // keys that order is total, so the first is a minimum and needs no sort.
    // Outer margins cost a little extra: a gap between tiles keeps the route nearer the graph.
    const cost = (slot: Slot) => Math.abs(slot.x - desired) + (slot.margin ? 8 : 0);
    const load = (slot: Slot) => (held.get(slot.id)?.size ?? 0) / capacity(slot);
    let open: Slot | undefined, finite = true, openCost = 0;
    for (const slot of slots) {
      const value = cost(slot);
      if (!Number.isFinite(value) || !Number.isFinite(slot.x)) { finite = false; break; }
      if (open && (value > openCost || (value === openCost && !(slot.x < open.x)))) continue;
      if (hasRoom(slot, source)) { open = slot; openCost = value; }
    }
    if (!finite) {
      const costs = slots.map(cost);
      const options = slots.map((_, index) => index).sort((a, b) => costs[a] - costs[b] || slots[a].x - slots[b].x).map((index) => slots[index]);
      open = options.find((slot) => hasRoom(slot, source)) ?? options.reduce((best, slot) => load(slot) < load(best) ? slot : best);
    } else if (!open) {
      let bestLoad = 0, bestCost = 0;
      for (const slot of slots) {
        const value = cost(slot), used = load(slot);
        if (!open || used < bestLoad || (used === bestLoad && (value < bestCost || (value === bestCost && slot.x < open.x)))) { open = slot; bestLoad = used; bestCost = value; }
      }
    }
    return open!;
  };
  /** Registers `source` in `slot`'s lane at `row`. */
  const take = (row: number, open: Slot, source: string, sourceX: number) => {
    let lane = lanes.get(open.id);
    if (!lane) lanes.set(open.id, lane = { slot: open, sources: new Map<string, number>(), xs: new Map<string, number>() });
    if (!lane.sources.has(source)) lane.sources.set(source, sourceX);
    if (!open.margin) {
      let rows = rowsOfSlot.get(open.id);
      if (!rows) rowsOfSlot.set(open.id, rows = new Set());
      rows.add(row);
    }
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
  /** Per inner gap, per source: the sum and count of the x its routes wanted there, which orders its lanes. */
  const wanted = new Map<string, Map<string, { sum: number; count: number }>>();
  const pending: { node: number; slot: string | null; desired: number }[] = [];
  /** Where a route from `endpoint` starts: its tile's row and centre, or its junction's channel and x. */
  const routeStart = (endpoint: Endpoint): { readonly row: number; readonly x: number } => endpoint.kind === "node"
    ? { row: columns.get(endpoint.id)!.row, x: center(endpoint.id) }
    : { row: placed.get(endpoint.id)!.channel, x: placed.get(endpoint.id)!.x };
  /** The trie root for a route's start; `source` is its endpoint key. */
  const rootOf = (endpoint: Endpoint, source: string): number => {
    const known = sourceRoot.get(source);
    if (known !== undefined) return known;
    const { row, x } = routeStart(endpoint);
    const node: PassNode = endpoint.kind === "node"
      ? { parent: -1, source, row, x, from: { row, edge: "bottom" }, own: NO_JUNCTIONS, tile: `${endpoint.id}` }
      : { parent: -1, source, row, x, from: { junction: endpoint.id }, own: new Set([endpoint.id]) };
    trie.push(node);
    sourceRoot.set(source, trie.length - 1);
    return trie.length - 1;
  };
  // Straight passing follows each source's bundle, not each route: at every row
  // its routes into tiles still passing head for the centroid of their ends, so a
  // fan keeps one trunk (Gansner et al. 1993 likewise route a fan's long edges
  // together until they part). Per source and row: sums of end x, end row, count.
  const bundles = new Map<string, Map<number, { x: number; row: number; count: number }>>();
  if (straightLines) for (const route of plan.routes) {
    if (route.to.kind !== "node") continue;
    const source = endpointKey(route.from), start = trie[rootOf(route.from, source)].row;
    const endRow = columns.get(route.to.id)!.row, endX = center(route.to.id);
    let byRow = bundles.get(source);
    if (!byRow) bundles.set(source, byRow = new Map());
    for (let row = start + 1; row < endRow; row++) {
      const sum = byRow.get(row);
      if (sum) { sum.x += endX; sum.row += endRow; sum.count++; } else byRow.set(row, { x: endX, row: endRow, count: 1 });
    }
  }

  // Each route's end, and its slot in every row it passes. Routes from one
  // source to one end column share their slots (a claim per row): the first to
  // reach a row claims the open slot nearest its straight line there.
  /** `heading`: where the route heads at that row, which orders the lanes sharing its slot: its straight line, or for a re-planned course the mean of where it enters and leaves the row. */
  interface Claim { slot: Slot | null; readonly want: number; heading: number; readonly straight: boolean; taken: boolean }
  /** `id`: its source's endpoint id (`idOf`); `ends`: its routes' ends by channel, x and endpoint id, with the edges each carries. */
  interface Course { readonly source: string; readonly id: number; readonly startRow: number; readonly sourceX: number; readonly endKey: number; readonly claims: Map<number, Claim>; readonly ends: { channel: number; x: number; end: number; weight: number }[] }
  const coursesBySource = new Map<string, Map<number, Course>>();
  /** Endpoint keys as small numbers, for passing plans. */
  const endpointIds = new Map<string, number>();
  const idOf = (key: string) => { let id = endpointIds.get(key); if (id === undefined) endpointIds.set(key, id = endpointIds.size); return id; };
  const routeEnds = plan.routes.map((route) => {
    const source = endpointKey(route.from), start = routeStart(route.from);
    let x: number, channel: number, to: Anchor;
    if (route.to.kind === "node") {
      const row = columns.get(route.to.id)!.row;
      x = center(route.to.id); channel = row - 1; to = { row, edge: "arrow" };
    } else {
      const join = placed.get(route.to.id)!;
      x = join.x; channel = join.channel; to = { junction: route.to.id };
    }
    let course: Course | null = null;
    if (start.row + 1 <= channel) {
      const endKey = round(x);
      let byEnd = coursesBySource.get(source);
      if (!byEnd) coursesBySource.set(source, byEnd = new Map());
      course = byEnd.get(endKey) ?? null;
      if (!course) byEnd.set(endKey, course = { source, id: idOf(source), startRow: start.row, sourceX: start.x, endKey, claims: new Map(), ends: [] });
      course.ends.push({ channel, x, end: idOf(endpointKey(route.to)), weight: Math.max(1, route.consumers.length) });
      const straight = straightLines && route.to.kind === "node";
      for (let row = start.row + 1; row <= channel; row++) {
        if (course.claims.has(row)) continue;
        const bundle = straight ? bundles.get(source)?.get(row) : undefined;
        const want = bundle ? start.x + (bundle.x / bundle.count - start.x) * Math.min(1, (row - start.row) / (bundle.row / bundle.count - start.row)) : x;
        const slot = choose(row, want, source);
        if (slot) hold(slot, source, 1);
        course.claims.set(row, { slot, want, heading: want, straight, taken: false });
      }
    }
    return { x, channel, to, end: idOf(endpointKey(route.to)), weight: Math.max(1, route.consumers.length), course };
  });
  if (passing === "fewest-crossings") reducePassingCrossings([...coursesBySource.values()].flatMap((byEnd) => [...byEnd.values()]),
    plan.routes.flatMap((route, index) => routeEnds[index].course ? [] : [{ source: idOf(endpointKey(route.from)), start: routeStart(route.from), end: routeEnds[index] }]));

  /**
   * Re-plans the courses that cross others (`passing-plan.ts`): each, in turn, takes the slots
   * that cross the other courses' runs the fewest times, its straight line and its own lanes
   * breaking ties, if that crosses less than its slots do now. `direct` routes pass no row.
   */
  function reducePassingCrossings(all: readonly Course[], direct: readonly { readonly source: number; readonly start: { readonly row: number; readonly x: number }; readonly end: { readonly x: number; readonly channel: number; readonly end: number; readonly weight: number } }[]): void {
    // Runs by channel, each tagged with its course (null: a direct route) and the canvas x's it bends between.
    type Tagged = ChannelRun & { readonly course: Course | null; readonly from: number; readonly to: number };
    const runs = new Map<number, Tagged[]>();
    const channelsOf = new Map<Course, number[]>();
    /** Bumped whenever a channel's runs change. */
    const version = new Map<number, number>();
    // Where a course runs, for counting crossings: a gap's x, or for an outer margin a point
    // beyond every tile, ordered among the margin's sources as their lanes are (below).
    const order = (slot: Slot, course: Course) => slot.margin ? (slot.id === "L" ? -MARGIN_ORDER : MARGIN_ORDER) + course.sourceX : slot.x;
    const passageOf = (course: Course, options: (row: number, claim: Claim) => { x: number; at: number; cost: number }[]): Passage => {
      const rows: { options: { x: number; at: number; cost: number }[]; weight: number }[] = [];
      const last = Math.max(...course.ends.map((end) => end.channel));
      // The edges a run carries on from a row: those of the routes ending further down.
      const beyond = (row: number) => course.ends.reduce((sum, end) => end.channel > row ? sum + end.weight : sum, 0);
      for (let row = course.startRow + 1; row <= last; row++) rows.push({ options: options(row, course.claims.get(row)!), weight: beyond(row) });
      return { source: course.id, start: { channel: course.startRow, x: course.sourceX, weight: beyond(course.startRow) }, rows, ends: course.ends };
    };
    const detour = (course: Course, slot: Slot, claim: Claim) =>
      PASSING_DETOUR * (Math.abs(slot.x - claim.want) + (slot.margin ? 8 : 0)) + (held.get(slot.id)?.has(course.source) ? 0 : PASSING_NEW_LANE);
    const current = (course: Course, costs = false) => passageOf(course, (_, claim) => [claim.slot
      ? { x: order(claim.slot, course), at: claim.slot.x, cost: costs ? detour(course, claim.slot, claim) : 0 }
      : { x: course.endKey, at: course.endKey, cost: 0 }]);
    const touch = (channel: number) => version.set(channel, (version.get(channel) ?? 0) + 1);
    const place = (course: Course) => {
      const passage = current(course), channels: number[] = [];
      for (const { channel, run, from, to } of passageRuns(passage, passage.rows.map(() => 0))) { append(runs, channel, { ...run, course, from, to }); channels.push(channel); touch(channel); }
      channelsOf.set(course, channels);
    };
    const unplace = (course: Course) => {
      for (const channel of new Set(channelsOf.get(course))) { runs.set(channel, runs.get(channel)!.filter((run) => run.course !== course)); touch(channel); }
    };
    for (const route of direct) append(runs, route.end.channel, { top: route.start.x, bottom: route.end.x, source: route.source, end: route.end.end, weight: route.end.weight, course: null, from: route.start.x, to: route.end.x });
    for (const course of all) place(course);
    const packed = new Map<number, { readonly version: number; readonly runs: ChannelRuns }>();
    const others = (channel: number): ChannelRuns => {
      const now = version.get(channel) ?? 0, known = packed.get(channel);
      if (known && known.version === now) return known.runs;
      const fresh = packRuns(runs.get(channel) ?? []);
      packed.set(channel, { version: now, runs: fresh });
      return fresh;
    };
    // Bend tracks a channel holds at its default height.
    const freeTracks = (channel: number) => {
      const band = rowKeys[channel].band, last = lastRowOfBand.get(band) === channel;
      return bendZones(space, last ? bandLevels.get(band) ?? 0 : 0, last).reduce((sum, zone) => sum + Math.floor(zone / TRACK_HEIGHT), 0);
    };
    /**
     * A bend's price in tracks: bends of different sources whose reaches overlap take separate
     * tracks (left-edge channel routing, step 5), so a channel needs at least as many as overlap
     * at any x. A bend reaching where the most other sources' bends already overlap, in a
     * channel already holding more than its default height, makes the channel a track taller.
     */
    // The stretches where a channel's bends already need more tracks than it holds, for a source's
    // new bend. Per channel, read at a version of its runs: each source's reaches, merged (its
    // bends share tracks) and opened and closed in x order; then per source, the deepest overlap
    // of the others'.
    // Also, by the column they leave from (in MIN_LANE buckets), the bends a new one could trade
    // columns with.
    interface Crowding {
      readonly version: number; readonly free: number; readonly sources: number; readonly xs: Float64Array; readonly steps: Int8Array; readonly owners: Int32Array;
      readonly bySource: Map<number, readonly (readonly [number, number])[] | null>; readonly leaving: Map<number, Tagged[]>;
    }
    const crowded = new Map<number, Crowding>();
    const crowdingOf = (channel: number, list: readonly Tagged[]): Crowding => {
      const now = version.get(channel) ?? 0;
      let cache = crowded.get(channel);
      if (!cache || cache.version !== now) {
        const spans: [number, number, number][] = [], leaving = new Map<number, Tagged[]>();
        for (const run of list) if (Math.abs(run.from - run.to) >= 0.5) {
          spans.push([Math.min(run.from, run.to) - MIN_LANE, Math.max(run.from, run.to) + MIN_LANE, run.source]);
          append(leaving, Math.floor(run.from / MIN_LANE), run);
        }
        spans.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
        const events: [number, number, number][] = [];
        let sources = 0;
        for (let index = 0; index < spans.length;) {
          let [low, high] = spans[index];
          const owner = spans[index][2];
          sources++;
          for (index++; index < spans.length && spans[index][2] === owner; index++) {
            if (spans[index][0] < high) high = Math.max(high, spans[index][1]);
            else { events.push([low, 1, owner], [high, -1, owner]); [low, high] = spans[index]; }
          }
          events.push([low, 1, owner], [high, -1, owner]);
        }
        // Reaches are open: two that only touch do not overlap.
        events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        crowded.set(channel, cache = {
          version: now, free: freeTracks(channel), sources,
          xs: Float64Array.from(events, (event) => event[0]), steps: Int8Array.from(events, (event) => event[1]), owners: Int32Array.from(events, (event) => event[2]),
          bySource: new Map(), leaving,
        });
      }
      return cache;
    };
    const crowdedFor = (cache: Crowding, source: number): readonly (readonly [number, number])[] | null => {
      const known = cache.bySource.get(source);
      if (known !== undefined) return known;
      let hot: [number, number][] | null = null;
      const { xs, steps, owners, free } = cache;
      if (cache.sources - (owners.includes(source) ? 1 : 0) >= free) {
        let depth = 0, most = 0;
        for (let index = 0; index < xs.length; index++) if (owners[index] !== source) { depth += steps[index]; if (depth > most) most = depth; }
        if (most >= free) {
          hot = [];
          depth = 0;
          for (let index = 0; index < xs.length; index++) {
            if (owners[index] === source) continue;
            depth += steps[index];
            if (depth !== most) continue;
            let next = index + 1;
            while (owners[next] === source) next++;
            hot.push([xs[index], xs[next]]);
          }
        }
      }
      cache.bySource.set(source, hot);
      return hot;
    };
    /**
     * A bend trading columns with another source's (one leaving where the other arrives and
     * arriving where it leaves) is a swap, which the tracks step draws with a dogleg in a track
     * of its own (or crossing in a shared slice twice as tall): it costs a track wherever it is.
     */
    const swaps = (cache: Crowding, source: number, top: number, bottom: number) => {
      const home = Math.floor(bottom / MIN_LANE);
      for (let key = home - 1; key <= home + 1; key++) for (const run of cache.leaving.get(key) ?? []) {
        if (run.source !== source && Math.abs(run.from - bottom) < MIN_LANE && Math.abs(run.to - top) < MIN_LANE) return true;
      }
      return false;
    };
    const priceFor = (course: Course): RunPrice => (channel, tops, bottoms) => {
      const list = runs.get(channel);
      if (!list) return null;
      const cache = crowdingOf(channel, list), hot = crowdedFor(cache, course.id);
      if (!hot && !cache.leaving.size) return null;
      const table = new Float64Array(tops.length * bottoms.length);
      for (let i = 0; i < tops.length; i++) for (let j = 0; j < bottoms.length; j++) {
        if (Math.abs(tops[i] - bottoms[j]) < 0.5) continue;
        let price = swaps(cache, course.id, tops[i], bottoms[j]) ? PASSING_TRACK : 0;
        if (hot) {
          const low = Math.min(tops[i], bottoms[j]) - MIN_LANE, high = Math.max(tops[i], bottoms[j]) + MIN_LANE;
          // The first crowded stretch ending past `low` (they are sorted and disjoint).
          let first = 0, past = hot.length;
          while (first < past) { const middle = (first + past) >> 1; if (hot[middle][1] <= low) first = middle + 1; else past = middle; }
          if (first < hot.length && hot[first][0] < high) price += PASSING_TRACK;
        }
        table[i * bottoms.length + j] = price;
      }
      return table;
    };
    // Every course's crossings, channel by channel.
    const crossingsAt = new Map<Course, number>();
    for (const [channel, list] of runs) {
      const each = runCrossings(others(channel));
      list.forEach((run, index) => { if (run.course && each[index]) crossingsAt.set(run.course, (crossingsAt.get(run.course) ?? 0) + run.weight * each[index]); });
    }
    let candidates = all.map((course, index) => ({ course, index, crossings: crossingsAt.get(course) ?? 0 })).filter((entry) => entry.crossings > 0);
    // Re-planning reads every run of each channel a course passes; past PASSING_WORK such reads
    // (only very large graphs get there) the courses left keep their slots.
    let work = 0;
    for (let round = 0; round < PASSING_ROUNDS && candidates.length; round++) {
      candidates.sort((a, b) => b.crossings - a.crossings || a.index - b.index);
      let changed = false;
      for (const entry of candidates) {
        const { course } = entry, source = course.source;
        let reads = 0;
        for (let channel = course.startRow, last = Math.max(...course.ends.map((end) => end.channel)); channel <= last; channel++) reads += runs.get(channel)?.length ?? 0;
        if (work + reads > PASSING_WORK) continue;
        work += reads;
        for (const claim of course.claims.values()) if (claim.slot) hold(claim.slot, source, -1);
        const slotsAt = new Map<number, (Slot | null)[]>(), taken: number[] = [];
        const passage = passageOf(course, (row, claim) => {
          const slots: (Slot | null)[] = claim.slot ? slotsFor(row, source).filter((slot) => slot === claim.slot || hasRoom(slot, source)) : [null];
          if (claim.slot && !slots.includes(claim.slot)) slots.push(claim.slot);
          slotsAt.set(row, slots);
          taken.push(slots.indexOf(claim.slot));
          return slots.map((slot) => slot ? { x: order(slot, course), at: slot.x, cost: detour(course, slot, claim) } : { x: course.endKey, at: course.endKey, cost: 0 });
        });
        const best = planPassage(passage, others, priceFor(course), taken), now = best?.taken;
        entry.crossings = now?.crossings ?? 0;
        if (best && now && now.crossings > 0) {
          if (best.crossings < now.crossings && best.cost < now.cost) {
            entry.crossings = best.crossings;
            best.choice.forEach((option, index) => { const row = course.startRow + 1 + index; course.claims.get(row)!.slot = slotsAt.get(row)![option]; });
            // Lanes sharing a slot are ordered by where their routes come from and go: the
            // re-planned course heads from its x in the row above to its x in the row below.
            const xs = [course.sourceX, ...best.choice.map((option, index) => passage.rows[index].options[option].at ?? passage.rows[index].options[option].x)];
            const last = xs.length - 1, ends = course.ends.reduce((sum, end) => sum + end.x, 0) / course.ends.length;
            for (let index = 1; index <= last; index++) course.claims.get(course.startRow + index)!.heading = (xs[index - 1] + (index < last ? xs[index + 1] : ends)) / 2;
            unplace(course);
            place(course);
            changed = true;
          }
        }
        for (const claim of course.claims.values()) if (claim.slot) hold(claim.slot, source, 1);
      }
      if (!changed) break;
      // The next round re-plans those that crossed when last planned (others' moves since may
      // have changed that; the rounds are a budget, not a fixed point).
      candidates = candidates.filter((entry) => entry.crossings > 0);
    }
  }

  const courses = plan.routes.map((route, index) => {
    const source = endpointKey(route.from);
    let node = rootOf(route.from, source);
    const sourceX = trie[node].x;
    const { x: endX, to, course } = routeEnds[index];
    if (course) {
      for (let row = course.startRow + 1; row <= routeEnds[index].channel; row++) {
        const claim = course.claims.get(row)!, slot = claim.slot?.id ?? null;
        if (!claim.taken) {
          claim.taken = true;
          if (claim.slot) take(row, claim.slot, source, sourceX);
          if (slot && claim.straight) {
            let bySource = wanted.get(slot);
            if (!bySource) wanted.set(slot, bySource = new Map());
            const sum = bySource.get(source);
            if (sum) { sum.sum += claim.heading; sum.count++; } else bySource.set(source, { sum: claim.heading, count: 1 });
          }
        }
        const key = slot ?? course.endKey;
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

  // Lane positions, once every source in a gap is known: ordered by where
  // their routes' straight lines cross the row (or, `nearest-end`, by where
  // the sources sit), centered on the gap and kept inside it.
  for (const { slot, sources, xs } of lanes.values()) {
    if (slot.margin) continue;
    const at = (source: string, sourceX: number) => { const w = wanted.get(slot.id)?.get(source); return w ? w.sum / w.count : sourceX; };
    const order = [...sources].map(([source, sourceX]) => [source, at(source, sourceX)] as const).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const spacing = order.length > 1 ? Math.min(space.lane, (slot.high - slot.low) / (order.length - 1)) : 0;
    const span = spacing * (order.length - 1);
    const centred = Math.min(slot.high - span, Math.max(slot.low, slot.x - span / 2));
    // A lane runs on through the channels above and below its row, where other
    // sources' stems leave the tiles above (at their centres) and enter the
    // tiles below: keep each lane MIN_LANE clear of those stems where the gap
    // has room, else stay centred.
    const blocked: Interval[] = [];
    for (const row of straightLines ? rowsOfSlot.get(slot.id) ?? [] : []) {
      const stems = stemsAround(row).filter((stem) => stem.x > slot.low - MIN_LANE && stem.x < slot.high + MIN_LANE);
      order.forEach(([source], index) => {
        for (const stem of stems) if (!ownStem(source, stem)) blocked.push([stem.x - index * spacing - MIN_LANE, stem.x - index * spacing + MIN_LANE]);
      });
    }
    const first = blocked.length ? nearestFree(centred, blocked, slot.low, slot.high - span) ?? centred : centred;
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
    /** The bend's zone and its (lowest) track. */
    zone: number; track: number;
    /** Tracks its curve spans, up to and including `track` (one unless it crosses a swapping partner). */
    span?: number;
    /** A dogleg (a swap's, or one breaking a cycle of turn orders): the bend first curves to column `x` in track `track`, then on in its own. */
    dogleg?: { readonly track: number; readonly x: number };
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
    /**
     * Other routes' runs that a run at `x` from level `from` to `to`, bending at `bend`, would
     * touch (`near`), and those it would run along (`shared`): routes from different sources
     * sharing a lane. Inputs of one junction may meet, but only at the junction itself, so
     * two of them running down its column share a lane.
     */
    const clashes = (item: Leg, x: number, from: number, to: number, bend: number | null, found: { near: number; shared: number }) => {
      const home = bucket(x), source = item.source;
      for (let key = home - 1; key <= home + 1; key++) {
        const list = runsAt.get(key);
        if (list) for (const other of list) {
          if (other.leg.source === source || !near(other.x, x)) continue;
          const top = Math.max(other.from, from), bottom = Math.min(other.to, to), column = Math.abs(other.x - x) < .01;
          if (compatible(other.leg, item)) { if (column && top < bottom) found.shared++; continue; }
          if (top > bottom || (other.bend !== null && other.bend === bend && top === bottom)) continue;
          if (column) found.shared++; else found.near++;
        }
      }
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
        const zone = option.zone, found = { near: 0, shared: 0 };
        clashes(item, item.x1, item.lo, zone, zone, found); clashes(item, item.x2, zone, item.hi, zone, found);
        // A shared lane is never traded for anything else; a junction contact outweighs crowding.
        const cost = found.shared * 1e6 + option.touches * 1000 + found.near * 10 - option.room / 100;
        if (!best || cost < best.cost) best = { zone, cost };
        if (!found.near && !found.shared) break;
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
  // Two bends trading columns (a swap) are a cycle of that rule: in slices one after the other,
  // one would leave a column exactly where the other arrives, the two lines meeting end to end
  // there, so each would seem to continue as the other. Channel routers break such a cycle with
  // a dogleg (Deutsch 1976; Yoshimura and Kuh 1982): one bend first curves to a free column
  // between the two in a slice of its own, runs down it across the other's curve, and curves on
  // in a third. Bends trading columns closer than `CROSSING_SWAP` instead cross in one shared
  // slice twice as tall, steeply enough to read as a crossing.
  // Track counts and zone boxes by channel, then zone.
  const trackCount: number[][] = [];
  // Every column a vertical run of the channel occupies, for choosing dogleg columns.
  const columnsIn: number[][] = [];
  for (const item of allLegs) (columnsIn[item.channel] ??= []).push(item.x1, item.x2);
  /**
   * How two swapping bends cross: in one shared slice ("cross"), with a dogleg of one of them
   * (the bend, and the free column between the two it doglegs through), or not at all (null:
   * no free column, or both end in a junction's fan-in, whose bends keep their own shape).
   */
  const swapCrossing = (channel: number, first: Leg, second: Leg): "cross" | { leg: Leg; x: number } | null => {
    const lo = Math.max(Math.min(first.x1, first.x2), Math.min(second.x1, second.x2)), hi = Math.min(Math.max(first.x1, first.x2), Math.max(second.x1, second.x2));
    // Columns other runs occupy between the two: the crossing (or the dogleg's run) keeps off them.
    const busy: [number, number][] = [];
    for (const x of columnsIn[channel] ?? []) if (x > lo && x < hi) busy.push([x - MIN_LANE, x + MIN_LANE]);
    if (Math.max(Math.abs(first.x1 - first.x2), Math.abs(second.x1 - second.x2)) <= CROSSING_SWAP) {
      // They cross midway; a run of another source there would meet both at one point.
      const middle = (lo + hi) / 2;
      return busy.some(([low, high]) => middle > low && middle < high) ? null : "cross";
    }
    const leg = [first, second].find((item) => !("junction" in item.to));
    if (!leg || !(lo + MIN_LANE <= hi - MIN_LANE)) return null;
    const x = nearestFree((lo + hi) / 2, busy, lo + MIN_LANE, hi - MIN_LANE);
    return x === null ? null : { leg, x };
  };
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
    const column = (a: number, b: number) => Math.abs(a - b) < .01;
    const inTurn = (group: number[]): number[] => {
      if (group.length < 2) return group;
      const rest = [...group], out: number[] = [];
      while (rest.length) {
        const free = rest.findIndex((i) => !rest.some((j) => j !== i && column(ordered[j].x1, ordered[i].x2) && !column(ordered[i].x1, ordered[j].x2)));
        out.push(...rest.splice(free < 0 ? 0 : free, 1));
      }
      return out;
    };
    const forced: (Set<number> | undefined)[] = [];
    const pending = new Array<number>(count).fill(0);
    for (let i = 0; i < count; i++) for (let j = 0; j < count; j++) {
      if (!near(ordered[i].x1, ordered[j].x2) || near(ordered[j].x1, ordered[i].x2) || unitOf[i] === unitOf[j] || !conflict(i, j)) continue;
      const later = (forced[unitOf[i]] ??= new Set());
      if (later.has(unitOf[j])) continue;
      later.add(unitOf[j]);
      pending[unitOf[j]]++;
    }
    // Turn order: the forced constraints, otherwise the sort order above.
    const sequenced: boolean[] = [];
    // Bends already given a track, in turn order.
    const done: number[] = [];
    // A cycle of forced constraints (three or more bends, each leaving a column beside where the
    // next arrives) has no order: whichever turns first meets the last one's line along a column
    // pair closer than a lane, between their tracks. Channel routers break such a cycle by
    // splitting one of its nets with a dogleg (Deutsch 1976; ELK's orthogonal router splits a
    // segment of a critical cycle, Schulze et al.): the bend first curves from its column to a
    // free one, in a slice before any of the bends arriving beside its column, runs down the
    // free column, and curves on in a later slice of its own. The first pieces, by bend index.
    const pieces = new Map<number, { readonly x: number; readonly track: number; readonly low: number; readonly high: number }>();
    /** The first slice a piece reaching from `low` to `high` can take, after every bend and piece so far it would meet. */
    const firstTrack = (low: number, high: number, item: Leg) => {
      let track = 0;
      for (const earlier of done) if (ordered[earlier].track + 1 > track && reachLow[earlier] < high && low < reachHigh[earlier] && !compatible(ordered[earlier], item)) track = ordered[earlier].track + 1;
      for (const [index, piece] of pieces) if (piece.track + 1 > track && piece.low < high && low < piece.high && !compatible(ordered[index], item)) track = piece.track + 1;
      return track;
    };
    /** Splits one bend of a cycle with a dogleg, if one can take a free column; whether it did. */
    const splitCycle = (): boolean => {
      for (const id of units) {
        const later = forced[id];
        if (sequenced[id] || members[id].length !== 1 || !later?.size) continue;
        const index = members[id][0], item = ordered[index];
        // A junction's input keeps its fan-in shape.
        if ("junction" in item.to) continue;
        const busy: [number, number][] = [];
        for (const x of columnsIn[channel] ?? []) busy.push([x - MIN_LANE, x + MIN_LANE]);
        const lo = Math.min(item.x1, item.x2), hi = Math.max(item.x1, item.x2);
        const x = nearestFree((lo + hi) / 2, busy, Math.max(0, lo - DOGLEG_REACH), Math.min(width, hi + DOGLEG_REACH));
        if (x === null) continue;
        const low = Math.min(item.x1, x) - MIN_LANE, high = Math.max(item.x1, x) + MIN_LANE;
        pieces.set(index, { x, track: firstTrack(low, high, item), low, high });
        (columnsIn[channel] ??= []).push(x);
        // The bend leaves its column in the piece, so the bends arriving beside that column
        // need no longer wait for it; what remains of it runs from the free column.
        for (const unit of later) pending[unit]--;
        later.clear();
        reachLow[index] = Math.min(x, item.x2) - MIN_LANE; reachHigh[index] = Math.max(x, item.x2) + MIN_LANE;
        return true;
      }
      return false;
    };
    const ready = () => { for (const id of units) if (!sequenced[id] && pending[id] === 0) return id; return -1; };
    for (let step = 0; step < units.length; step++) {
      let next = ready();
      while (next < 0 && splitCycle()) next = ready();
      // No bend of the cycle can dogleg: it is broken in sort order.
      if (next < 0) for (const id of units) if (!sequenced[id]) { next = id; break; }
      sequenced[next] = true;
      const later = forced[next];
      if (later) for (const id of later) pending[id]--;
      // Within a unit, a bend leaving a column exactly where another arrives turns first: in a
      // near swap the other way round would leave both on that column between their tracks.
      const group = inTurn(members[next]);
      let track = 0;
      for (const earlier of done) {
        if (!(ordered[earlier].track + 1 > track)) continue;
        for (const index of group) if (conflict(earlier, index)) { track = ordered[earlier].track + 1; break; }
      }
      // After the pieces it would meet, and a split bend after its own first piece.
      for (const [index, piece] of pieces) for (const member of group) {
        if (member === index || (piece.low < reachHigh[member] && reachLow[member] < piece.high && !compatible(ordered[index], ordered[member]))) track = Math.max(track, piece.track + 1);
      }
      const crossing = group.length === 2 ? swapCrossing(channel, ordered[group[0]], ordered[group[1]]) : null;
      if (crossing === "cross") {
        for (const index of group) { ordered[index].track = track + 1; ordered[index].span = 2; done.push(index); }
        continue;
      }
      if (crossing) {
        // The dogleg leaves its column before the other bend arrives there and reaches the
        // other's column after that one has left it: first slice, third slice; the other between.
        for (const index of group) {
          const item = ordered[index];
          if (item === crossing.leg) { item.dogleg = { track, x: crossing.x }; item.track = track + 2; } else item.track = track + 1;
          done.push(index);
        }
        continue;
      }
      // Otherwise swapping bends take consecutive slices: each leaves its column just as the
      // other arrives, so they do not cross at a shallow angle (but meet end to end there).
      for (let offset = 0; offset < group.length; offset++) { ordered[group[offset]].track = track + offset; done.push(group[offset]); }
    }
    let most = 1;
    for (const item of ordered) most = Math.max(most, item.track + 1);
    for (const [index, piece] of pieces) { ordered[index].dogleg = { track: piece.track, x: piece.x }; most = Math.max(most, piece.track + 1); }
    (trackCount[channel] ??= [])[zone] = most;
  }
  const tracksIn = (channel: number, zone: number) => trackCount[channel]?.[zone] ?? 1;

  // Fan-in. Inputs of one junction meet only at its dot: each bending input ends its bend a
  // little to its own side of the junction's column and reaches the dot along its own slope,
  // so no two share a final stretch (a lane shared between sources). Nearer inputs keep closer
  // to the column, so inputs from one side do not cross before the dot. Offsets stay within
  // the berth other routes and junctions keep from the column, and within half of what the
  // nearest other dot's column on that side leaves beyond LANE_SEPARATION: that dot's inputs
  // may fan out towards this one, and the two must not read as one line.
  const fanIn = new Map<Leg, number>();
  const intoJunction = new Map<string, Leg[]>();
  for (const item of finalLegs) if ("junction" in item.to && bends(item)) append(intoJunction, item.to.junction, item);
  const columnsByChannel = new Map<number, number[]>();
  for (const id of intoJunction.keys()) { const spot = placed.get(id)!; append(columnsByChannel, spot.channel, spot.x); }
  const fanWidth = (id: string, side: number) => {
    const { x, channel } = placed.get(id)!;
    let room = Infinity;
    for (const other of columnsByChannel.get(channel)!) if (Math.sign(other - x) === side) room = Math.min(room, Math.abs(other - x));
    return Math.min(FAN_IN, Math.max(0, (room - LANE_SEPARATION) / 2));
  };
  for (const [id, inputs] of intoJunction) for (const side of [-1, 1]) {
    const group = inputs.filter((item) => Math.sign(item.x1 - item.x2) === side)
      .sort((a, b) => Math.abs(a.x1 - a.x2) - Math.abs(b.x1 - b.x2) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
    if (!group.length) continue;
    const widest = fanWidth(id, side);
    group.forEach((item, rank) => fanIn.set(item, side * widest * (rank + 1) / group.length));
  }

  // Port berths. A tile's outputs leave its bottom edge at its centre; another source bending
  // under that port within the stem's first PORT_BERTH crosses the stem so close to the tile that
  // the stem seems to branch off the passing line. A channel whose first zone holds a bend passing
  // under another source's port (strictly between the bend's ends: a bend ending on a port's
  // column is a lane matter) starts that zone's tracks a berth below the row; the zone grows only
  // where its tracks then need more room.
  const portBerth: number[] = [];
  const portsByRow = new Map<number, { x: number; source: string }[]>();
  for (const item of trie) if (item.parent < 0 && item.tile !== undefined) append(portsByRow, item.row, { x: item.x, source: item.source });
  for (const item of allLegs) {
    if (item.zone !== 0 || portBerth[item.channel] || !bends(item)) continue;
    const lo = Math.min(item.x1, item.x2, item.dogleg?.x ?? Infinity) + .5, hi = Math.max(item.x1, item.x2, item.dogleg?.x ?? -Infinity) - .5;
    for (const port of portsByRow.get(item.channel) ?? []) if (port.source !== item.source && port.x > lo && port.x < hi) { portBerth[item.channel] = PORT_BERTH; break; }
  }
  const berthAt = (channel: number, zone: number) => zone === 0 ? portBerth[channel] ?? 0 : 0;

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
      const tall = Math.max(defaultZone(index, zone), berthAt(index, zone) + tracksIn(index, zone) * TRACK_HEIGHT);
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

  // 7. Paths: vertical to the bend's slice, an S-curve within it (inset from the slice's edges
  // where it has neighbours), vertical on.
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
    const top = Math.max(box.top + berthAt(item.channel, item.zone), y1), bottom = Math.min(box.bottom, y2);
    const tracks = tracksIn(item.channel, item.zone), slice = (bottom - top) / tracks;
    // Each S-curve fills its slice diagonally, so curves in neighbouring slices would converge
    // where one ends and the next begins and read as one line there: with neighbours, a curve
    // keeps half of LANE_SEPARATION inside either edge of its slice, running vertically there.
    const inset = tracks > 1 ? LANE_SEPARATION / 2 : 0;
    const span = item.span ?? 1, start = top + slice * (item.track + 1 - span) + inset, end = top + slice * (item.track + 1) - inset;
    const left = `${round(x1)}`, middle = `${round((start + end) / 2)}`;
    if (item.dogleg) {
      // Curve to the dogleg's column in its first slice, down that column, then on in its own.
      const first = top + slice * item.dogleg.track + inset, last = first + slice - 2 * inset, column = `${round(item.dogleg.x)}`, upper = `${round((first + last) / 2)}`;
      return `${first > y1 ? ` L${left} ${round(first)}` : ""} C${left} ${upper},${column} ${upper},${column} ${round(last)} L${column} ${round(start)} C${column} ${middle},${right} ${middle},${right} ${round(end)}${end < y2 ? ` L${right} ${round(y2)}` : ""}`;
    }
    const fan = fanIn.get(item);
    if (fan) {
      // Into a junction: down its own side of the column to the berth, then a short S-curve
      // that reaches the dot vertically (routes stay orthogonal apart from their curves).
      const side = `${round(x2 + fan)}`, berthTop = Math.max(end, y2 - JUNCTION_BERTH), into = `${round((berthTop + y2) / 2)}`;
      return `${start > y1 ? ` L${left} ${round(start)}` : ""} C${left} ${middle},${side} ${middle},${side} ${round(end)}${end < berthTop ? ` L${side} ${round(berthTop)}` : ""} C${side} ${into},${right} ${into},${right} ${round(y2)}`;
    }
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
