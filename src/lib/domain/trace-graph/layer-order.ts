/**
 * Crossing reduction for a layered DAG: the iterated layer sweep of Gansner, Koutsofios, North and
 * Vo (1993, "A Technique for Drawing Directed Graphs", §3): long edges are split by virtual nodes
 * so every edge joins adjacent layers; each sweep reorders a layer by the weighted median of its
 * neighbours in the layer just fixed, then `transpose` swaps adjacent nodes while that lowers the
 * crossings with both neighbouring layers; the best order seen is kept. Layer 0 is fixed (the
 * cover's generation keeps its pinned and creation order). Pure and deterministic; no geometry.
 *
 * The count minimised is the standard one: two edges between the same pair of adjacent layers,
 * with no endpoint in common, cross when their ends are in opposite orders.
 */

export interface LayerInput {
  /** Real nodes per layer in their initial order; layer 0 is kept as given. */
  readonly layers: readonly (readonly string[])[];
  /** Parents of each real node (any earlier layer); unknown keys are ignored. */
  readonly parents: (key: string) => readonly string[];
  /** Tie order between nodes with equal medians (lower first). */
  readonly rank: (key: string) => number;
}

const MAX_ITERATIONS = 24;
/** Sweeps without improvement before stopping (dot stops after a few non-improving passes). */
const PATIENCE = 4;
/** Transpose passes per sweep, a bound against slowly converging large layers. */
const TRANSPOSE_PASSES = 8;

interface Proper {
  /** Element ids per layer: real keys, then virtual nodes `\u0000p\u0000c\u0000L`. */
  readonly layers: string[][];
  readonly up: Map<string, string[]>;
  readonly down: Map<string, string[]>;
  /** Tie rank of every element: its own (real) or its edge's child's (virtual). */
  readonly rank: Map<string, number>;
}

function proper(input: LayerInput): Proper {
  const layerOf = new Map<string, number>();
  input.layers.forEach((layer, l) => layer.forEach(key => layerOf.set(key, l)));
  const layers = input.layers.map(layer => [...layer]);
  const up = new Map<string, string[]>(), down = new Map<string, string[]>(), rank = new Map<string, number>();
  const link = (a: string, b: string) => { (down.get(a) ?? down.set(a, []).get(a)!).push(b); (up.get(b) ?? up.set(b, []).get(b)!).push(a); };
  for (const layer of input.layers) for (const key of layer) { rank.set(key, input.rank(key)); up.set(key, up.get(key) ?? []); down.set(key, down.get(key) ?? []); }
  for (let l = 1; l < input.layers.length; l++) for (const child of input.layers[l]) {
    const seen = new Set<string>();
    for (const parent of input.parents(child)) {
      const from = layerOf.get(parent);
      if (from === undefined || from >= l || seen.has(parent)) continue;
      seen.add(parent);
      let previous = parent;
      for (let k = from + 1; k < l; k++) {
        const id = `\u0000${parent}\u0000${child}\u0000${k}`;
        layers[k].push(id); rank.set(id, input.rank(child)); up.set(id, []); down.set(id, []);
        link(previous, id); previous = id;
      }
      link(previous, child);
    }
  }
  return { layers, up, down, rank };
}

/** Crossings between consecutive layers `upper` and `lower` (edges from `up` of the lower layer), by inversion counting. */
function between(upper: readonly string[], lower: readonly string[], up: ReadonlyMap<string, readonly string[]>, pos: ReadonlyMap<string, number>): number {
  const ends: number[] = [];
  for (const v of lower) {
    const tops = (up.get(v) ?? []).map(u => pos.get(u)!).sort((a, b) => a - b);
    for (const t of tops) ends.push(t);
  }
  // Edges are listed by lower position, then upper: crossings are strict inversions of the upper ends.
  return inversions(ends);
}

function inversions(values: number[]): number {
  if (values.length < 2) return 0;
  const buffer = new Array<number>(values.length);
  let count = 0;
  const sort = (lo: number, hi: number) => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid); sort(mid, hi);
    let i = lo, j = mid, k = lo;
    while (i < mid && j < hi) {
      if (values[i] <= values[j]) buffer[k++] = values[i++];
      else { buffer[k++] = values[j++]; count += mid - i; }
    }
    while (i < mid) buffer[k++] = values[i++];
    while (j < hi) buffer[k++] = values[j++];
    for (let t = lo; t < hi; t++) values[t] = buffer[t];
  };
  sort(0, values.length);
  return count;
}

