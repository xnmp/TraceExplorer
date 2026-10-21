import { describe, expect, it } from 'vitest';
import { prepayBins, prepayIndependentAdmission } from '$lib/domain/trace-graph/routing-admission-work';
import { chargedNativeTileClearance } from '$lib/domain/trace-graph/native-route-clearance';
import type { GraphLayout } from '$lib/domain/trace-graph/layout';

it('prepays repeated spatial visits for long coincident tracks', () => {
  const entries = Array.from({ length: 256 }, () => ({ minX: 0, maxX: 0, minY: .001, maxY: 48 * 4096 - .001 }));
  let work = 0;
  const result = prepayBins(entries, entries, 48, 0, amount => { work += amount; });
  expect(result.unsupported).toBe(false);
  // Every track can revisit every previous track in every shared cell.
  expect(work).toBeGreaterThanOrEqual(4096 * 256 * 255 / 2);
  expect(result.work).toBe(work);
});

it('withholds an unaffordable membership grid and preserves caller exceptions', () => {
  const entries = Array.from({ length: 256 }, () => ({ minX: 0, maxX: 0, minY: 0, maxY: 48 * 4095 }));
  const before = structuredClone(entries), exhausted = new Error('admission ledger');
  let remaining = 2000;
  expect(() => prepayBins(entries, entries, 48, 0, amount => {
    if (amount > remaining) throw exhausted;
    remaining -= amount;
  })).toThrow(exhausted);
  expect(entries).toEqual(before);
  expect(remaining).toBeGreaterThanOrEqual(0);
  expect(prepayBins([{ minX: Infinity, maxX: Infinity, minY: 0, maxY: 0 }], [], 48, 0, () => {}).unsupported).toBe(true);
});

it('checks native tile excursions without admitting the control hull as ink', () => {
  const layout = (y: number): GraphLayout => ({ orientation: 'down', width: 100, height: 100,
    nodes: new Map([['obstacle', { key: 'obstacle', x: 39.5, y, width: 1, height: 1, row: 0, band: 0 }]]),
    junctions: new Map(), rows: [], readingOrder: new Map(), routes: [{ id: 'arch', from: { kind: 'node', id: 'source' },
      to: { kind: 'node', id: 'target' }, terminal: false, consumers: [], path: 'M20 0 C20 100 60 100 60 0' }] });
  expect(chargedNativeTileClearance(layout(74.5), () => {})).toEqual({ ok: false, failure: 'route-through-tile' });
  expect(chargedNativeTileClearance(layout(20), () => {}).ok).toBe(true);
  const exhausted = new Error('native admission ledger');
  expect(() => chargedNativeTileClearance(layout(20), () => { throw exhausted; })).toThrow(exhausted);
});

describe('independent admission prepay', () => {
  const lanes = (count: number, gap: number, length = 400): GraphLayout => ({ orientation: 'down', width: 2000, height: 2000,
    nodes: new Map(), junctions: new Map(), rows: [], readingOrder: new Map(),
    routes: Array.from({ length: count }, (_, i) => ({ id: `r${i}`, from: { kind: 'node', id: `s${i}` }, to: { kind: 'node', id: `t${i}` },
      terminal: false, consumers: [], path: `M0 ${10 + i * gap} L${length} ${10 + i * gap}` })) } as unknown as GraphLayout);
  const prepaid = (layout: GraphLayout) => {
    let work = 0;
    expect(prepayIndependentAdmission(layout, [], 0, amount => { work += amount; })).toBe(true);
    return work;
  };
  // The gate's near-lane pass compares runs within one lane separation of each
  // other: a dense bundle of different sources is quadratic, spread lanes are not.
  it('pays quadratically for a dense bundle of near lanes', () => {
    expect(prepaid(lanes(300, .01))).toBeGreaterThan(300 * 300);
  });
  it('pays for spread lanes by locality, not by every pair', () => {
    const spread = prepaid(lanes(300, 50)), bundle = prepaid(lanes(300, .01));
    expect(spread).toBeLessThan(bundle / 4);
  });
  // Collinear overlaps of different sources become shared-lane keys the crossing
  // pass sorts; one coincident lane makes every pair one.
  it('pays for sorting every shared-lane pair of coincident routes', () => {
    expect(prepaid(lanes(300, 0))).toBeGreaterThan(300 * 299 / 2 * Math.log2(300 * 299 / 2));
  });
  // Below 256 segments the crossing pass may sweep all of them pairwise.
  it('always pays for the small crossing sweep', () => {
    expect(prepaid(lanes(200, 50))).toBeGreaterThan(200 * 199 / 2);
  });
});
