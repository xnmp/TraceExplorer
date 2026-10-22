import { expect, it } from 'vitest';
import { clickStability, packingAnchorMoves, unexplainedHeightRegressions } from '../../../layout-eval/click-stability';
// This sweeps every dense worker case at the enlarged construction budget.
// Request latency is gated separately by layout:eval's isolated timing sample.
it('keeps legal corpus clicks at least as stable as main using committed click history', () => {
  const result=clickStability();
  expect.soft(result.anchors + packingAnchorMoves()).toBeLessThanOrEqual(32);
  expect.soft(result.denseAnchors).toBeLessThanOrEqual(101);
  expect.soft(result.screenAnchors).toBeLessThanOrEqual(82);
  expect.soft(result.denseScreenAnchors).toBeLessThanOrEqual(114);
  expect.soft(result.displacement).toBeLessThanOrEqual(17.53);
  // About 31 min alone with the 256M band allowance and the 512M anchor
  // escalation (2026-10); ~30% headroom.
}, 2_450_000);

it('explains every corpus height regression over ten percent with actual retained stability', () => {
  expect(unexplainedHeightRegressions()).toEqual([]);
  // A whole-corpus sweep: CI runners took 260-285 s before the constrained attempt and 310-330 s with it.
}, 600_000);
