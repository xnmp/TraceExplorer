/**
 * Crossing-aware passing: which slot (a gap between a display row's tiles, or an outer margin)
 * a long route takes through each row between its ends.
 *
 * The count minimised is the standard layered one, with display rows as layers: a route runs
 * through each channel (the space between two consecutive rows) from where it leaves the row
 * above to where it enters the row below, and two such runs cross when their ends are in
 * opposite orders. Runs of one source never cross (they branch from one trunk), nor do runs that
 * meet at an endpoint they share (a junction's inputs, or a junction's inputs and its outputs).
 * Runs entering one slot side by side are counted as not crossing: their lanes are ordered
 * afterwards by where their routes are heading. A run carrying several parent-child edges (a
 * trunk, or a junction's input or output) counts once per edge, as the layered count does.
 *
 * With every tile fixed, choosing slots is a shortest path per route through the rows it passes
 * (a state is its slot in a row), exact against the other routes held fixed; re-planning each
 * route in turn while that lowers its crossings is rip-up and reroute, the usual way to route
 * many nets one at a time (Nair 1987, "A simple yet effective technique for global wiring").
 * Pure and deterministic; the caller supplies slots, their costs and the other routes' runs.
 * Endpoints are named by numbers (the caller's ids for its endpoint keys), so runs compare fast.
 */

/** No endpoint: the run passes on through the next row. */
export const PASSES_ON = -1;

/** A route's run through one channel: where it enters at the top and where it ends or leaves at the bottom. */
export interface ChannelRun {
  readonly top: number;
  readonly bottom: number;
  /** Its source endpoint's id. */
  readonly source: number;
  /** The id of the endpoint it ends at in this channel (a tile or a junction), or PASSES_ON. */
  readonly end: number;
  /** The parent-child edges it carries (at least 1). */
  readonly weight: number;
}

/** A channel's runs, packed: entry r of each array is run r's. */
export interface ChannelRuns {
  readonly count: number;
  readonly tops: Float64Array;
  readonly bottoms: Float64Array;
  readonly sources: Int32Array;
  readonly ends: Int32Array;
  readonly weights: Float64Array;
}

export function packRuns(runs: readonly ChannelRun[]): ChannelRuns {
  const count = runs.length;
  const packed = { count, tops: new Float64Array(count), bottoms: new Float64Array(count), sources: new Int32Array(count), ends: new Int32Array(count), weights: new Float64Array(count) };
  runs.forEach((run, index) => {
    packed.tops[index] = run.top; packed.bottoms[index] = run.bottom; packed.sources[index] = run.source; packed.ends[index] = run.end; packed.weights[index] = run.weight;
  });
  return packed;
}

/**
 * A place a route may run: `x` orders it against other runs (crossings are counted in that
 * order), `at` is where it runs on the canvas when that differs (an outer margin's lanes are
 * ordered by source, beyond every tile).
 */
export interface PassagePoint { readonly x: number; readonly at?: number }

/**
 * One row a route passes, and the slots it may take there, each with its own cost (in
 * crossings). `weight`: the edges its run carries on from this row into the next channel.
 */
export interface PassageRow {
  readonly options: readonly (PassagePoint & { readonly cost: number })[];
  readonly weight: number;
}

/**
 * The passing part of one source's routes to one end column: they leave `start.x` in channel
 * `start.channel`, pass rows `start.channel + 1` onwards (one entry of `rows` each, consecutive),
 * and each ends in its channel at its x.
 */
export interface Passage {
  readonly source: number;
  /** Where it leaves its source, and the edges its first run carries. */
  readonly start: PassagePoint & { readonly channel: number; readonly weight: number };
  readonly rows: readonly PassageRow[];
  readonly ends: readonly (PassagePoint & { readonly channel: number; readonly end: number; readonly weight: number })[];
}

/**
 * The cost, beyond its crossings, of a run in `channel` from each of `tops` to each of
 * `bottoms` (canvas x's): entry i * bottoms.length + j, or null where every run is free.
 */
export type RunPrice = (channel: number, tops: readonly number[], bottoms: readonly number[]) => Float64Array | null;

/** A choice of option per row, its crossings, and its whole cost. */
export interface PassagePlan { readonly choice: readonly number[]; readonly crossings: number; readonly cost: number }