function total(g: Proper, pos: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (let l = 1; l < g.layers.length; l++) sum += between(g.layers[l - 1], g.layers[l], g.up, pos);
  return sum;
}

/** Gansner et al.'s weighted median of sorted neighbour positions; -1 without neighbours. */
function median(positions: number[]): number {
  const n = positions.length;
  if (!n) return -1;
  positions.sort((a, b) => a - b);
  const m = n >> 1;
  if (n % 2) return positions[m];
  if (n === 2) return (positions[0] + positions[1]) / 2;
  const left = positions[m - 1] - positions[0], right = positions[n - 1] - positions[m];
  return left + right === 0 ? (positions[m - 1] + positions[m]) / 2 : (positions[m - 1] * right + positions[m] * left) / (left + right);
}

function reorder(layer: string[], neighbours: ReadonlyMap<string, readonly string[]>, pos: Map<string, number>, rank: ReadonlyMap<string, number>): void {
  const values = new Map(layer.map(v => [v, median((neighbours.get(v) ?? []).map(u => pos.get(u)!))]));
  // Nodes without neighbours keep their slots; the others are sorted into the remaining ones.
  const movable = layer.filter(v => values.get(v)! >= 0).sort((a, b) => values.get(a)! - values.get(b)! || pos.get(a)! - pos.get(b)! || rank.get(a)! - rank.get(b)!);
  let next = 0;
  for (let i = 0; i < layer.length; i++) if (values.get(layer[i])! >= 0) layer[i] = movable[next++];
  layer.forEach((v, i) => pos.set(v, i));
}

/** Crossings among the edges of `v` and `w` (in that order) towards one neighbouring layer. */
function pairCrossings(v: string, w: string, neighbours: ReadonlyMap<string, readonly string[]>, pos: ReadonlyMap<string, number>): number {
  const a = neighbours.get(v) ?? [], b = neighbours.get(w) ?? [];
  let count = 0;
  for (const x of a) { const px = pos.get(x)!; for (const y of b) if (pos.get(y)! < px) count++; }
  return count;
}

function transpose(g: Proper, pos: Map<string, number>): void {
  for (let pass = 0, improved = true; improved && pass < TRANSPOSE_PASSES; pass++) {
    improved = false;
    for (let l = 1; l < g.layers.length; l++) {
      const layer = g.layers[l];
      for (let i = 0; i + 1 < layer.length; i++) {
        const v = layer[i], w = layer[i + 1];
        const keep = pairCrossings(v, w, g.up, pos) + pairCrossings(v, w, g.down, pos);
        const swap = pairCrossings(w, v, g.up, pos) + pairCrossings(w, v, g.down, pos);
        if (swap < keep) { layer[i] = w; layer[i + 1] = v; pos.set(w, i); pos.set(v, i + 1); improved = true; }
      }
    }
  }
}

/**
 * Real nodes per layer, reordered to reduce crossings. Layer 0 is returned as given; a layer's
 * initial order is the barycenter of its upper neighbours (ties by `rank`), the usual start.
 */
export function orderLayers(input: LayerInput): string[][] {
  const g = proper(input);
  const pos = new Map<string, number>();
  g.layers[0].forEach((v, i) => pos.set(v, i));
  for (let l = 1; l < g.layers.length; l++) {
    const layer = g.layers[l];
    const bary = new Map(layer.map(v => { const ps = (g.up.get(v) ?? []).map(u => pos.get(u)!); return [v, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : -1] as const; }));
    layer.sort((a, b) => bary.get(a)! - bary.get(b)! || g.rank.get(a)! - g.rank.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    layer.forEach((v, i) => pos.set(v, i));
  }
  const snapshot = () => g.layers.map(layer => [...layer]);
  let best = snapshot(), bestCount = total(g, pos), stale = 0;
  for (let iteration = 0; iteration < MAX_ITERATIONS && bestCount > 0 && stale < PATIENCE; iteration++) {
    if (iteration % 2 === 0) for (let l = 1; l < g.layers.length; l++) reorder(g.layers[l], g.up, pos, g.rank);
    else for (let l = g.layers.length - 2; l >= 1; l--) reorder(g.layers[l], g.down, pos, g.rank);
    transpose(g, pos);
    const count = total(g, pos);
    if (count < bestCount) { best = snapshot(); bestCount = count; stale = 0; } else stale++;
  }
  return best.map(layer => layer.filter(v => !v.startsWith("\u0000")));
}
