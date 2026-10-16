import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';

// Replayed origin/main 25d7392 with the same requests: these are its only
// overflows in this sample. The task permits existing main overflow, not new excess.
const mainOverflow = new Map([['random-dag-100-8103/640',6], ['random-dag-200-9102/360',235], ['random-dag-200-9102/640',186]]);
it('admits normal candidates within the pane or the measured main allowance across a corpus sample', () => {
  const failures: unknown[] = [], overflows: unknown[] = [];
  let states = 0, fallbacks = 0;
  for (const fixture of corpus()) for (const width of [360, 640]) {
    const request = requestFor(fixture, fixture.focuses.at(-1) ?? null, width, 96);
    const result = optimizedBand(request, {historyPolicy:'arrival-only'});
    states++;
    if (result.layout.decision?.fallback === 'geometry-fallback') fallbacks++;
    const gate = geometryGate(result.placed, request.items, request.band!.key, width);
    if (gate) failures.push([fixture.id,width,gate]);
    const metrics = measure(result.placed, request.band!.key, width, request.items);
    if (metrics.overflow > (mainOverflow.get(`${fixture.id}/${width}`) ?? 0)) overflows.push([fixture.id,width,metrics.overflow]);
  }
  expect(failures).toEqual([]);
  expect(overflows).toEqual([]);
  expect(fallbacks / states).toBeLessThanOrEqual(.005);
}, 30_000);
