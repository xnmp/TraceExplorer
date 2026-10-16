import { expect, it } from 'vitest';
import { clickStability } from '../../../layout-eval/click-stability';
it('keeps legal corpus clicks at least as stable as main without click-time history', () => {
  const result=clickStability();
  expect.soft(result.anchors).toBeLessThanOrEqual(32);
  expect.soft(result.denseAnchors).toBeLessThanOrEqual(101);
  expect.soft(result.displacement).toBeLessThanOrEqual(17.5);
}, 300_000);