const canvas = (point: PassagePoint) => point.at ?? point.x;

/** Whether a run of `source` ending at `end` (or PASSES_ON) may cross `run` at all. */
const counts = (run: ChannelRun, source: number, end: number) =>
  run.source !== source && run.end !== source && (end === PASSES_ON || (run.end !== end && run.source !== end));

/** Whether two runs of one channel cross. */
export function runsCross(a: ChannelRun, b: ChannelRun): boolean {
  return counts(b, a.source, a.end) && (a.top - b.top) * (a.bottom - b.bottom) < 0;
}

/** The edges of `runs` a run of `source` from `top` to `bottom`, ending at `end` (or PASSES_ON), crosses. */
function crossings(runs: ChannelRuns, source: number, top: number, bottom: number, end: number): number {
  const { count: size, tops, bottoms, sources, ends, weights } = runs;
  let count = 0;
  for (let r = 0; r < size; r++) {
    const from = sources[r], to = ends[r];
    if (from === source || to === source || (end !== PASSES_ON && (to === end || from === end))) continue;
    if ((tops[r] - top) * (bottoms[r] - bottom) < 0) count += weights[r];
  }
  return count;
}

/** Sorted distinct values. */
function distinct(values: ArrayLike<number>): Float64Array {
  const sorted = Float64Array.from(values).sort();
  let size = 0;
  for (let index = 0; index < sorted.length; index++) if (!size || sorted[index] !== sorted[size - 1]) sorted[size++] = sorted[index];
  return sorted.subarray(0, size);
}

/** Where `value` falls among `sorted`: 2k + 1 at sorted[k], 2k strictly between sorted[k - 1] and sorted[k]. */
function slot(sorted: Float64Array, value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const middle = (low + high) >> 1; if (sorted[middle] < value) low = middle + 1; else high = middle; }
  return low < sorted.length && sorted[low] === value ? 2 * low + 1 : 2 * low;
}

/**
 * The edges of `runs` (those `source`, ending at `end`, may cross) crossed by a run from each of
 * `tops` to each of `bottoms`: entry i * bottoms.length + j for tops[i] to bottoms[j]. One pass
 * over the runs and a prefix sum over where they fall among the queried ends, so a whole row of
 * the plan costs O(runs + tops × bottoms) rather than their product.
 */
export function crossingTable(runs: ChannelRuns, source: number, end: number, tops: readonly number[], bottoms: readonly number[]): Float64Array {
  const top = distinct(tops), bottom = distinct(bottoms);
  const rows = 2 * top.length + 1, columns = 2 * bottom.length + 1, stride = columns + 1;
  // below[a * stride + c]: the weight of runs whose top falls before slot a and bottom before slot c.
  const below = new Float64Array((rows + 1) * stride);
  const { count, tops: runTops, bottoms: runBottoms, sources, ends, weights } = runs;
  for (let r = 0; r < count; r++) {
    const from = sources[r], to = ends[r];
    if (from === source || to === source || (end !== PASSES_ON && (to === end || from === end))) continue;
    below[(slot(top, runTops[r]) + 1) * stride + slot(bottom, runBottoms[r]) + 1] += weights[r];
  }
  for (let a = 1; a <= rows; a++) {
    const here = a * stride, above = here - stride;
    for (let c = 1; c <= columns; c++) below[here + c] += below[above + c] + below[here + c - 1] - below[above + c - 1];
  }
  const table = new Float64Array(tops.length * bottoms.length);
  const columnOf = new Int32Array(bottoms.length);
  for (let j = 0; j < bottoms.length; j++) columnOf[j] = slot(bottom, bottoms[j]);
  for (let i = 0; i < tops.length; i++) {
    const a = slot(top, tops[i]);
    for (let j = 0; j < bottoms.length; j++) {
      const c = columnOf[j];
      // Runs starting left of the top and ending right of the bottom, and the reverse.
      table[i * bottoms.length + j] = below[a * stride + columns] - below[a * stride + c + 1] + below[rows * stride + c] - below[(a + 1) * stride + c];
    }
  }
  return table;
}

