import { expect, it } from 'vitest';
import { clickStability, packingAnchorMoves, unexplainedHeightRegressions } from '../../../layout-eval/click-stability';
it('keeps legal corpus clicks at least as stable as main using committed click history', () => {
  const result=clickStability();
  expect.soft(result.anchors + packingAnchorMoves()).toBeLessThanOrEqual(32);
  expect.soft(result.denseAnchors).toBeLessThanOrEqual(101);
  expect.soft(result.screenAnchors).toBeLessThanOrEqual(82);
  expect.soft(result.denseScreenAnchors).toBeLessThanOrEqual(114);
  expect.soft(result.displacement).toBeLessThanOrEqual(17.53);
}, 300_000);

it('explains every corpus height regression over ten percent with actual retained stability', () => {
  expect(unexplainedHeightRegressions()).toEqual([]);
}, 300_000);
