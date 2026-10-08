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
import type { NodeKey } from "./model";
import { buildInputJunctions, endpointKey, type Consumer, type Endpoint, type Junction } from "./junctions";
import { SPACING } from "./metrics";

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

export interface LayoutRequest {
  readonly items: readonly LayoutItem[];
  /** Pixel width available for the graph. Generations wrap to fit it when they run down; running right, they never wrap. */
  readonly maxWidth: number;
  /** Previous reading order, used to keep ordering stable between relayouts. */
  readonly hint?: ReadonlyMap<NodeKey, number>;
  /** Defaults to "down". */
  readonly orientation?: Orientation;
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

export interface GraphLayout {
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
const append = <K, V>(map: Map<K, V[]>, key: K, ...values: V[]) => { const list = map.get(key); if (list) list.push(...values); else map.set(key, [...values]); };
/** Narrowest separation between lanes sharing a gap. */
const MIN_LANE = 3;
/** A route this close to a junction it does not belong to reads as passing through it. */
const JUNCTION_BERTH = 6;
/** Distance kept outside a forbidden interval when stepping past it. */
const FREE_STEP = 0.5;
/** No tile is anywhere near this big; larger sizes are clamped so coordinates stay exact. */
const MAX_TILE = 100_000;
/** Height of one bend track; a zone grows when its tracks need more than its default height. */
const TRACK_HEIGHT = 6;

/** Splits an ordered sequence into the fewest rows, then balances row widths. */
export function wrapRow(widths: readonly number[], limit: number, gap: number): number[][] {
  if (!widths.length) return [];
  const greedy = (bound: number): number[][] => {
    const rows: number[][] = [];
    let current: number[] = [];
    let used = 0;
    widths.forEach((width, index) => {
      const next = current.length ? used + gap + width : width;
      if (current.length && next > bound) { rows.push(current); current = [index]; used = width; }
      else { current.push(index); used = next; }
    });
    rows.push(current);
    return rows;
  };
  const widest = widths.reduce((most, value) => Math.max(most, value), 0);
  const target = greedy(Math.max(limit, widest)).length;
  if (target === 1) return greedy(Math.max(limit, widest));
  // Smallest bound that still needs no more rows: evens out the last row.
  let low = widest;
  let high = Math.max(limit, widest);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (greedy(middle).length <= target) high = middle; else low = middle;
  }
  return greedy(greedy(low).length <= target ? low : high);
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
  if (request.orientation !== "right") return layoutDown(request, SPACING.minWidth);
  // Left to right: the same engine on transposed tiles, transposed back.
  // Generations then form columns that never wrap (no height budget), and
  // the canvas needs no minimum height.
  const turned = layoutDown({ items: request.items.map((item) => ({ ...item, width: item.height, height: item.width })), maxWidth: Infinity, hint: request.hint }, 0);
  return transposeLayout(turned);
}

/** Mirrors a layout across its diagonal: x and y (and widths and heights) trade places. */
export function transposeLayout(layout: GraphLayout): GraphLayout {
  const swapPairs = (path: string) => path.replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g, "$2 $1");
  return {
    orientation: layout.orientation === "down" ? "right" : "down",
    width: layout.height,
    height: layout.width,
    nodes: new Map([...layout.nodes].map(([key, node]) => [key, { ...node, x: node.y, y: node.x, width: node.height, height: node.width }])),
    junctions: new Map([...layout.junctions].map(([id, junction]) => [id, { ...junction, x: junction.y, y: junction.x }])),
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
  // dots stack. Geometry is placed relative to the tiles, so one retry with
  // the measured shortfall fits the lanes; a second covers junctions that
  // took room the lanes' widening opened.
  let extra = { left: 0, right: 0 };
  for (let attempt = 0; ; attempt++) {
    const { layout, shortfall } = layoutPass(request, extra, minWidth);
    if ((shortfall.left <= 0 && shortfall.right <= 0) || attempt === 2) return layout;
    extra = { left: extra.left + Math.max(0, Math.ceil(shortfall.left)), right: extra.right + Math.max(0, Math.ceil(shortfall.right)) };
  }
}

function layoutPass(request: LayoutRequest, extra: { readonly left: number; readonly right: number }, minWidth: number): { layout: GraphLayout; shortfall: { left: number; right: number } } {
  // Malformed input never spreads through the geometry: a size that is not a
  // finite, non-negative number counts as zero, sizes are capped far above
  // any tile, and an order that is not a number sorts first (ties by key).
  const size = (value: number) => Number.isFinite(value) && value > 0 ? Math.min(value, MAX_TILE) : 0;
  const items = new Map(request.items.map((item) => [item.key, { ...item, width: size(item.width), height: size(item.height), order: Number.isFinite(item.order) ? item.order : 0 }]));
  const parentsOf = (key: NodeKey) => [...new Set(items.get(key)!.parents)].filter((parent) => parent !== key && items.has(parent));
  const keys = [...items.keys()];

  // Longest-path bands, computed iteratively so deep edit chains cannot
  // exhaust the stack. Cycles (already rejected upstream) are cut at the back edge.
  const bands = new Map<NodeKey, number>();
  const visiting = new Set<NodeKey>();
  for (const start of keys) {
    if (bands.has(start)) continue;
    const stack: NodeKey[] = [start];
    while (stack.length) {
      const key = stack[stack.length - 1];
      if (bands.has(key)) { stack.pop(); continue; }
      visiting.add(key);
      const pending = parentsOf(key).filter((parent) => !bands.has(parent) && !visiting.has(parent));
      if (pending.length) { stack.push(...pending); continue; }
      let value = 0;
      for (const parent of parentsOf(key)) { const known = bands.get(parent); if (known !== undefined && known + 1 > value) value = known + 1; }
      bands.set(key, value);
      visiting.delete(key);
      stack.pop();
    }
  }
  let bandCount = 0;
  for (const value of bands.values()) if (value + 1 > bandCount) bandCount = value + 1;

  const plan = buildInputJunctions(keys.map((child) => ({ child, parents: parentsOf(child) })));
  const joins = new Map(plan.joins.map((join) => [join.id, join]));
  const joinBand = (join: Junction) => join.parents.reduce((most, id) => Math.max(most, bands.get(id)!), 0);
  const depths = new Map<string, number>();
  const joinDepth = (id: string): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const join = joins.get(id)!;
    const nested = join.inputs.filter((input) => input.kind === "junction" && joinBand(joins.get(input.id)!) === joinBand(join));
    const depth = 1 + Math.max(0, ...nested.map((input) => joinDepth(input.id)));
    depths.set(id, depth);
    return depth;
  };
  plan.joins.forEach((join) => joinDepth(join.id));
  const gap = SPACING.column;
  const margin = SPACING.margin;
  const widest = keys.reduce((most, key) => Math.max(most, items.get(key)!.width), 0);
  const byBand: NodeKey[][] = Array.from({ length: bandCount }, () => []);
  for (const key of keys) byBand[bands.get(key)!].push(key);
  const natural = byBand.reduce((most, members) => Math.max(most, members.reduce((sum, key) => sum + items.get(key)!.width, 0) + Math.max(0, members.length - 1) * gap), 0);
  const budget = Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : Infinity;
  const contentLimit = Math.max(widest, budget - 2 * margin);
  const contentWidth = Math.max(widest, Math.min(natural, contentLimit));
  const width = Math.max(contentWidth + 2 * margin, Math.min(minWidth, budget)) + extra.left + extra.right;

