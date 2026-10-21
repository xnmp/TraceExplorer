/** A one-dimensional broad phase over closed intervals [lo, hi], lo <= hi. A query returns, in
 * ascending index order, every interval that meets the query interval, plus every
 * interval that could not be filed (a non-finite or very long span): callers keep
 * their exact test, so the index only skips intervals that are provably disjoint.
 * Ascending order lets a caller visit candidates exactly as a full scan would. */
export type Charge = (work: number, reason?: string) => void;

/** Cells spanned beyond which an interval (or a query) falls back to a scan. */
const MAX_CELLS = 256;

export class IntervalIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly wide: number[] = [];
  private readonly seen: Uint32Array;
  private stamp = 0;

  constructor(private readonly intervals: readonly (readonly [number, number])[], private readonly size: number, charge: Charge) {
    this.seen = new Uint32Array(intervals.length);
    for (let i = 0; i < intervals.length; i++) {
      const [lo, hi] = intervals[i];
      const c0 = Math.floor(lo / size), c1 = Math.floor(hi / size);
      if (!Number.isSafeInteger(c0) || !Number.isSafeInteger(c1) || c1 < c0 || c1 - c0 >= MAX_CELLS) {
        charge(1, 'interval index wide');
        this.wide.push(i);
        continue;
      }
      charge(c1 - c0 + 1, 'interval index cells');
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(c);
        if (list) list.push(i); else this.cells.set(c, [i]);
      }
    }
  }

  /** Indices of intervals meeting [lo, hi], and of every unfiled interval, ascending. */
  query(lo: number, hi: number, charge: Charge): number[] {
    const c0 = Math.floor(lo / this.size), c1 = Math.floor(hi / this.size);
    if (!Number.isSafeInteger(c0) || !Number.isSafeInteger(c1) || c1 < c0 || c1 - c0 >= MAX_CELLS) {
      charge(this.intervals.length + 1, 'interval index scan');
      return this.intervals.map((_, i) => i);
    }
    if (++this.stamp === 0xffffffff) { this.seen.fill(0); this.stamp = 1; }
    const out: number[] = [];
    charge(c1 - c0 + 1 + this.wide.length, 'interval index query');
    for (let c = c0; c <= c1; c++) {
      const list = this.cells.get(c);
      if (!list) continue;
      charge(list.length, 'interval index visits');
      for (const i of list) {
        if (this.seen[i] === this.stamp) continue;
        this.seen[i] = this.stamp;
        const [a, b] = this.intervals[i];
        if (a <= hi && b >= lo) out.push(i);
      }
    }
    out.push(...this.wide);
    charge(out.length * (1 + Math.ceil(Math.log2(out.length + 1))), 'interval index order');
    return out.sort((a, b) => a - b);
  }
}
