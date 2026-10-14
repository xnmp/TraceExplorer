/** Deterministic rectilinear visibility grid for a blocked incremental source port. */
import type { PlacedNode } from "./layout";
import type { Point } from "./path-sampling";

/**
 * Binary min-heap of A* entries ordered by (priority, cell index), stored in parallel typed arrays.
 * Textbook sift-up / sift-down (moving a hole rather than swapping, which places entries
 * identically), so entries pop in exactly (priority, cell) order.
 */
class EntryHeap {
  size = 0;
  /** Empties the heap, keeping its storage (one heap serves every route search). */
  clear(): void { this.size = 0; }
  /** The entry removed by the last `pop`. */
  topAt = 0;
  topCost = 0;
  private at = new Int32Array(64);
  private cost = new Float64Array(64);
  private priority = new Float64Array(64);

  push(at: number, cost: number, priority: number): void {
    if (this.size === this.at.length) {
      const ats = new Int32Array(this.size * 2), costs = new Float64Array(this.size * 2), priorities = new Float64Array(this.size * 2);
      ats.set(this.at); costs.set(this.cost); priorities.set(this.priority);
      this.at = ats; this.cost = costs; this.priority = priorities;
    }
    const ats = this.at, costs = this.cost, priorities = this.priority;
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >>> 1, above = priorities[parent];
      if (!(priority < above || priority === above && at < ats[parent])) break;
      ats[i] = ats[parent]; costs[i] = costs[parent]; priorities[i] = above; i = parent;
    }
    ats[i] = at; costs[i] = cost; priorities[i] = priority;
  }

  /** Removes the minimum into `topAt` / `topCost`; the heap must be non-empty. */
  pop(): void {
    const ats = this.at, costs = this.cost, priorities = this.priority;
    this.topAt = ats[0]; this.topCost = costs[0];
    const size = --this.size;
    if (!size) return;
    const at = ats[size], cost = costs[size], priority = priorities[size];
    let i = 0;
    for (;;) {
      const left = 2 * i + 1, right = left + 1;
      if (left >= size) break;
      const child = right < size && (priorities[right] < priorities[left] || priorities[right] === priorities[left] && ats[right] < ats[left]) ? right : left;
      const below = priorities[child];
      if (!(below < priority || below === priority && ats[child] < at)) break;
      ats[i] = ats[child]; costs[i] = costs[child]; priorities[i] = below; i = child;
    }
    ats[i] = at; costs[i] = cost; priorities[i] = priority;
  }
}

/** Sorts `values[0, length)` ascending (NaN and −0 never enter), drops repeats in place and returns the distinct count. */
function distinctSorted(values: Float64Array, length: number): number {
  // Without NaN or −0, equal values are indistinguishable, so any correct ascending sort
  // gives the typed array sort's result; short runs sort in place without a subarray.
  if (length <= 32) {
    for (let i = 1; i < length; i++) {
      const value = values[i];
      let j = i - 1;
      for (; j >= 0 && values[j] > value; j--) values[j + 1] = values[j];
      values[j + 1] = value;
    }
  } else values.subarray(0, length).sort();
  let n = 0;
  for (let i = 0; i < length; i++) if (!n || values[i] !== values[n - 1]) values[n++] = values[i];
  return n;
}