  // 1. Horizontal placement. Each band is ordered, wrapped onto display rows
  // and centered. Vertical positions come last, once junction levels and
  // bend tracks have claimed the channel space they need.
  interface Column { readonly x: number; readonly row: number; readonly band: number }
  const columns = new Map<NodeKey, Column>();
  const rowKeys: { band: number; keys: NodeKey[] }[] = [];
  const reading = new Map<NodeKey, number>();
  const lastRowOfBand = new Map<number, number>();
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
  const tieBreak = (a: NodeKey, b: NodeKey) => rank.get(a)! - rank.get(b)!;
  const center = (key: NodeKey) => columns.get(key)!.x + items.get(key)!.width / 2;
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
    // Barycenter of parents in reading order (row first, then x) keeps
    // children near their parents even when parent rows wrapped.
    const score = (key: NodeKey) => {
      const parents = parentsOf(key);
      return parents.reduce((sum, parent) => sum + columns.get(parent)!.row * 1e6 + center(parent), 0) / parents.length;
    };
    const members = [...byBand[bandIndex]].sort((a, b) => bandIndex === 0 ? tieBreak(a, b) : score(a) - score(b) || tieBreak(a, b));
    const wrapped = wrapRow(members.map((key) => items.get(key)!.width), contentWidth, gap);
    wrapped.forEach((indices) => {
      const keysInRow = indices.map((index) => members[index]);
      const rowWidth = keysInRow.reduce((sum, key) => sum + items.get(key)!.width, 0) + (keysInRow.length - 1) * gap;
      let x = extra.left + (width - extra.left - extra.right - rowWidth) / 2;
      const row = rowKeys.length;
      for (const key of keysInRow) {
        columns.set(key, { x: round(x), row, band: bandIndex });
        reading.set(key, reading.size);
        x += items.get(key)!.width + gap;
      }
      rowKeys.push({ band: bandIndex, keys: keysInRow });
      lastRowOfBand.set(bandIndex, row);
    });
  }
  const spanCache = new Map<number, { key: NodeKey; x: number; width: number }[]>();
  const spans = (row: number) => {
    let cached = spanCache.get(row);
    if (!cached) spanCache.set(row, cached = (rowKeys[row]?.keys ?? []).map((key) => ({ key, x: columns.get(key)!.x, width: items.get(key)!.width })));
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
    const consumers = [...consumersOf.get(join.id) ?? []];
    const parentX = join.parents.reduce((sum, id) => sum + center(id), 0) / join.parents.length;
    const targetX = consumers.length ? consumers.reduce((sum, id) => sum + center(id), 0) / consumers.length : parentX;
    const bandIndex = joinBand(join);
    const channel = lastRowOfBand.get(bandIndex)!;
    const self = endpointKey({ kind: "junction", id: join.id });
    const solelyHere = (parent: NodeKey) => [...targetsOf.get(endpointKey({ kind: "node", id: parent })) ?? []].every((target) => target === self);
    const own = new Set<NodeKey>([...join.parents.filter(solelyHere), ...consumers]);
    const nested = join.inputs.filter((input) => input.kind === "junction" && placed.get(input.id)?.channel === channel);
    const minLevel = 1 + nested.reduce((most, input) => Math.max(most, placed.get(input.id)!.level), 0);
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
      const spacing = mergeSortedStarts(onLevelOf(channel, level).map((other) => [other - SPACING.junctionSpacing, other + SPACING.junctionSpacing] as const));
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
  const ordered = [...plan.joins].sort((a, b) => depths.get(a.id)! - depths.get(b.id)! || a.id.localeCompare(b.id));
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
  interface Slot { readonly id: string; readonly x: number; readonly low: number; readonly high: number; readonly margin: boolean; readonly cost: number }
  const slotCache = new Map<number, Omit<Slot, "cost">[]>();
  const gapsOf = (row: number) => {
    const cached = slotCache.get(row);
    if (cached) return cached;
    const boxes = spans(row);
    const clear = SPACING.clearance;
    const options: Omit<Slot, "cost">[] = [];
    const first = boxes[0];
    const last = boxes.at(-1)!;
    // Each outer margin is one slot for the whole graph: a source keeps one
    // x in it, placed once every source is known (below).
    if (first.x - clear >= clear) options.push({ id: "L", x: first.x - SPACING.column / 2, low: clear, high: first.x - clear, margin: true });
    for (let index = 1; index < boxes.length; index++) {
      const low = boxes[index - 1].x + boxes[index - 1].width + clear;
      const high = boxes[index].x - clear;
      if (high >= low) options.push({ id: `G:${round(low)}:${round(high)}`, x: (low + high) / 2, low, high, margin: false });
    }
    if (width - clear >= last.x + last.width + clear) options.push({ id: "R", x: last.x + last.width + SPACING.column / 2, low: last.x + last.width + clear, high: width - clear, margin: true });
    slotCache.set(row, options);
    return options;
  };
  // Outer margins cost a little extra: a gap between tiles keeps the route nearer the graph.
  const slotsFor = (row: number, desired: number): Slot[] => gapsOf(row)
    .map((slot) => ({ ...slot, cost: Math.abs(slot.x - desired) + (slot.margin ? 8 : 0) }))
    .sort((a, b) => a.cost - b.cost || a.x - b.x);
  const lanes = new Map<string, { slot: Slot; sources: Map<string, number> }>();
  // Margins take any number of lanes; they widen on the next pass if needed.
  const capacity = (slot: Slot) => slot.margin ? Infinity : Math.floor((slot.high - slot.low) / MIN_LANE) + 1;
  // Room the outer margins lack: for their lanes, and for junctions that
  // found no column of their own. The next pass widens them by this much.
  const shortfall = { left: 0, right: 0 };
  const slotsInRow = new Map<number, Set<string>>();
  /** The rows each source passes through in each outer margin. */
  const marginRows = new Map<string, number[]>();
  const claim = (row: number, desired: number, source: string, sourceX: number): string | null => {
    const options = slotsFor(row, desired);
    if (!options.length) return null;
    const load = (slot: Slot) => (lanes.get(slot.id)?.sources.size ?? 0) / capacity(slot);
    const open = options.find((slot) => {
      const lane = lanes.get(slot.id);
      return !lane || lane.sources.has(source) || lane.sources.size < capacity(slot);
    }) ?? options.reduce((best, slot) => load(slot) < load(best) ? slot : best);
    const lane = lanes.get(open.id) ?? { slot: open, sources: new Map<string, number>() };
    lanes.set(open.id, lane);
    if (!lane.sources.has(source)) lane.sources.set(source, sourceX);
    let used = slotsInRow.get(row);
    if (!used) slotsInRow.set(row, used = new Set());
    used.add(open.id);
    if (open.margin) append(marginRows, `${open.id}|${source}`, row);
    return open.id;
  };

  // Courses. Routes from one source that cross a row through the same lane
  // share everything above it, so passes form a trie per source: each node is
  // one row crossing, computed (and later drawn) once however many routes
  // run through it. Work then grows with each source's trunk, not with
  // routes × rows.
  interface PassNode { readonly parent: number; readonly source: string; readonly row: number; readonly x: number; readonly from: Anchor; readonly own: ReadonlySet<string> }
  const trie: PassNode[] = [];
  const trieIndex = new Map<string, number>();
  const sourceRoot = new Map<string, number>();
  const claimed = new Map<string, string | null>();
  const pending: { node: number; slot: string | null; desired: number }[] = [];
  const rootOf = (endpoint: Endpoint): number => {
    const source = endpointKey(endpoint);
    const known = sourceRoot.get(source);
    if (known !== undefined) return known;
    const node: PassNode = endpoint.kind === "node"
      ? { parent: -1, source, row: columns.get(endpoint.id)!.row, x: center(endpoint.id), from: { row: columns.get(endpoint.id)!.row, edge: "bottom" }, own: new Set() }
      : { parent: -1, source, row: placed.get(endpoint.id)!.channel, x: placed.get(endpoint.id)!.x, from: { junction: endpoint.id }, own: new Set([endpoint.id]) };
    trie.push(node);
    sourceRoot.set(source, trie.length - 1);
    return trie.length - 1;
  };
  const courses = plan.routes.map((route) => {
    const source = endpointKey(route.from);
    let node = rootOf(route.from);
    const sourceX = trie[node].x;
    let endX: number; let endChannel: number; let to: Anchor;
    if (route.to.kind === "node") {
      const row = columns.get(route.to.id)!.row;
      endX = center(route.to.id); endChannel = row - 1; to = { row, edge: "arrow" };
    } else {
      const join = placed.get(route.to.id)!;
      endX = join.x; endChannel = join.channel; to = { junction: route.to.id };
    }
    for (let row = trie[node].row + 1; row <= endChannel; row++) {
      const memo = `${row}|${source}|${round(endX)}`;
      let slot = claimed.get(memo);
      if (slot === undefined) claimed.set(memo, slot = claim(row, endX, source, sourceX));
      const key = `${node}|${row}|${slot ?? `@${round(endX)}`}`;
      let child = trieIndex.get(key);
      if (child === undefined) {
        child = trie.length;
        trie.push({ parent: node, source, row, x: 0, from: { row, edge: "bottom" }, own: trie[node].own });
        trieIndex.set(key, child);
        pending.push({ node: child, slot, desired: endX });
      }
      node = child;
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
  const laneX = new Map<string, number>();
  for (const side of ["L", "R"] as const) {
    const sources = lanes.get(side)?.sources;
    if (!sources) continue;
    const left = side === "L";
    const entries = [...sources].map(([source, sourceX]) => {
      const used = marginRows.get(`${side}|${source}`)!;
      const edges = used.map((row) => spans(row)).filter((boxes) => boxes.length)
        .map((boxes) => left ? boxes[0].x - SPACING.clearance : boxes.at(-1)!.x + boxes.at(-1)!.width + SPACING.clearance);
      const edge = left ? Math.min(...edges) : Math.max(...edges);
      return { source, sourceX, lo: Math.min(...used) - 1, hi: Math.max(...used) + 1, edge, anchor: left ? edge - SPACING.column / 2 + SPACING.clearance : edge + SPACING.column / 2 - SPACING.clearance };
    }).sort((a, b) => (left ? b.sourceX - a.sourceX : a.sourceX - b.sourceX) || a.source.localeCompare(b.source));
    const bound = left ? SPACING.clearance : width - SPACING.clearance;
    /** Every entry's x at one separation; the outer side is unbounded, so each always finds one. */
    const place = (separation: number) => {
      const placedLanes: { x: number; lo: number; hi: number }[] = [];
      for (const entry of entries) {
        const around = placedLanes.filter((other) => other.lo <= entry.hi && entry.lo <= other.hi)
          .map((other) => [other.x - separation + FREE_STEP, other.x + separation - FREE_STEP] as const);
        const x = nearestFree(entry.anchor, around, left ? -Infinity : entry.edge, left ? entry.edge : Infinity)!;
        placedLanes.push({ x, lo: entry.lo, hi: entry.hi });
      }
      const overflow = Math.max(0, ...placedLanes.map(({ x }) => left ? bound - x : x - bound));
      return { xs: placedLanes.map(({ x }) => x), overflow };
    };
    const roomy = place(SPACING.lane);
    const chosen = roomy.overflow <= 0 ? roomy : place(MIN_LANE);
    shortfall[left ? "left" : "right"] = Math.max(shortfall[left ? "left" : "right"], chosen.overflow);
    entries.forEach((entry, index) => laneX.set(`${side}|${entry.source}`, chosen.xs[index]));
  }

  // Lane positions, once every source in a gap is known: ordered by where the
  // sources sit (fewer crossings), centered on the gap and kept inside it.
  for (const [id, { slot, sources }] of lanes) {
    if (slot.margin) continue;
    const order = [...sources].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const spacing = order.length > 1 ? Math.min(SPACING.lane, (slot.high - slot.low) / (order.length - 1)) : 0;
    const span = spacing * (order.length - 1);
    const first = Math.min(slot.high - span, Math.max(slot.low, slot.x - span / 2));
    order.forEach(([source], index) => laneX.set(`${id}|${source}`, first + index * spacing));
  }
  for (const { node, slot, desired } of pending) {
    const item = trie[node];
    trie[node] = { ...item, x: slot ? laneX.get(`${slot}|${item.source}`)! : desired };
  }

  // 3b. Deferred junctions, now kept off the columns routes actually
  // use (lanes, tile exits and arrow entries) rather than whole gaps and
  // margins. If even that is full, a dot may sit above another; at worst only
  // same-level spacing holds.
  if (deferred.length) {
    const laneColumns = (row: number) => [...slotsInRow.get(row) ?? []].flatMap((slot) => [...lanes.get(slot)!.sources.keys()].map((source) => laneX.get(`${slot}|${source}`)!));
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
      if (root !== undefined) trie[root] = { ...trie[root], x };
    }
    for (const course of courses) if (course.end.to && "junction" in course.end.to && moved.has(course.end.to.junction)) course.end.x = moved.get(course.end.to.junction)!;
  }

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
  const allLegs = [...nodeLegs.filter((item): item is Leg => item !== null), ...finalLegs];
  const bends = (item: Leg) => Math.abs(item.x1 - item.x2) >= 0.5;
  const near = (a: number, b: number) => Math.abs(a - b) < MIN_LANE;
  // Routes from one source (a branching trunk) or into one junction may meet.
  const compatible = (a: Leg, b: Leg) => a.source === b.source || (a.target !== null && a.target === b.target && a.target.startsWith("junction:"));

  // 4. Zones. Each bend takes the zone whose vertical runs stay clear of
  // junctions it does not belong to (touching one would read as one more
  // input combined there) and of other routes' vertical runs; among equally
  // clear zones, the roomiest.
  const legsIn = new Map<number, Leg[]>();
  for (const item of allLegs) append(legsIn, item.channel, item);
  const defaultZone = (channel: number, zone: number) => {
    const count = levelCount(channel);
    if (!count) return lastRowOfBand.get(rowKeys[channel].band) === channel ? SPACING.bandChannel : SPACING.rowChannel;
    if (zone === 0) return 10 + SPACING.junctionLevel - JUNCTION_BERTH;
    if (zone === count) return SPACING.bandChannel - 10 - JUNCTION_BERTH;
    return SPACING.junctionLevel - 2 * JUNCTION_BERTH;
  };
  type Run = { readonly x: number; readonly from: number; readonly to: number; readonly bend: number | null; readonly leg: Leg };
  const bucket = (x: number) => Math.floor(x / MIN_LANE);
  const junctionsByChannel = new Map<number, { id: string; x: number; level: number }[]>();
  for (const [id, join] of placed) append(junctionsByChannel, join.channel, { id, x: join.x, level: join.level });
  for (const [channel, legs] of legsIn) {
    // Foreign junctions by x, to find those on a bend's columns.
    const junctionAt = new Map<number, { id: string; x: number; level: number }[]>();
    for (const join of junctionsByChannel.get(channel) ?? []) append(junctionAt, Math.floor(join.x / JUNCTION_BERTH), join);
    const levelsNear = (item: Leg, x: number) => {
      const found: number[] = [];
      for (let key = Math.floor(x / JUNCTION_BERTH) - 1; key <= Math.floor(x / JUNCTION_BERTH) + 1; key++) {
        for (const join of junctionAt.get(key) ?? []) if (!item.own.has(join.id) && Math.abs(join.x - x) < JUNCTION_BERTH) found.push(join.level);
      }
      return found;
    };
    // Vertical runs by x bucket and source; a bend's runs are replaced when it moves zone.
    const runsAt = new Map<number, Map<string, Set<Run>>>();
    const runsOf = new Map<Leg, Run[]>();
    const register = (item: Leg, list: Run[]) => {
      runsOf.set(item, list);
      for (const run of list) {
        let bySource = runsAt.get(bucket(run.x));
        if (!bySource) runsAt.set(bucket(run.x), bySource = new Map());
        let set = bySource.get(item.source);
        if (!set) bySource.set(item.source, set = new Set());
        set.add(run);
      }
    };
    const unregister = (item: Leg) => {
      for (const run of runsOf.get(item) ?? []) runsAt.get(bucket(run.x))?.get(item.source)?.delete(run);
      runsOf.delete(item);
    };
    const clashes = (run: Run) => {
      let count = 0;
      for (let key = bucket(run.x) - 1; key <= bucket(run.x) + 1; key++) for (const [source, set] of runsAt.get(key) ?? []) {
        if (source === run.leg.source) continue;
        for (const other of set) {
          if (!near(other.x, run.x) || compatible(other.leg, run.leg)) continue;
          const top = Math.max(other.from, run.from), bottom = Math.min(other.to, run.to);
          if (top > bottom || (other.bend !== null && other.bend === run.bend && top === bottom)) continue;
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
        const touches = above.filter((level) => level > item.lo && level <= zone).length + beneath.filter((level) => level > zone && level <= item.hi).length;
        options.push({ zone, touches, room: defaultZone(channel, zone) });
      }
      options.sort((a, b) => a.touches - b.touches || b.room - a.room || a.zone - b.zone);
      let best: { zone: number; cost: number } | null = null;
      for (const option of options) {
        if (best && option.touches * 1000 > best.cost) break;
        const crowding = runsFor(item, option.zone).reduce((sum, run) => sum + clashes(run), 0);
        const cost = option.touches * 1000 + crowding * 10 - option.room / 100;
        if (!best || cost < best.cost) best = { zone: option.zone, cost };
        if (!crowding) break;
      }
      item.zone = best!.zone;
      register(item, runsFor(item, item.zone));
    };
    const bending = legs.filter(bends);
    for (const item of bending) choose(item);
    // A second pass lets earlier bends react to later ones.
    for (const item of bending) { unregister(item); choose(item); }
  }

  // 5. Tracks. Bends in one zone whose spans overlap bend in separate
  // horizontal slices of it (left-edge channel routing), so two routes never
  // run side by side at a shallow angle: wherever they cross, one of them runs
  // vertically. Within a direction the bend reaching furthest turns first, so
  // parallel routes never cross; and a route leaving a column bends before
  // another route arriving in it, so their vertical runs never overlap.
  const trackCount = new Map<string, number>();
  const zoneGroups = new Map<string, Leg[]>();
  for (const item of allLegs) if (bends(item)) {
    const id = `${item.channel}:${item.zone}`;
    append(zoneGroups, id, item);
  }
  for (const [id, legs] of zoneGroups) {
    const leftward = legs.filter((item) => item.x2 < item.x1).sort((a, b) => a.x2 - b.x2 || a.x1 - b.x1);
    const rightward = legs.filter((item) => item.x2 > item.x1).sort((a, b) => b.x2 - a.x2 || b.x1 - a.x1);
    const ordered = [...leftward, ...rightward];
    if (ordered.every((item) => item.source === ordered[0].source)) continue;
    const reach = ordered.map((item) => [Math.min(item.x1, item.x2) - MIN_LANE, Math.max(item.x1, item.x2) + MIN_LANE]);
    // Two bends trading columns (a swap) form one unit, below.
    const swap = (a: Leg, b: Leg) => near(a.x1, b.x2) && near(b.x1, a.x2);
    const conflict = (i: number, j: number) => reach[i][0] < reach[j][1] && reach[j][0] < reach[i][1] && !compatible(ordered[i], ordered[j]);
    // Swapping bends move as one unit; forced order: a bend leaving a column
    // turns before one arriving in it.
    const unit = ordered.map((_, index) => index);
    const root = (index: number): number => unit[index] === index ? index : (unit[index] = root(unit[index]));
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      if (swap(ordered[i], ordered[j]) && !compatible(ordered[i], ordered[j])) unit[root(j)] = root(i);
    }
    const units = [...new Set(ordered.map((_, index) => root(index)))];
    const members = new Map<number, number[]>();
    ordered.forEach((_, index) => append(members, root(index), index));
    const forced = new Map(units.map((id) => [id, new Set<number>()]));
    const pending = new Map(units.map((id) => [id, 0]));
    for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
      if (root(i) === root(j) || !conflict(i, j) || !near(ordered[i].x1, ordered[j].x2) || near(ordered[j].x1, ordered[i].x2)) continue;
      if (forced.get(root(i))!.has(root(j))) continue;
      forced.get(root(i))!.add(root(j));
      pending.set(root(j), pending.get(root(j))! + 1);
    }
    // Turn order: the forced constraints, otherwise the sort order above (a
    // cycle of forced constraints is broken in sort order).
    const sequence: number[] = [];
    const sequenced = new Set<number>();
    while (sequence.length < units.length) {
      const next = units.find((id) => !sequenced.has(id) && pending.get(id) === 0) ?? units.find((id) => !sequenced.has(id))!;
      sequenced.add(next);
      sequence.push(next);
      for (const later of forced.get(next)!) pending.set(later, pending.get(later)! - 1);
    }
    for (let position = 0; position < sequence.length; position++) {
      const group = members.get(sequence[position])!;
      let track = 0;
      for (let before = 0; before < position; before++) {
        for (const earlier of members.get(sequence[before])!) {
          if (group.some((index) => conflict(earlier, index))) track = Math.max(track, ordered[earlier].track + 1);
        }
      }
      // Swapping bends take consecutive slices: each leaves its column just
      // as the other arrives, so they neither overlap nor cross at a shallow angle.
      group.forEach((index, offset) => { ordered[index].track = track + offset; });
    }
    trackCount.set(id, ordered.reduce((most, item) => Math.max(most, item.track + 1), 1));
  }

  // 6. Vertical placement. Each zone is as tall as its tracks need (crowded
  // channels grow instead of squeezing bends), and junction levels sit
  // between zones.
  const nodes = new Map<NodeKey, PlacedNode>();
  const rows: RowBox[] = [];
  const zoneBox = new Map<string, { top: number; bottom: number }>();
  let y: number = SPACING.top;
  rowKeys.forEach(({ band, keys: keysInRow }, index) => {
    for (const key of keysInRow) {
      const item = items.get(key)!;
      nodes.set(key, { key, x: columns.get(key)!.x, y, width: item.width, height: item.height, band, row: index });
    }
    const bottom = y + keysInRow.reduce((most, key) => Math.max(most, items.get(key)!.height), 0);
    rows.push({ index, band, top: y, bottom, keys: keysInRow });
    y = bottom;
    const count = levelCount(index);
    for (let zone = 0; zone <= count; zone++) {
      const tall = Math.max(defaultZone(index, zone), (trackCount.get(`${index}:${zone}`) ?? 1) * TRACK_HEIGHT);
      zoneBox.set(`${index}:${zone}`, { top: y, bottom: y + tall });
      y += tall + (zone < count ? 2 * JUNCTION_BERTH : 0);
    }
  });
  const height = rows.length ? rows.at(-1)!.bottom + SPACING.bottom : 0;
  const junctions = new Map<string, PlacedJunction & { channel: number }>();
  for (const join of plan.joins) {
    const { x, level, channel } = placed.get(join.id)!;
    junctions.set(join.id, { id: join.id, parents: join.parents, channel, x, y: round(zoneBox.get(`${channel}:${level - 1}`)!.bottom + JUNCTION_BERTH) });
  }
  const at = (anchor: Anchor): number => {
    if ("junction" in anchor) return junctions.get(anchor.junction)!.y;
    const row = rows[anchor.row];
    return anchor.edge === "bottom" ? row.bottom : anchor.edge === "top" ? row.top : row.top - SPACING.arrow;
  };

  // 7. Paths: vertical to the bend's slice, an S-curve within it, vertical on.
  const draw = (item: Leg): string => {
    const y1 = at(item.from), y2 = at(item.to);
    const { x1, x2 } = item;
    if (!bends(item)) return ` L${round(x2)} ${round(y2)}`;
    const box = zoneBox.get(`${item.channel}:${item.zone}`)!;
    const top = Math.max(box.top, y1), bottom = Math.min(box.bottom, y2);
    const slice = (bottom - top) / (trackCount.get(`${item.channel}:${item.zone}`) ?? 1);
    const start = top + slice * item.track, end = start + slice;
    const middle = round((start + end) / 2);
    return `${start > y1 ? ` L${round(x1)} ${round(start)}` : ""} C${round(x1)} ${middle},${round(x2)} ${middle},${round(x2)} ${round(end)}${end < y2 ? ` L${round(x2)} ${round(y2)}` : ""}`;
  };
  // Shared stretches are drawn once, as trunks carrying the consumers of
  // every route through them; each route draws only from where it branches
  // off. A trunk ends where routes leave it, so its highlight is exact.
  const usage = trie.map(() => 0);
  for (const { last } of courses) usage[last] += 1;
  for (let node = trie.length - 1; node >= 0; node--) if (trie[node].parent >= 0) usage[trie[node].parent] += usage[node];
  // A node's continuation is the child every route through it continues to.
  const continuation = new Map<number, number>();
  trie.forEach((item, node) => { if (item.parent >= 0 && usage[node] === usage[item.parent]) continuation.set(item.parent, node); });
  const startOf = (node: number): string => {
    const item = trie[node];
    if (item.parent >= 0) { const into = nodeLegs[node]!; return `M${round(into.x1)} ${round(at(into.from))}`; }
    if ("junction" in item.from) return `M${round(item.x)} ${round(at(item.from))}`;
    const tile = nodes.get(item.source.slice(5))!;
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
  const trunkConsumers = new Map<number, Consumer[]>();
  const trails = courses.map(({ route, last }) => {
    const trail: number[] = [];
    for (let node = last; node >= 0; node = trie[node].parent) trail.push(node);
    trail.reverse();
    for (const node of trail) if (chainStart(node)) append(trunkConsumers, node, ...route.consumers);
    return trail;
  });
  const routes: PlacedRoute[] = [];
  // Ids key the rendered connectors, so they must be unique; a hash collision
  // in trunk names (vanishingly rare) is resolved here deterministically.
  const ids = new Set<string>();
  const unique = (id: string) => { let result = id; for (let n = 2; ids.has(result); n++) result = `${id}#${n}`; ids.add(result); return result; };
  const endpointOf = new Map(courses.map(({ route, source }) => [source, route.from]));
  trie.forEach((item, node) => {
    if (!chainStart(node)) return;
    let path = startOf(node);
    // Follow the single continuation that keeps every route of this trunk.
    for (let current: number | undefined = node; current !== undefined; current = continuation.get(current)) path += piece(current);
    if (/[LC]/.test(path)) {
      const consumers = [...new Map(trunkConsumers.get(node)!.map((entry) => [`${entry.parent}>${entry.child}`, entry])).values()];
      const from = endpointOf.get(item.source)!;
      // Named by what it carries, not where it runs, so a trunk keeps its id
      // (and morphs) across relayouts that move it.
      const carried = hashOf(consumers.map((entry) => `${entry.parent}>${entry.child}`).sort().join("|"));
      routes.push({ id: unique(`${item.source}~${carried}`), from, to: from, consumers, path, terminal: false });
    }
  });
  courses.forEach(({ route, source }, index) => {
    const trail = trails[index];
    const branch = trail.findIndex((node) => !shared(node));
    let path: string;
    if (branch === -1) { const final = finalLegs[index]; path = `M${round(final.x1)} ${round(at(final.from))}`; }
    else { path = startOf(trail[branch]); for (const node of trail.slice(branch)) path += piece(node); }
    path += draw(finalLegs[index]);
    routes.push({ id: unique(`${source}>${endpointKey(route.to)}`), from: route.from, to: route.to, consumers: route.consumers, path, terminal: route.to.kind === "node" });
  });

  return {
    shortfall,
    layout: {
      orientation: "down", width, height, nodes, rows, routes, readingOrder: reading,
      junctions: new Map([...junctions].map(([id, { channel: _channel, ...join }]) => [id, join])),
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
