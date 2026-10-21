import { describe, expect, it } from 'vitest';
import { IntervalIndex } from '$lib/domain/trace-graph/interval-index';

const free = () => {};
const meets = ([a, b]: readonly [number, number], lo: number, hi: number) => a <= hi && b >= lo;

describe('interval index', () => {
  it('returns every meeting interval, ascending, and nothing provably disjoint', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const spans = Array.from({ length: 400 }, () => {
      const a = rand() * 4000 - 500, length = rand() < 0.1 ? rand() * 30000 : rand() * 200;
      return [a, a + length] as const;
    });
    spans.push([5, 5], [-64, -64], [64, 64]);
    const index = new IntervalIndex(spans, 64, free);
    for (let q = 0; q < 300; q++) {
      const lo = rand() * 5000 - 800, hi = lo + (rand() < 0.1 ? rand() * 40000 : rand() * 300);
      const got = index.query(lo, hi, free);
      expect(got).toEqual([...got].sort((a, b) => a - b));
      expect(new Set(got).size).toBe(got.length);
      const expected = spans.flatMap((s, i) => meets(s, lo, hi) ? [i] : []);
      for (const i of expected) expect(got).toContain(i);
    }
    // Closed ends: touching counts; a point query on a point interval meets it.
    expect(index.query(64, 64, free)).toContain(spans.length - 1);
    expect(index.query(-64, -64, free)).toContain(spans.length - 2);
  });

  it('never drops an interval it cannot file, and scans for a query it cannot bound', () => {
    const spans = [[0, 10], [NaN, 5], [0, Infinity], [1e300, 1e300 + 1]] as const;
    const index = new IntervalIndex(spans, 64, free);
    expect(index.query(100, 200, free)).toEqual([1, 2, 3]);
    expect(index.query(NaN, 5, free)).toEqual([0, 1, 2, 3]);
    expect(index.query(0, Infinity, free)).toEqual([0, 1, 2, 3]);
  });

  it('pays for the cells it reaches, not for the whole set', () => {
    const spans = Array.from({ length: 2000 }, (_, i) => [i * 100, i * 100 + 50] as const);
    let built = 0, queried = 0;
    const index = new IntervalIndex(spans, 64, work => { built += work; });
    expect(index.query(1000, 1100, work => { queried += work; })).toEqual([10, 11]);
    expect(built).toBeGreaterThanOrEqual(spans.length);
    expect(queried).toBeLessThan(50);
  });

  it('handles an empty set', () => {
    expect(new IntervalIndex([], 64, free).query(0, 10, free)).toEqual([]);
  });
});