/** First index whose coordinate is >= value (coordinates are sorted). */
function lowerBound(values: Float64Array, length: number, value: number): number {
  let lo = 0, hi = length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Index of `value` among sorted distinct coordinates, or -1 (NaN is never present). */
function indexOf(values: Float64Array, length: number, value: number): number {
  const i = lowerBound(values, length, value);
  return i < length && values[i] === value ? i : -1;
}

/**
 * Scratch storage shared by every search (searches run one at a time and never re-enter), so
 * small searches allocate nothing. Each search initialises the part it reads, so results never
 * depend on earlier searches. Larger grids get fresh arrays, so little memory stays held.
 */
const POOLED = 4096;
const pool = {
  f64: [new Float64Array(64), new Float64Array(64), new Float64Array(64), new Float64Array(64), new Float64Array(POOLED)],
  u8: [new Uint8Array(POOLED), new Uint8Array(POOLED), new Uint8Array(POOLED)],
  i32: new Int32Array(POOLED),
  heap: new EntryHeap(),
};
/** Float64 scratch array `slot` with at least `length` entries (contents unspecified). */
function f64(slot: number, length: number): Float64Array {
  if (length > POOLED) return new Float64Array(length);
  if (pool.f64[slot].length < length) pool.f64[slot] = new Float64Array(POOLED);
  return pool.f64[slot];
}

/** Shortest Manhattan path outside rectangles; coordinate work is bounded by visible geometry. */
export function orthogonalRoute(start: Point, goal: Point, boxes: readonly PlacedNode[], width: number): readonly Point[] | null {
  const clearance = 2;
  // Grid lines: the distinct candidate coordinates in range, ascending.
  const xs = f64(0, 4 + 2 * boxes.length), ys = f64(1, 2 + 2 * boxes.length);
  let xn = 0, yn = 0;
  const addX = (x: number) => { if (x >= 8 && x <= width - 8) xs[xn++] = x; };
  // Zero is stored as +0, as a Set stores -0 (it can be returned in a point). x lines are >= 8.
  const addY = (y: number) => { if (y >= 0) ys[yn++] = y === 0 ? 0 : y; };
  addX(8); addX(width - 8); addX(start.x); addX(goal.x); addY(start.y); addY(goal.y);
  for (const b of boxes) { addX(b.x - clearance); addX(b.x + b.width + clearance); addY(b.y - clearance); addY(b.y + b.height + clearance); }
  const nx = distinctSorted(xs, xn), ny = distinctSorted(ys, yn), count = nx * ny;
  // Enormous malformed/history requests have an explicit bounded failure, never a timer exit.
  if (!nx || !ny || count > 250_000) return null;
  const sx = indexOf(xs, nx, start.x), sy = indexOf(ys, ny, start.y), gx = indexOf(xs, nx, goal.x), gy = indexOf(ys, ny, goal.y);
  if (sx < 0 || sy < 0 || gx < 0 || gy < 0) return null;
  const small = count <= POOLED;
  const blocked = small ? pool.u8[0] : new Uint8Array(count), horizontal = small ? pool.u8[1] : new Uint8Array(count), vertical = small ? pool.u8[2] : new Uint8Array(count);
  if (small) { blocked.fill(0, 0, count); horizontal.fill(0, 0, count); vertical.fill(0, 0, count); }
  for (const b of boxes) {
    const left = b.x - clearance, right = b.x + b.width + clearance, top = b.y - clearance, bottom = b.y + b.height + clearance;
    // Only grid lines within (or one step outside) the box can be blocked by it.
    const x0 = Math.max(0, lowerBound(xs, nx, left) - 1), x1 = Math.min(nx, lowerBound(xs, nx, right) + 1);
    for (let y = lowerBound(ys, ny, top); y < ny && ys[y] <= bottom; y++) {
      for (let x = x0; x < x1; x++) {
        const at = y * nx + x;
        if (xs[x] > left && xs[x] < right && ys[y] > top && ys[y] < bottom) blocked[at] = 1;
        if (x + 1 < nx && xs[x] < right && xs[x + 1] > left && ys[y] > top && ys[y] < bottom) horizontal[at] = 1;
        if (y + 1 < ny && ys[y] < bottom && ys[y + 1] > top && xs[x] > left && xs[x] < right) vertical[at] = 1;
      }
    }
  }
  const first = sy * nx + sx, last = gy * nx + gx;
  if (blocked[first] || blocked[last]) return null;
  const distances = f64(4, count); distances.fill(Infinity, 0, count); distances[first] = 0;
  const previous = small ? pool.i32 : new Int32Array(count); previous.fill(-1, 0, count);
  // A* heuristic terms per grid line: priority = (cost + |x - goal.x|) + |y - goal.y|.
  const hx = f64(2, nx), hy = f64(3, ny);
  for (let i = 0; i < nx; i++) hx[i] = Math.abs(xs[i] - goal.x);
  for (let i = 0; i < ny; i++) hy[i] = Math.abs(ys[i] - goal.y);
  // A small grid's heap stays small too (at most four pushes per grid point).
  const heap = small ? pool.heap : new EntryHeap();
  heap.clear();
  heap.push(first, 0, 0 + hx[sx] + hy[sy]);
  while (heap.size) {
    heap.pop();
    const at = heap.topAt, cost = heap.topCost;
    if (cost !== distances[at]) continue;
    if (at === last) {
      const points: Point[] = [];
      for (let p = last; p >= 0; p = previous[p]) { const px = p % nx; points.push({ x: xs[px], y: ys[(p - px) / nx] }); }
      return points.reverse().filter((p, i, all) => !i || i === all.length - 1 || !((all[i - 1].x === p.x && p.x === all[i + 1].x) || (all[i - 1].y === p.y && p.y === all[i + 1].y)));
    }
    const x = at % nx, y = (at - x) / nx, cx = xs[x], cy = ys[y];
    // Fixed neighbour order (left, right, up, down): it decides which equal-cost predecessor is kept.
    // A step costs `cost + |dx| + |dy|`, the other axis contributing |c - c| (0, or NaN off a
    // non-finite line), exactly as the general expression evaluates it.
    for (let side = 0; side < 4; side++) {
      let to: number, ax = x, ay = y;
      if (side === 0) { if (x === 0 || horizontal[at - 1]) continue; to = at - 1; ax = x - 1; }
      else if (side === 1) { if (x + 1 >= nx || horizontal[at]) continue; to = at + 1; ax = x + 1; }
      else if (side === 2) { if (y === 0 || vertical[at - nx]) continue; to = at - nx; ay = y - 1; }
      else { if (y + 1 >= ny || vertical[at]) continue; to = at + nx; ay = y + 1; }
      if (blocked[to]) continue;
      const next = cost + Math.abs(xs[ax] - cx) + Math.abs(ys[ay] - cy);
      if (next >= distances[to]) continue;
      distances[to] = next; previous[to] = at; heap.push(to, next, next + hx[ax] + hy[ay]);
    }
  }
  return null;
}
