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
import { countLayoutWork } from "./layout-profile";
import { cost, measure } from "./layout-quality";
import { solveOrderedTracks } from "./ordered-tracks";
import { solveSeparation } from "./separation";
import { searchCorridors, type CorridorSearch, type CorridorConflict } from "./corridor-search";
import { solveChannelTopology } from "./channel-topology";
import { smallChannelOrder, freeBoundaryGrowth } from "./channel-domains";
import { channelInk, roundChannelPath, type ChannelInk } from "./channel-corners";
import { importRoutingPlan, junctionInputPorts, tilePort, turnWindow } from "./routing-plan";
import { boundedJunctions } from "./bounded-junctions";
import { layoutBand, type BandOptions } from "./band-layout";
import type { ConsumerSet } from "./route-consumers";
import type { NodeKey } from "./model";
import { buildInputJunctions, endpointKey, edgeKey, type Consumer, type Endpoint, type Junction } from "./junctions";
import { ARROW, bendZones, JUNCTION_BERTH, LANE_SEPARATION, PORT_BERTH, spacingFor, TRACK_HEIGHT } from "./metrics";
import { orderLayers } from "./layer-order";

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
  readonly consumers: ConsumerSet;
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

export interface BandSnapshot {
  readonly signature: string;
  readonly layout: GraphLayout;
  /** Last committed geometry after real grid attachment, in cover-relative coordinates. */
  readonly placed: GraphLayout;
  readonly attachment?: { readonly bandTop: number; readonly placement: import("./band-geometry").BandPlacement };
}

export interface BandHistory extends BandSnapshot {
  /** Earlier published scenes in the same contents/metrics epoch. Observations
   * have no nested history and survive a tile becoming temporarily hidden. */
  readonly observed?: readonly BandSnapshot[];
}

export interface BandDecision {
  readonly routingConflict?: import('./routing-components').RoutingMetricConflict;
  readonly relayout?: 'pane-width' | 'tile-size';
  readonly candidate: string;
  readonly partition?: readonly number[];
  readonly stability: boolean;
  /**
   * `gate-infeasible`: no candidate passed the hard gates (e.g. a cover that is not a root); the downward layout is shown as is.
   * `lane-infeasible`: every candidate ran connectors from different sources along a shared lane; the best of them, priced, is shown.
   * `anchor-yield`: an anchor-preserving layout existed, but crossed far more than the best unanchored one (the crossing cap); the anchors moved.
   */
  readonly fallback?: "geometry-fallback" | "invalid-history" | "anchor-infeasible" | "anchor-yield" | "packing-infeasible" | "gate-infeasible" | "lane-infeasible" | "revisit-pin-conflict";
}

export interface GraphLayout {
  /** Exact native roots already authored in this attachment frame. Reusing the
   * same frame keeps their bytes; another packing frame reconstructs its stem. */
  readonly routingAttachment?: {
    readonly key: string;
    readonly bandTop: number;
    readonly placement: import('./band-geometry').BandPlacement;
    readonly paths: readonly (readonly [string, string])[];
  };
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
const append = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
/** Turn order within a zone: leftward bends by where they end, then where they start; rightward ones reversed. */
/** The junctions a route from a tile belongs to: none. Shared, as it is never modified. */
const NO_JUNCTIONS: ReadonlySet<string> = new Set();
/** Narrowest separation between lanes sharing a gap. */
const MIN_LANE = 3;
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
 * `straight` (the default): the gap nearest the straight line from the route's source to its end,
 * at that row, and lanes ordered by where those lines cross the row. Two straight segments cross
 * at most once, and only where their ends are in opposite orders, so following them adds no
 * crossings of its own; it is the usual placement of a long edge's dummy nodes (Sugiyama, Tagawa
 * and Toda 1981; Gansner et al. 1993, §4) with tiles as the fixed obstacles. `nearest-end`, as
 * merged in plan phase 3: the gap nearest the route's end at every row, lanes ordered by source x.
 */
export type Passing = "straight" | "nearest-end";

export interface LayeredOptions { readonly columnGap?: number; readonly ordering?: Ordering; readonly passing?: Passing; readonly channelStyle?: "scaled" | "orthogonal" }

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
export class RoutingConflictError extends RangeError {
  constructor(readonly conflict: CorridorConflict) { super('Routing search conflict: ' + JSON.stringify(conflict)); }
}
function layoutDown(request: LayoutRequest, minWidth: number, options: LayeredOptions = {}): GraphLayout {
  const prepared = { ...prepare(request, options.ordering ?? "barycenter", options.passing ?? "straight", options.columnGap), channelStyle: options.channelStyle };
  const scoreable=prepared.keys.length>0 && request.items.every(item=>Number.isFinite(item.width) && Number.isFinite(item.height) && item.width>0 && item.height>0 && item.width<=MAX_TILE && item.height<=MAX_TILE);
  const result = searchCorridors(search => {
    const layout=layoutPass(prepared,search,minWidth);
    return layout;
  },64_000_000,scoreable ? {
    score:(layout,search)=>{
      search.charge(layout.routes.length**2+layout.nodes.size,"quality");
      return cost(measure(layout,prepared.pinned?.key??prepared.keys[0],prepared.budget,prepared.keys.map(key=>({key,...prepared.items.get(key)!,parents:prepared.parentsOf(key)}))),request.tileWidth??92);
    // Admit the first fully scored feasible topology. Band candidates retain
    // their existing objective ranking; another successful native rendering
    // here doubled inline work without a product quality guarantee.
    },samples:1,
  }:undefined);
  countLayoutWork('corridor-search-work',result.work);
  countLayoutWork('corridor-search-candidates',result.candidates);
  if (!result.ok) throw new RoutingConflictError(result.conflict);
  return result.value;
}