/**
 * For each of a channel's runs, the edges of the others it crosses, all at once: runs in order
 * of their tops, each counting the earlier ones ending further right and the later ones ending
 * further left (a Fenwick tree over where they end), less the crossings with the runs it may
 * meet (`counts`), found through its source and end. O(runs log runs) where checking each run
 * against the others would take their square.
 */
export function runCrossings(runs: ChannelRuns): Float64Array {
  const { count, tops, bottoms, sources, ends, weights } = runs;
  const result = new Float64Array(count);
  if (count < 2) return result;
  const byTop = Array.from({ length: count }, (_, index) => index).sort((a, b) => tops[a] - tops[b]);
  const levels = distinct(bottoms);
  const rank = new Int32Array(count);
  for (let r = 0; r < count; r++) rank[r] = slot(levels, bottoms[r]) >> 1;
  const tree = new Float64Array(levels.length + 1);
  const add = (at: number, weight: number) => { for (let i = at + 1; i <= levels.length; i += i & -i) tree[i] += weight; };
  /** Weight of runs added whose bottom ranks below `at`. */
  const below = (at: number) => { let sum = 0; for (let i = at; i > 0; i -= i & -i) sum += tree[i]; return sum; };
  // Earlier tops (strictly), ending strictly right of the run.
  let added = 0;
  for (let start = 0; start < count;) {
    let stop = start;
    while (stop < count && tops[byTop[stop]] === tops[byTop[start]]) stop++;
    for (let k = start; k < stop; k++) { const r = byTop[k]; result[r] += added - below(rank[r] + 1); }
    for (let k = start; k < stop; k++) { const r = byTop[k]; add(rank[r], weights[r]); added += weights[r]; }
    start = stop;
  }
  // Later tops (strictly), ending strictly left of the run.
  tree.fill(0);
  for (let stop = count; stop > 0;) {
    let start = stop;
    while (start > 0 && tops[byTop[start - 1]] === tops[byTop[stop - 1]]) start--;
    for (let k = start; k < stop; k++) { const r = byTop[k]; result[r] += below(rank[r]); }
    for (let k = start; k < stop; k++) { const r = byTop[k]; add(rank[r], weights[r]); }
    stop = start;
  }
  // Pairs that may meet do not cross: subtract them, through each run's source and end.
  const bySource = new Map<number, number[]>(), byEnd = new Map<number, number[]>();
  for (let r = 0; r < count; r++) {
    const from = bySource.get(sources[r]); if (from) from.push(r); else bySource.set(sources[r], [r]);
    if (ends[r] === PASSES_ON) continue;
    const to = byEnd.get(ends[r]); if (to) to.push(r); else byEnd.set(ends[r], [r]);
  }
  const seen = new Int32Array(count).fill(-1);
  for (let r = 0; r < count; r++) {
    const groups = [bySource.get(sources[r]), byEnd.get(sources[r]), ends[r] === PASSES_ON ? undefined : byEnd.get(ends[r]), ends[r] === PASSES_ON ? undefined : bySource.get(ends[r])];
    for (const group of groups) if (group) for (const q of group) {
      if (q === r || seen[q] === r) continue;
      seen[q] = r;
      if ((tops[q] - tops[r]) * (bottoms[q] - bottoms[r]) < 0) result[r] -= weights[q];
    }
  }
  return result;
}

/** The runs of `passage` with option `choice[i]` taken in row i, by channel, with where each runs on the canvas (`from` above, `to` below). */
export function passageRuns(passage: Passage, choice: readonly number[]): { readonly channel: number; readonly run: ChannelRun; readonly from: number; readonly to: number }[] {
  const { source, start, rows, ends } = passage;
  const point = (channel: number): PassagePoint => channel === start.channel ? start : rows[channel - start.channel - 1].options[choice[channel - start.channel - 1]];
  const runs: { channel: number; run: ChannelRun; from: number; to: number }[] = [];
  for (let index = 0; index < rows.length; index++) {
    const channel = start.channel + index, top = point(channel), bottom = point(channel + 1);
    runs.push({ channel, run: { top: top.x, bottom: bottom.x, source, end: PASSES_ON, weight: index ? rows[index - 1].weight : start.weight }, from: canvas(top), to: canvas(bottom) });
  }
  for (const end of ends) {
    const top = point(end.channel);
    runs.push({ channel: end.channel, run: { top: top.x, bottom: end.x, source, end: end.end, weight: end.weight }, from: canvas(top), to: canvas(end) });
  }
  return runs;
}

