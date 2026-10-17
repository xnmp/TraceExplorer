import { expect, it } from 'vitest';
import { requestFor, screenshot } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { measure } from '$lib/domain/trace-graph/layout-quality';

it('keeps retained tiles pinned in the compact bounded expansion candidate', () => {
  const before = optimizedBand(requestFor(screenshot, null, 360, 48));
  const request = requestFor(screenshot, 'Saffron', 360, 48);
  const after = optimizedBand(request, { previous: before, anchorKey: 'Saffron' });
  const metrics = measure(after.placed, 'root', 360, request.items, before.placed);
  expect(metrics.overflow).toBe(0);
  expect(metrics.maxDisplacement).toBe(0);
  expect(metrics.height).toBeLessThanOrEqual(264); // Includes the free junction-end berth.
});