/**
 * Lower bounds for the child band of the pinned downward layout of `request`
 * (as built by {@link layoutLayered} with `orientation: "down"`), computed from
 * its display rows alone, before any routing: the band's height (from the first
 * child row to the last row's bottom, plus the bottom margin and `stemRoom`), its
 * child allocation width (tile span plus painted padding for orthogonal channels,
 * or 8 px each side for the legacy style) and the connector
 * ink of a tree (each non-cover source's routes reach a child at least one
 * generation channel below it). Mirrors {@link layoutPass}: longest-path
 * generations wrap greedily onto rows of the content width, a row is as tall as
 * its tallest tile, and the channel below a row is at least `rowChannel` inside a
 * generation and `bandChannel` below its last row. Null unless the cover is
 * generation 0's only tile (otherwise its first child row is not known here).
 */
export function downwardBandBound(request: LayoutRequest, coverKey: NodeKey, stemRoom: number, options: LayeredOptions = {}): { readonly height: number; readonly width: number; readonly length: number } | null {
  const space = spacingFor(request.tileWidth), gap = Number.isFinite(options.columnGap) ? Math.max(0, options.columnGap!) : space.column;
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
  const bandChannel = options.channelStyle === "orthogonal" ? space.approach + 2 * LANE_SEPARATION : space.bandChannel;
  const rowChannel = options.channelStyle === "orthogonal" ? space.approach + 2 * LANE_SEPARATION : space.rowChannel;
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
    height += (rows - 1) * rowChannel + (b < byBand.length - 1 ? bandChannel : 0);
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
  return { height: height + space.bottom + stemRoom - 1e-6, width: Math.max(0, width + (options.channelStyle === "orthogonal" ? ARROW.width : 16) - .02 - 1e-6),
    length: Math.max(0, sources * (bandChannel - ARROW.length) - 1e-6) };
}

/**
 * Everything about a request that does not depend on a pass's extra margins:
 * computed once and shared by every pass of {@link layoutDown}.
 */