/** The crossings of `passage`, taking `choice`, with `others` (the runs of each channel; its own source's are ignored), edge by edge. */
export function passageCrossings(passage: Passage, choice: readonly number[], others: (channel: number) => ChannelRuns): number {
  let count = 0;
  for (const { channel, run } of passageRuns(passage, choice)) count += run.weight * crossings(others(channel), passage.source, run.top, run.bottom, run.end);
  return count;
}

/**
 * The cheapest choice of option per row: each crossing with `others` costs 1, each option its
 * own cost, and each run what `price` charges for it. Ties keep the lower option index, row by
 * row from the top. Rows without options make the passage impossible (null). `crossings`
 * counts the crossings alone. `reference`, a choice of its own, is priced alike (`taken`).
 */
export function planPassage(passage: Passage, others: (channel: number) => ChannelRuns, price?: RunPrice, reference?: readonly number[]): (PassagePlan & { readonly taken?: PassagePlan }) | null {
  const { source, start, rows, ends } = passage;
  const endsIn = new Map<number, Passage["ends"][number][]>();
  for (const end of ends) { const list = endsIn.get(end.channel); if (list) list.push(end); else endsIn.set(end.channel, [end]); }
  // States of the row last reached: order x, canvas x, cost so far and crossings so far.
  let xs: number[] = [start.x], ats: number[] = [canvas(start)], costs: number[] = [0], tally: number[] = [0];
  // The reference's state in the row last reached, its cost and crossings.
  let kept = 0, keptCost = 0, keptCount = 0;
  const back: Int32Array[] = [];
  const leave = (channel: number) => {
    // Routes ending in this channel leave it from the state's x.
    const finals = endsIn.get(channel);
    if (!finals) return;
    const runs = others(channel);
    for (const end of finals) {
      const table = crossingTable(runs, source, end.end, xs, [end.x]), extra = price?.(channel, ats, [canvas(end)]);
      if (reference) { const count = end.weight * table[kept]; keptCost += count + (extra ? extra[kept] : 0); keptCount += count; }
      for (let i = 0; i < xs.length; i++) { const count = end.weight * table[i]; costs[i] += count + (extra ? extra[i] : 0); tally[i] += count; }
    }
  };
  for (let index = 0; index < rows.length; index++) {
    const channel = start.channel + index, options = rows[index].options, weight = index ? rows[index - 1].weight : start.weight;
    if (!options.length) return null;
    leave(channel);
    const table = crossingTable(others(channel), source, PASSES_ON, xs, options.map((option) => option.x));
    const extra = price?.(channel, ats, options.map(canvas));
    if (reference) {
      const at = kept * options.length + reference[index], count = weight * table[at];
      keptCost += count + (extra ? extra[at] : 0) + options[reference[index]].cost; keptCount += count; kept = reference[index];
    }
    const nextX: number[] = [], nextAt: number[] = [], nextCost: number[] = [], nextCount: number[] = [], from = new Int32Array(options.length);
    for (let j = 0; j < options.length; j++) {
      let best = Infinity, bestCount = 0, bestFrom = 0;
      for (let i = 0; i < xs.length; i++) {
        if (costs[i] >= best) continue;
        const at = i * options.length + j, count = weight * table[at], value = costs[i] + count + (extra ? extra[at] : 0);
        if (value < best) { best = value; bestCount = tally[i] + count; bestFrom = i; }
      }
      nextX.push(options[j].x); nextAt.push(canvas(options[j])); nextCost.push(best + options[j].cost); nextCount.push(bestCount); from[j] = bestFrom;
    }
    back.push(from);
    xs = nextX; ats = nextAt; costs = nextCost; tally = nextCount;
  }
  leave(start.channel + rows.length);
  let last = 0;
  for (let i = 1; i < costs.length; i++) if (costs[i] < costs[last]) last = i;
  const choice = new Array<number>(rows.length);
  for (let index = rows.length - 1, state = last; index >= 0; index--) { choice[index] = state; state = back[index][state]; }
  return { choice, crossings: tally[last], cost: costs[last], ...(reference ? { taken: { choice: reference, crossings: keptCount, cost: keptCost } } : {}) };
}
