/** Deterministic rectilinear visibility grid for a blocked incremental source port. */
import type { PlacedNode } from "./layout";
import type { Point } from "./path-sampling";

/** Shortest Manhattan path outside rectangles; coordinate work is bounded by visible geometry. */
export function orthogonalRoute(start: Point, goal: Point, boxes: readonly PlacedNode[], width: number): readonly Point[] | null {
  const clearance = 2;
  const xs = [...new Set([8, width - 8, start.x, goal.x, ...boxes.flatMap(b => [b.x - clearance, b.x + b.width + clearance])])].filter(x => x >= 8 && x <= width - 8).sort((a, b) => a - b);
  const ys = [...new Set([start.y, goal.y, ...boxes.flatMap(b => [b.y - clearance, b.y + b.height + clearance])])].filter(y => y >= 0).sort((a, b) => a - b);
  const nx = xs.length, count = nx * ys.length;
  // Enormous malformed/history requests have an explicit bounded failure, never a timer exit.
  if (!nx || !ys.length || count > 250_000) return null;
  const xIndex = new Map(xs.map((x, i) => [x, i])), yIndex = new Map(ys.map((y, i) => [y, i]));
  const sx = xIndex.get(start.x), sy = yIndex.get(start.y), gx = xIndex.get(goal.x), gy = yIndex.get(goal.y);
  if (sx === undefined || sy === undefined || gx === undefined || gy === undefined) return null;
  const blocked = new Uint8Array(count), horizontal = new Uint8Array(count), vertical = new Uint8Array(count);
  // First index whose coordinate is >= value (coordinates are sorted).
  const lowerBound = (values: readonly number[], value: number) => {
    let lo = 0, hi = values.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (const b of boxes) {
    const left = b.x - clearance, right = b.x + b.width + clearance, top = b.y - clearance, bottom = b.y + b.height + clearance;
    // Only grid lines within (or one step outside) the box can be blocked by it.
    const x0 = Math.max(0, lowerBound(xs, left) - 1), x1 = Math.min(nx, lowerBound(xs, right) + 1);
    for (let y = lowerBound(ys, top); y < ys.length && ys[y] <= bottom; y++) {
      for (let x = x0; x < x1; x++) {
        const at = y * nx + x;
        if (xs[x] > left && xs[x] < right && ys[y] > top && ys[y] < bottom) blocked[at] = 1;
        if (x + 1 < nx && xs[x] < right && xs[x + 1] > left && ys[y] > top && ys[y] < bottom) horizontal[at] = 1;
        if (y + 1 < ys.length && ys[y] < bottom && ys[y + 1] > top && xs[x] > left && xs[x] < right) vertical[at] = 1;
      }
    }
  }
  const first = sy * nx + sx, last = gy * nx + gx;
  if (blocked[first] || blocked[last]) return null;
  const distances = new Float64Array(count); distances.fill(Infinity); distances[first] = 0;
  const previous = new Int32Array(count); previous.fill(-1);
  const heap: { at: number; cost: number; priority: number }[] = [];
  const before = (a: typeof heap[number], b: typeof heap[number]) => a.priority < b.priority || a.priority === b.priority && a.at < b.at;
  const push = (at: number, cost: number) => {
    const p = { at, cost, priority: cost + Math.abs(xs[at % nx] - goal.x) + Math.abs(ys[Math.floor(at / nx)] - goal.y) };
    heap.push(p);
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >>> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent;
    }
  };
  const pop = () => {
    const root = heap[0], tail = heap.pop()!;
    if (heap.length) {
      heap[0] = tail;
      for (let i = 0; ;) {
        const left = 2 * i + 1, right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && before(heap[right], heap[left]) ? right : left;
        if (!before(heap[child], heap[i])) break;
        [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;
      }
    }
    return root;
  };
  push(first, 0);
  while (heap.length) {
    const current = pop();
    if (current.cost !== distances[current.at]) continue;
    if (current.at === last) {
      const points: Point[] = [];
      for (let at = last; at >= 0; at = previous[at]) points.push({ x: xs[at % nx], y: ys[Math.floor(at / nx)] });
      return points.reverse().filter((p, i, all) => !i || i === all.length - 1 || !((all[i - 1].x === p.x && p.x === all[i + 1].x) || (all[i - 1].y === p.y && p.y === all[i + 1].y)));
    }
    const x = current.at % nx, y = Math.floor(current.at / nx);
    const next = [x > 0 && !horizontal[current.at - 1] ? current.at - 1 : -1, x + 1 < nx && !horizontal[current.at] ? current.at + 1 : -1,
      y > 0 && !vertical[current.at - nx] ? current.at - nx : -1, y + 1 < ys.length && !vertical[current.at] ? current.at + nx : -1];
    for (const at of next) {
      if (at < 0 || blocked[at]) continue;
      const cost = current.cost + Math.abs(xs[at % nx] - xs[x]) + Math.abs(ys[Math.floor(at / nx)] - ys[y]);
      if (cost >= distances[at]) continue;
      distances[at] = cost; previous[at] = current.at; push(at, cost);
    }
  }
  return null;
}