function prepare(request: LayoutRequest, ordering: Ordering = "barycenter", passing: Passing = "straight", columnGap?: number) {
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
  const plan = boundedJunctions(buildInputJunctions(relationships));
  const gap = Number.isFinite(columnGap) ? Math.max(0, columnGap!) : space.column;
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
type Prepared = ReturnType<typeof prepare> & Pick<LayeredOptions, "channelStyle">;

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

/** One complete discrete embedding. A failed choice backtracks through the
 * request's one work ledger; no partial geometry can reach the emitter. */
function layoutPass(prepared: Prepared, search: CorridorSearch, minWidth: number): GraphLayout {
  const extra = search.growth;
  search.charge(32*(prepared.keys.length + prepared.plan.routes.length)+16*prepared.ordered.length**2);
  const { space, items, parentsOf, bandCount, byBand, pinnedViolation, plan, joinFacts, ordered, targetsOf, plainKeys, gap, margin, budget, pinned, contentWidth, rank, passing } = prepared;
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

  // Junction x/level choices are immutable for this candidate. Their actual
  // input ports are reserved before corridor occupancy; later conflicts choose
  // another embedding instead of relocating a provisional dot.
  const fanOf = (join: Junction) => join.inputs.length === 2 ? LANE_SEPARATION : (join.inputs.length - 1) * LANE_SEPARATION / 2;
  const placed = new Map<string, { x: number; level: number; channel: number }>();
  const channelDepth = new Map<number, number>();
  const intervals = (preferred: number, blocked: readonly Interval[], low = 14, high = width - 14) => {
    const merged = mergeIntervals(blocked);
    const out: {low:number;high:number;preferred:number}[] = [];
    let start = low;
    for (const [a,b] of merged) {
      if (a > start) out.push({low:start,high:Math.floor(Math.min(high,a)*100)/100,preferred});
      start = Math.ceil(Math.max(start,b)*100)/100;
      if (start > high) break;
    }
    if (start <= high) out.push({low:start,high,preferred});
    return out.filter(v=>v.low<=v.high).sort((a,b)=>Math.abs(Math.max(a.low,Math.min(a.high,preferred))-preferred)-Math.abs(Math.max(b.low,Math.min(b.high,preferred))-preferred) || a.low-b.low);
  };
  for (const join of ordered) {
    const {bandIndex,consumers,own,nestedJoins} = joinFacts.get(join.id)!;
    const channel = pinned ? Math.max(...join.parents.map(id=>columns.get(id)!.row)) : lastRowOfBand.get(bandIndex)!;
    const minLevel = 1 + Math.max(0,...nestedJoins.map(id=>placed.get(id)!).filter(p=>p?.channel===channel).map(p=>p.level));
    const parentX = join.parents.reduce((n,id)=>n+center(id),0)/join.parents.length;
    const targetX = consumers.length ? consumers.reduce((n,id)=>n+center(id),0)/consumers.length : parentX;
    const preferred = Math.min(width-14,Math.max(14,parentX*.6+targetX*.4));
    const fan = fanOf(join), berth = JUNCTION_BERTH+fan;
    const blocked: Interval[] = [];
    const conservative: Interval[] = [];
    for (const row of [channel,channel+1]) {
      const boxes = spans(row);
      for (const box of boxes) if (!own.has(box.key)) blocked.push([box.x+box.width/2-berth,box.x+box.width/2+berth]);
      for (let i=1;i<boxes.length;i++) conservative.push([boxes[i-1].x+boxes[i-1].width-berth,boxes[i].x+berth]);
      if (boxes.length) {
        const inset = Math.max(0,berth-JUNCTION_BERTH+MIN_LANE-space.clearance);
        conservative.push([-Infinity,boxes[0].x+inset],[boxes.at(-1)!.x+boxes.at(-1)!.width-inset,Infinity]);
      }
    }
    for (const other of ordered) {
      const p = placed.get(other.id);
      if (!p || p.channel !== channel) continue;
      const radius = Math.max(JUNCTION_BERTH+Math.max(fan,fanOf(other)),fan+fanOf(other)+MIN_LANE);
      blocked.push([p.x-radius,p.x+radius]);
    }
    const choices: {level:number;low:number;high:number;preferred:number}[] = [];
    for (let level=minLevel;level<=Math.max(minLevel,channelDepth.get(channel)??0)+1;level++) {
      const spacing: Interval[] = [...placed.values()].filter(p=>p.channel===channel && p.level===level).map(p=>[p.x-space.junctionSpacing,p.x+space.junctionSpacing]);
      const hard = [...blocked,...spacing];
      for (const interval of intervals(preferred,[...hard,...conservative])) choices.push({...interval,level});
      for (const interval of intervals(preferred,hard)) choices.push({...interval,level});
    }
    search.charge(ordered.length + blocked.length + conservative.length + choices.length);
    if (!choices.length) {
      const need = ordered.filter(j=>joinFacts.get(j.id)!.bandIndex===bandIndex).reduce((sum,j)=>sum+2*(JUNCTION_BERTH+fanOf(j))+FREE_STEP,28);
      const remaining=ordered.filter(j=>!placed.has(j.id) && joinFacts.get(j.id)!.bandIndex===bandIndex);
      const growth=Math.max(berth*2,need-width,remaining.reduce((sum,j)=>sum+Math.max(space.junctionSpacing,2*(JUNCTION_BERTH+fanOf(j)))+FREE_STEP,0));
      search.grow(preferred<width/2 ? growth : 0,preferred<width/2 ? 0 : growth);
    }
    const uniqueChoices=choices.filter((choice,i)=>choices.findIndex(other=>other.level===choice.level && other.low===choice.low && other.high===choice.high)===i);
    const choice = search.choose('junction:'+join.id,uniqueChoices);
    const solved = search.solve({variables:[{id:join.id,preferred:choice.preferred,bounds:{lower:choice.low,upper:choice.high}}],order:[join.id],separations:[]});
    placed.set(join.id,{x:round(solved.positions.get(join.id)!),channel,level:choice.level});
    channelDepth.set(channel,Math.max(choice.level,channelDepth.get(channel)??0));
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
  const fitsGap = (slot: Slot,row:number,source:string) => {
    if(slot.margin) return true;
    const sources=[...new Set([...(lanes.get(slot.id)?.sources.keys()??[]),source])];
    if(sources.length>8) return true;
    const domains=sources.map(id=>{
      const blocked:Interval[]=[];
      const rows=[...new Set([...(marginRows.get(slot.id)?.get(id)??[]),...(id===source?[row]:[])])];
      for(const r of rows) {
        if(passing==='straight') for(const stem of stemsAround(r)) if(!ownStem(id,stem)) blocked.push([stem.x-MIN_LANE,stem.x+MIN_LANE]);
        for(const join of ordered) {
          const p=placed.get(join.id)!;
          if((p.channel===r || p.channel+1===r) && id!=='junction:'+join.id) {const berth=JUNCTION_BERTH+fanOf(join);blocked.push([p.x-berth,p.x+berth]);}
        }
      }
      return {id,intervals:intervals(slot.x,blocked,slot.low,slot.high)};
    });
    search.charge(sources.length*(1<<sources.length));
    return smallChannelOrder(domains,MIN_LANE)!==null;
  };
  const claim = (row: number, desired: number, source: string, sourceX: number): string | null => {
    const all = gapsOf(row);
    if (!all.length) return null;
    // Straight passing skips gaps whose every x meets another source's stem, while any other is left.
    const clear = passing === "straight" ? all.filter((slot) => clearFor(slot, row, source)) : all;
    const slots = clear.length ? clear : all;
    // Slots are tried by cost, then x, then row order (a stable sort); the
    // first with room takes the source, else the least loaded. With finite
    // keys that order is total, so the first is a minimum and needs no sort.
    // Outer margins cost a little extra: a gap between tiles keeps the route nearer the graph.
    const cost = (slot: Slot) => Math.abs(slot.x - desired) + (slot.margin ? 8 : 0);
    const hasRoom = (slot: Slot) => {
      const lane = lanes.get(slot.id);
      return !lane || lane.sources.has(source) || lane.sources.size < capacity(slot);
    };
    const choices = slots.filter(hasRoom).filter(slot=>fitsGap(slot,row,source)).filter(slot => {
      const blocked: Interval[] = [];
      for (const join of ordered) { const p=placed.get(join.id)!; if (p.channel===row || p.channel+1===row) {const berth=JUNCTION_BERTH+fanOf(join);blocked.push([p.x-berth,p.x+berth]);} }
      return !blocked.length || nearestFree(slot.x,blocked,slot.low,slot.high)!==null;
    }).sort((a,b)=>cost(a)-cost(b) || a.x-b.x);
    if (!choices.length) return search.reject(['passing-capacity:'+row+':'+source]);
    const open = search.choose('passing:'+row+':'+source, choices);

    let lane = lanes.get(open.id);
    if (!lane) lanes.set(open.id, lane = { slot: open, sources: new Map<string, number>(), xs: new Map<string, number>() });
    if (!lane.sources.has(source)) lane.sources.set(source, sourceX);
    if (!open.margin) {
      let rows = rowsOfSlot.get(open.id);
      if (!rows) rowsOfSlot.set(open.id, rows = new Set());
      rows.add(row);
    }
    if (placed.size) {
      let used = slotsInRow.get(row);
      if (!used) slotsInRow.set(row, used = new Set());
      used.add(open.id);
    }
    {
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
  // Ports are expressed in their row-local frame until vertical placement. The
  // same tile equation supplies the final emitter start, rather than a second
  // reconstruction from source centres and row bottoms.
  const departureKeys = [...new Set(plan.routes.flatMap(route => route.from.kind === "node" ? [route.from.id] : []))];
  const departurePlan = importRoutingPlan({ nodes: new Map(departureKeys.map(key => {
    const column = columns.get(key)!, tile = items.get(key)!;
    return [key, { key, x: column.x, y: 0, width: tile.width, height: tile.height, row: column.row, band: column.band }];
  })), junctions: new Map(), routes: [], departures: departureKeys });
  const sourcePorts = new Map(departurePlan.ports.map(port => [port.owner.id, port]));
  const sourcePort = (key: string) => sourcePorts.get(key)!;
  /** Lane claims by source, then rounded end x, then row. */
  const claimed = new Map<string, Map<number, Map<number, string | null>>>();
  /** Per inner gap, per source: the sum and count of the x its routes wanted there, which orders its lanes. */
  const wanted = new Map<string, Map<string, { sum: number; count: number }>>();
  const pending: { node: number; slot: string | null; desired: number }[] = [];
  /** The trie root for a route's start; `source` is its endpoint key. */
  const rootOf = (endpoint: Endpoint, source: string): number => {
    const known = sourceRoot.get(source);
    if (known !== undefined) return known;
    const node: PassNode = endpoint.kind === "node"
      ? { parent: -1, source, row: columns.get(endpoint.id)!.row, x: sourcePort(endpoint.id).point.x, from: { row: columns.get(endpoint.id)!.row, edge: "bottom" }, own: NO_JUNCTIONS, tile: `${endpoint.id}` }
      : { parent: -1, source, row: placed.get(endpoint.id)!.channel, x: placed.get(endpoint.id)!.x, from: { junction: endpoint.id }, own: new Set([endpoint.id]) };
    trie.push(node);
    sourceRoot.set(source, trie.length - 1);
    return trie.length - 1;
  };
  // Straight passing follows each source's bundle, not each route: at every row
  // its routes into tiles still passing head for the centroid of their ends, so a
  // fan keeps one trunk (Gansner et al. 1993 likewise route a fan's long edges
  // together until they part). Per source and row: sums of end x, end row, count.
  const bundles = new Map<string, Map<number, { x: number; row: number; count: number }>>();
  if (passing === "straight") for (const route of plan.routes) {
    if (route.to.kind !== "node") continue;
    const source = endpointKey(route.from), start = trie[rootOf(route.from, source)].row;
    const endRow = columns.get(route.to.id)!.row, endX = center(route.to.id);
    let byRow = bundles.get(source);
    if (!byRow) bundles.set(source, byRow = new Map());
    search.charge(Math.max(0,endRow-start-1),"long-edge bundles");
    for (let row = start + 1; row < endRow; row++) {
      const sum = byRow.get(row);
      if (sum) { sum.x += endX; sum.row += endRow; sum.count++; } else byRow.set(row, { x: endX, row: endRow, count: 1 });
    }
  }
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
      const startRow = trie[node].row, straight = passing === "straight" && route.to.kind === "node";
      search.charge(Math.max(0,endChannel-startRow),"corridor chains");
      for (let row = startRow + 1; row <= endChannel; row++) {
        let slot = byRow.get(row);
        if (slot === undefined) {
          const bundle = straight ? bundles.get(source)?.get(row) : undefined;
          const want = bundle ? sourceX + (bundle.x / bundle.count - sourceX) * Math.min(1, (row - startRow) / (bundle.row / bundle.count - startRow)) : endX;
          byRow.set(row, slot = claim(row, want, source, sourceX));
          if (slot && straight) {
            let bySource = wanted.get(slot);
            if (!bySource) wanted.set(slot, bySource = new Map());
            const sum = bySource.get(source);
            if (sum) { sum.sum += want; sum.count++; } else bySource.set(source, { sum: want, count: 1 });
          }
        }
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
    }).sort((a, b) => a.lo - b.lo || a.hi - b.hi
      || (left ? b.sourceX - a.sourceX : a.sourceX - b.sourceX) || a.source.localeCompare(b.source));
    // Allocate interval lifetimes in start order. Source-position order can
    // occupy a track before a later source could reuse it, wasting pane width.
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
          // Equal expanded row endpoints leave a whole tile row between the
          // actual entry/exit channels, so their margin lane can be reused.
          if (!(other.lo < entry.hi && entry.lo < other.hi)) continue;
          const start = other.x - separation + FREE_STEP, end = other.x + separation - FREE_STEP;
          const last = around.at(-1);
          if (last && start <= last[1] + FREE_STEP) last[1] = Math.max(last[1], end);
          else around.push([start, end]);
        }
        for (const join of ordered) {
          const p=placed.get(join.id)!;
          if (p.channel>=entry.lo && p.channel<=entry.hi && entry.source!=='junction:'+join.id) {
            const berth=JUNCTION_BERTH+fanOf(join); around.push([p.x-berth,p.x+berth]);
          }
        }
        const x = nearestFree(entry.anchor, around, left ? -Infinity : entry.edge, left ? entry.edge : Infinity)!;
        let at = byX.length;
        while (at > 0 && byX[at - 1].x > x) at--;
        byX.splice(at, 0, { x, lo: entry.lo, hi: entry.hi });
        xs.push(x);
        overflow = Math.max(overflow, left ? bound - x : x - bound);
      }
      return { xs, overflow };
    };
    const desired = place(space.lane).xs;
    const metricOrder = entries.map((entry,i)=>({...entry,id:entry.source,desired:left?-desired[i]:desired[i]})).sort((a,b)=>a.desired-b.desired || a.id.localeCompare(b.id));
    const separations = metricOrder.flatMap((entry,i)=>metricOrder.slice(i+1).filter(other=>entry.lo<other.hi && other.lo<entry.hi)
      .map(other=>({id:entry.id+'>'+other.id,before:entry.id,after:other.id,gap:MIN_LANE})));
    const outer = left ? -bound : bound;
    const variables = metricOrder.map(entry=>{
      const lower=left?-entry.edge:entry.edge, blocked: Interval[]=[];
      for (const join of ordered) {
        const p=placed.get(join.id)!;
        if (p.channel<entry.lo || p.channel>entry.hi || entry.source==='junction:'+join.id) continue;
        const x=left?-p.x:p.x,berth=JUNCTION_BERTH+fanOf(join);blocked.push([x-berth,x+berth]);
      }
      const choices=intervals(entry.desired,blocked,lower,Infinity);
      if (!choices.length) search.grow(left?MIN_LANE:0,left?0:MIN_LANE);
      const choice=search.choose('margin-domain:'+side+':'+entry.id,choices);
      return {id:entry.id,preferred:entry.desired,bounds:{lower:choice.low,upper:Math.min(outer,choice.high)},domain:choice};
    });
    search.charge(8*(variables.length+separations.length+1));
    const fitted = solveSeparation({variables,order:metricOrder.map(e=>e.id),separations});
    if (!fitted.ok) {
      const end = 'boundary:'+side;
      const expanded = search.solve({variables:[...variables.map(v=>({...v,preferred:v.bounds.lower,bounds:{lower:v.bounds.lower,upper:v.domain.high}})),{id:end,preferred:outer,bounds:{lower:outer}}],
        order:[...metricOrder.map(e=>e.id),end],separations:[...separations,...metricOrder.map(e=>({id:'bound:'+e.id,before:e.id,after:end,gap:0}))]});
      // Cover alignment is a preference for free rows. A pinned cover stays
      // absolute while a left-boundary extension must first consume the rows'
      // unused alignment slack before it can create new passing capacity.
      // Unrelated rows with spare capacity contribute no delay.
      shortfall[left?'left':'right'] = freeBoundaryGrowth(variables.map((v,i)=>({id:v.id,lower:v.bounds.lower,
        alignmentSlack:left && pinned ? Math.max(0,metricOrder[i].edge+space.clearance-margin-extra.left) : 0})),
        metricOrder.map(e=>e.id),separations,outer);
      for (const entry of metricOrder) lane.xs.set(entry.id,(left?-1:1)*expanded.positions.get(entry.id)!);
    } else for (const entry of metricOrder) lane.xs.set(entry.id,(left?-1:1)*fitted.positions.get(entry.id)!);

  }

  if(shortfall.left>0 || shortfall.right>0) search.grow(Math.max(0,shortfall.left),Math.max(0,shortfall.right));
  search.boundaryFeasible();

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
    const variables = order.map(([source],index)=>{
      const blocked: Interval[] = [];
      for (const row of marginRows.get(slot.id)!.get(source)!) {
        if (passing==='straight') for (const stem of stemsAround(row)) if (!ownStem(source,stem)) blocked.push([stem.x-MIN_LANE,stem.x+MIN_LANE]);
        for (const join of ordered) {
          const p=placed.get(join.id)!;
          if ((p.channel===row || p.channel+1===row) && source!=='junction:'+join.id) {
            const berth=JUNCTION_BERTH+fanOf(join);blocked.push([p.x-berth,p.x+berth]);
          }
        }
      }
      const preferred = centred+index*spacing, choices=intervals(preferred,blocked,slot.low,slot.high);
      if (!choices.length) search.reject(['gap-exclusion:'+slot.id+':'+source],'topology',marginRows.get(slot.id)!.get(source)!.map(row=>'passing:'+row+':'+source));
      const choice = search.choose('gap-offset:'+slot.id+':'+source,choices);
      return {id:source,preferred,bounds:{lower:choice.low,upper:choice.high}};
    });
    const decisions = order.flatMap(([source])=>marginRows.get(slot.id)!.get(source)!.map(row=>'passing:'+row+':'+source));
    const preferredOrder=order.map(([source])=>source);
    search.charge(variables.length<=8 ? variables.length*(1<<variables.length) : variables.length);
    const fittingOrder=smallChannelOrder(variables.map(v=>({id:v.id,intervals:[{low:v.bounds.lower,high:v.bounds.upper}]})),MIN_LANE);
    const orderChoices=[preferredOrder];
    if(fittingOrder && fittingOrder.some((id,i)=>id!==preferredOrder[i])) orderChoices.push([...fittingOrder]);
    const candidateOrder=search.choose('gap-order:'+slot.id,orderChoices);
    const solved=search.solve({variables,order:candidateOrder,
      separations:candidateOrder.slice(1).map((source,i)=>({id:slot.id+':'+i,before:candidateOrder[i],after:source,gap:MIN_LANE}))},[...decisions,'gap-order:'+slot.id,...variables.map(v=>'gap-offset:'+slot.id+':'+v.id)]);
    solved.positions.forEach((x,source)=>xs.set(source,x));

  }
  for (const { node, slot, desired } of pending) trie[node].x = slot ? laneX(slot, trie[node].source)! : desired;

  // Every chosen lane keeps all foreign convergence regions clear. A
  // conflict backtracks into corridor/junction choices, with no dropped berth.
  for (const join of ordered) {
    const p = placed.get(join.id)!, berth = JUNCTION_BERTH+fanOf(join);
    for (const row of [p.channel,p.channel+1]) for (const slot of slotsInRow.get(row)??[]) {
      for (const source of lanes.get(slot)!.sources.keys()) {
        if (!marginRows.get(slot)!.get(source)!.includes(row)) continue;
        search.charge();
        if (source!=='junction:'+join.id && Math.abs(laneX(slot,source)!-p.x)<berth) {
          search.reject(['junction-corridor:'+join.id+':'+source], 'topology', ['passing:'+row+':'+source,'junction:'+join.id]);
        }
      }
    }
  }

  // Channels in level space. The channel below row c holds levelCount(c)
  // junction levels; bend zone i lies between level i and level i + 1
  // (level 0 is the row above, the last zone ends at the row below). Bends
  // happen only inside zones, so a route never bends across a junction level.
  const levelCount = (channel: number) => channelDepth.get(channel) ?? 0;
  type Anchor = { readonly row: number; readonly edge: "top" | "bottom" | "arrow" } | { readonly junction: string };
  interface Leg {
    readonly channel: number; readonly source: string; readonly target: string | null;
    readonly x1: number; readonly x2: number; readonly from: Anchor; readonly to: Anchor;
    readonly own: ReadonlySet<string>; readonly lo: number; readonly hi: number;
    /** The bend's zone and its (lowest) track. */
    zone: number; track: number;
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
  const initialFinalLegs = courses.map(({ route, source, last, end, own }) => {
    const from = trie[last];
    return leg(from.row, source, endpointKey(route.to), from.x, end.x, from.from, end.to, own);
  });
  // Reserve actual approach columns before any zone or track occupancy is built.
  // The final six-pixel fan still ends at the separately recorded dot column.
  const targets = new Map<string, Leg[]>();
  for (const item of initialFinalLegs) if ("junction" in item.to) append(targets, item.to.junction, item);
  const fanIn = new Map<Leg, number>();
  const portsBySource = new Map<string, number>();
  for (const [id,inputs] of targets) {
    const join = plan.joins.find(j=>j.id===id)!;
    for (const port of junctionInputPorts(join,placed.get(id)!.x,inputs.map(l=>({source:l.source,x:l.x1})))) portsBySource.set(JSON.stringify([id,port.source]),port.x);
  }
  const finalLegs = initialFinalLegs.map(item => {
    if (!('junction' in item.to)) return item;
    const x = portsBySource.get(JSON.stringify([item.to.junction,item.source]))!;
    const reserved = {...item,x2:x}; fanIn.set(reserved,x-item.x2); return reserved;
  });
  const allLegs: Leg[] = [];
  for (const item of nodeLegs) if (item !== null) allLegs.push(item);
  for (const item of finalLegs) allLegs.push(item);
  const bends = (item: Leg) => round(item.x1) !== round(item.x2);
  const near = (a: number, b: number) => Math.abs(a - b) < MIN_LANE;
  for (const item of allLegs) if (!bends(item)) for (const [id,p] of placed) {
    search.charge();
    if(p.channel===item.channel && !item.own.has(id) && p.level>item.lo && p.level<=item.hi && Math.abs(p.x-item.x1)<JUNCTION_BERTH)
      search.reject(['straight-junction:'+id],'topology',['junction:'+id]);
  }
  // Routes from one source (a branching trunk) or into one junction may meet.
  const compatible = (a: Leg, b: Leg) => a.source === b.source
    || (a.target !== null && a.target === b.target && a.target.startsWith("junction:")
      && (a.x1 - a.x2) * (b.x1 - b.x2) < 0);

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
      for (let offset = -1; offset <= 1; offset++) {
        const key = home + offset;
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
    /**
     * Other routes' runs that a run at `x` from level `from` to `to`, bending at `bend`, would
     * touch (`near`), and those it would run along (`shared`): routes from different sources
     * sharing a lane. Inputs of one junction may meet, but only at the junction itself, so
     * two of them running down its column share a lane.
     */
    const clashes = (item: Leg, x: number, from: number, to: number, bend: number | null, found: { near: number; shared: number }) => {
      const home = bucket(x), source = item.source;
      for (let offset = -1; offset <= 1; offset++) {
        const key = home + offset;
        const list = runsAt.get(key);
        if (list) for (const other of list) {
          if (other.leg.source === source || !near(other.x, x)) continue;
          const top = Math.max(other.from, from), bottom = Math.min(other.to, to), column = Math.abs(other.x - x) < .01;
          if (compatible(other.leg, item)) { if (column && top < bottom) found.shared++; continue; }
          if (top > bottom || (other.bend !== null && other.bend === bend && top === bottom)) continue;
          if (top < bottom) found.shared++; else found.near++;
        }
      }
    };
    const runsFor = (item: Leg, zone: number): Run[] => [{ x: item.x1, from: item.lo, to: zone, bend: zone, leg: item }, { x: item.x2, from: zone, to: item.hi, bend: zone, leg: item }];
    for (const item of legs) if (!bends(item)) register(item, [{ x: item.x1, from: item.lo, to: item.hi, bend: null, leg: item }]);
    // All endpoint choices are already explicit. Zone alternatives keep
    // positive-length incompatible runs and foreign dot berths hard; touching
    // bend endpoints are ordered by the channel dependency solve below.
    const choose = (item: Leg, id: number) => {
      const above = levelsNear(item,item.x1), beneath = levelsNear(item,item.x2);
      const choices: {zone:number;cost:number}[] = [];
      for (let zone=item.lo;zone<=item.hi;zone++) {
        search.charge();
        if (above.some(level=>level>item.lo && level<=zone) || beneath.some(level=>level>zone && level<=item.hi)) continue;
        const found = {near:0,shared:0};
        clashes(item,item.x1,item.lo,zone,zone,found); clashes(item,item.x2,zone,item.hi,zone,found);
        if (found.shared) continue;
        choices.push({zone,cost:found.near*10-defaultZone(channel,zone)/100});
      }
      choices.sort((a,b)=>a.cost-b.cost || a.zone-b.zone);
      item.zone = search.choose('zone:'+channel+':'+id,choices).zone;
      register(item,runsFor(item,item.zone));
    };
    for (const [id,item] of bending.entries()) if (item.lo===item.hi) register(item,runsFor(item,item.lo)); else choose(item,id);
  }

  // Channel topology and metrics are one bounded search. Critical cycles
  // split endpoint pieces, and the separation solve enforces every dependency.
  const trackCount: number[][] = [];
  const zoneGroups: Leg[][][] = [];
  const columnsIn: number[][] = [];
  for (const item of allLegs) {
    (columnsIn[item.channel]??=[]).push(item.x1,item.x2);
    if (bends(item)) ((zoneGroups[item.channel]??=[])[item.zone]??=[]).push(item);
  }
  for (const [channel,zones] of zoneGroups.entries()) for (const [zone,legs] of (zones??[]).entries()) {
    if (!legs?.length) continue;
    const result = solveChannelTopology(legs.map((item,i)=>({...item,id:String(i)})),columnsIn[channel],width,search);
    for (const [id,assignment] of result.tracks) {
      const item = legs[Number(id)]; item.track = assignment.track;
      if (assignment.split) item.dogleg = assignment.split;
    }
    (trackCount[channel]??=[])[zone] = result.count;
  }
  const tracksIn = (channel: number, zone: number) => trackCount[channel]?.[zone] ?? 1;

  // Port berths. A tile's outputs leave its bottom edge at its centre; another source bending
  // under that port within the stem's first PORT_BERTH crosses the stem so close to the tile that
  // the stem seems to branch off the passing line. A channel whose first zone holds a bend passing
  // under another source's port (strictly between the bend's ends: a bend ending on a port's
  // column is a lane matter) starts that zone's tracks a berth below the row; the zone grows only
  // where its tracks then need more room.
  const portBerth: number[] = [], nearbyPort: boolean[] = [];
  const portsByRow = new Map<number, { x: number; source: string }[]>();
  for (const item of trie) if (item.parent < 0 && item.tile !== undefined) append(portsByRow, item.row, { x: sourcePort(item.tile).point.x, source: item.source });
  for (const item of allLegs) {
    if (item.zone !== 0 || portBerth[item.channel] || !bends(item)) continue;
    const lo = Math.min(item.x1, item.x2, item.dogleg?.x ?? Infinity) - PORT_BERTH, hi = Math.max(item.x1, item.x2, item.dogleg?.x ?? -Infinity) + PORT_BERTH;
    for (const port of portsByRow.get(item.channel) ?? []) if (port.source !== item.source && port.x > lo && port.x < hi) {
      nearbyPort[item.channel] = true;
      if (port.x > lo + PORT_BERTH + .5 && port.x < hi - PORT_BERTH - .5) { portBerth[item.channel] = PORT_BERTH; break; }
    }
  }
  const berthAt = (channel: number, zone: number) => zone === 0
    ? portBerth[channel] ?? 0 : 0;

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
      // Tracks keep three pixels between centers and at free ends; tile ports reserve six.
      const preferredHeight = prepared.channelStyle === "orthogonal" ? 2 * LANE_SEPARATION : defaultZone(index, zone);
      let tall: number;
      {
        search.charge(16*(tracksIn(index,zone)+1));
        const solved = solveOrderedTracks(tracksIn(index, zone), preferredHeight,
          zone === 0 && nearbyPort[index] ? PORT_BERTH : LANE_SEPARATION, LANE_SEPARATION);
        if (!solved.ok) throw new RangeError("Zone constraint conflict: " + JSON.stringify(solved.conflict));
        tall = solved.positions.get("end")!;
      }
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

  // 7. Paths: vertical to the reserved track, across it, then vertical on, with local fillets.
  // Junction inputs converge inside their explicit reserved regions.
  // Bend zones end `approach` above the next row, so a route into a tile ends
  // in a straight, vertical stem at least as long as its arrowhead.
  const preferredTrackCenter = (item: Leg, track: number) => {
    const box = zoneBoxes[item.channel][item.zone], y1 = at(item.from), y2 = at(item.to);
    const top = Math.max(box.top + berthAt(item.channel, item.zone), y1), bottom = Math.min(box.bottom, y2);
    const tracks = tracksIn(item.channel, item.zone), slice = (bottom - top) / tracks;
    const first = Math.max(box.top, y1) + (item.zone === 0 && nearbyPort[item.channel] ? PORT_BERTH : LANE_SEPARATION);
    const last = bottom - LANE_SEPARATION;
    return tracks === 1 ? (first + last) / 2 : first + (last - first) * track / (tracks - 1);
  };
  // In plain channels each ordinal denotes one common track coordinate. The
  // channel end/port berths become bounds, not offsets applied after assignment.
  const solvedCenters = new Map<Leg, readonly number[]>();
  for (const zones of zoneGroups) for (const legs of zones ?? []) {
    if (!legs?.length || legs.some(item => item.dogleg)) continue;
    const item = legs[0], box = zoneBoxes[item.channel][item.zone];
    const count = tracksIn(item.channel, item.zone);
    // Junction fan/crossing shapes with distinct endpoint windows remain outside
    // this adapter. Their old coordinates and emitter are unchanged.
    if (legs.some(other => at(other.from) !== at(item.from) || at(other.to) !== at(item.to))) continue;
    const lower = Math.max(box.top, at(item.from)) + (item.zone === 0 && nearbyPort[item.channel] ? PORT_BERTH : LANE_SEPARATION);
    const upper = Math.min(box.bottom, at(item.to)) - LANE_SEPARATION;
    const order = Array.from({ length: count }, (_, i) => `${i}`);
    const solved = search.solve({ variables: order.map((id, i) => ({ id, preferred: preferredTrackCenter(item, i), bounds: { lower, upper } })), order,
      separations: order.slice(1).map((id, i) => ({ id: `track:${id}`, before: order[i], after: id, gap: LANE_SEPARATION })) });
    const centers = [...solved.positions.values()];
    for (const leg of legs) solvedCenters.set(leg, centers);
  }
  const trackCenter = (item: Leg, track: number) => solvedCenters.get(item)?.[track] ?? preferredTrackCenter(item, track);
  const drawSharp = (item: Leg): string => {
    const y1 = at(item.from), y2 = at(item.to);
    const { x1, x2 } = item;
    // Each coordinate is formatted once, however often the path repeats it.
    const right = `${round(x2)}`;
    if (!bends(item) && !fanIn.has(item)) {
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
    const end = top + slice * (item.track + 1) - inset;
    const left = `${round(x1)}`, middle = `${round(trackCenter(item, item.track))}`;
    if (item.dogleg) {
      const column = `${round(item.dogleg.x)}`, upper = `${round(trackCenter(item, item.dogleg.track))}`;
      const prefix = ` L${left} ${upper} L${column} ${upper} L${column} ${middle} L${right} ${middle}`;
      const fan = fanIn.get(item);
      if (fan !== undefined && fan !== 0) {
        const dot = `${round(x2-fan)}`, berthTop = Math.max(Number(middle),y2-JUNCTION_BERTH), into = `${round((berthTop+y2)/2)}`;
        return `${prefix} L${right} ${round(berthTop)} C${right} ${into},${dot} ${into},${dot} ${round(y2)}`;
      }
      return `${prefix} L${right} ${round(y2)}`;
    }
    const fan = fanIn.get(item);
    if (fan !== undefined && fan !== 0) {
      // Into a junction: down its own side of the column to the berth, then a short S-curve
      // that reaches the dot vertically (routes stay orthogonal apart from their curves).
      const side = `${round(x2)}`, dot = `${round(x2 - fan)}`, berthTop = Math.max(end, y2 - JUNCTION_BERTH), into = `${round((berthTop + y2) / 2)}`;
      return ` L${left} ${middle} L${side} ${middle} L${side} ${round(berthTop)} C${side} ${into},${dot} ${into},${dot} ${round(y2)}`;
    }
    return ` L${left} ${middle} L${right} ${middle} L${right} ${round(y2)}`;
  };
  search.charge(16*allLegs.length,"native ink");
  // Foreign ink is read from the sharp drawing, independently of turn order.
  const sharp = new Map(allLegs.map(item => [item, `M${round(item.x1)} ${round(at(item.from))}${drawSharp(item)}`]));
  const ink = new Map<number, { item: Leg; runs: ChannelInk[] }[]>();
  const nativeInk=new Map<Leg,ChannelInk[]>();
  for (const item of allLegs) {
    const runs=channelInk(sharp.get(item)!);nativeInk.set(item,runs);
    append(ink, item.channel, { item, runs });
  }
  const draw = (item: Leg): string => {
    if (!bends(item) && !fanIn.has(item)) return drawSharp(item);
    const box = zoneBoxes[item.channel][item.zone];
    search.charge(ink.get(item.channel)!.length,"foreign ink selection");
    const foreign = ink.get(item.channel)!.filter(other => other.item.source !== item.source).flatMap(other => other.runs);
    search.charge((8*foreign.length+tracksIn(item.channel,item.zone)+1)*nativeInk.get(item)!.length,"ink conflicts");
    const centers = Array.from({ length: tracksIn(item.channel, item.zone) }, (_, track) => round(trackCenter(item, track)));
    const path = roundChannelPath(sharp.get(item)!, foreign, corner => {
      return turnWindow(corner, box, centers).upper!;
    });
    return path.replace(/^M[^LC]*/, '');
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
    const bottom = rows[tile.row].bottom, port = tilePort(tile, sourcePort(item.tile!).side), x = round(port.point.x);
    return `M${x} ${round(port.point.y)}${port.point.y < bottom ? ` L${x} ${round(bottom)}` : ""}`;
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
  // DFS makes every subtree's consumers a contiguous range in one shared table.
  // A route contributes once, regardless of how many trunk segments carry it.
  const children = trie.map(() => [] as number[]), endings = trie.map(() => [] as number[]);
  trie.forEach((item, node) => { if (item.parent >= 0) children[item.parent].push(node); });
  courses.forEach((course, i) => endings[course.last].push(i));
  const consumers: Consumer[] = [], ranges: { start: number; end: number }[] = [];
  const visit: { node: number; leave: boolean }[] = [];
  trie.forEach((item, node) => { if (item.parent < 0) visit.push({ node, leave: false }); });
  while (visit.length) {
    const { node, leave } = visit.pop()!;
    if (leave) {
      ranges[node].end = consumers.length;
    } else {
      ranges[node] = { start: consumers.length, end: consumers.length };
      for (const i of endings[node]) for (const entry of courses[i].route.consumers) {
        consumers.push(entry);

      }
      visit.push({ node, leave: true });
      for (let i = children[node].length - 1; i >= 0; i--) visit.push({ node: children[node][i], leave: false });
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
      if (!endpointOf) { endpointOf = new Map(); for (const { route, source } of courses) endpointOf.set(source, route.from); }
      const from = endpointOf.get(item.source)!;
      // Exact source and trie position identify this segment without a lossy hash.
      routes.push({ id: JSON.stringify(["trunk", from.kind, from.id, node]), from, to: from, consumers: { entries: consumers, ...ranges[node] }, path, terminal: false });
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
    const id = edgeKey(route.from, route.to);
    routes.push({ id: plainKeys ? id : unique(id), from: route.from, to: route.to, consumers: route.consumers, path, terminal: route.to.kind === "node" });
  });

  const result: GraphLayout = {orientation:"down",width,height,nodes,rows,routes,readingOrder:reading,
    ...(pinnedViolation ? {pinnedViolation}:{}),junctions};
  if ([...items.values()].every(item=>item.width>0 && item.height>0)) importRoutingPlan(result,search.charge);
  return result;
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
