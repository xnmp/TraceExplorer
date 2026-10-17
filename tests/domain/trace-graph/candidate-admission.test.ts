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
    const result = optimizedBand(request, {});
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

// Sparse replay of every overflowing final-corpus state against actual main.
// These states exposed regressions hidden by an improved mean overflow.
const mainStateBounds: readonly (readonly [string, number, number, number, number])[] = [
  ["random-tree-200-9003", 640, 48, 0, 0],
  ["random-tree-200-9003", 640, 48, 1, 0],
  ["random-tree-200-9003", 640, 48, 2, 0],
  ["random-tree-200-9003", 640, 48, 3, 0],
  ["random-tree-200-9003", 640, 48, 4, 0],
  ["random-dag-40-7501", 360, 48, 2, 0],
  ["random-dag-40-7501", 360, 48, 3, 0],
  ["random-dag-40-7503", 454, 128, 0, 1],
  ["random-dag-40-7503", 454, 128, 1, 1],
  ["random-dag-40-7503", 454, 128, 2, 1],
  ["random-dag-40-7503", 454, 128, 3, 1],
  ["random-dag-40-7503", 454, 128, 4, 1],
  ["random-dag-100-8101", 360, 48, 1, 0],
  ["random-dag-100-8101", 454, 128, 3, 0],
  ["random-dag-100-8102", 360, 48, 3, 28],
  ["random-dag-100-8103", 900, 128, 0, 5],
  ["random-dag-100-8103", 900, 128, 1, 5],
  ["random-dag-100-8103", 900, 128, 2, 5],
  ["random-dag-100-8103", 900, 128, 3, 5],
  ["random-dag-100-8103", 900, 128, 4, 5],
  ["random-dag-200-9101", 360, 48, 0, 31],
  ["random-dag-200-9101", 360, 48, 4, 31],
  ["random-dag-200-9101", 900, 48, 1, 17],
  ["random-dag-200-9101", 454, 64, 1, 0],
  ["random-dag-200-9102", 1400, 64, 0, 72],
  ["random-dag-200-9102", 1400, 64, 1, 72],
  ["random-dag-200-9102", 1400, 64, 2, 72],
  ["random-dag-200-9102", 1400, 64, 3, 72],
  ["random-dag-200-9102", 1400, 64, 4, 72],
  ["random-dag-200-9103", 360, 48, 1, 55],
  ["random-dag-200-9103", 454, 64, 1, 0],
  ["random-dag-200-9103", 454, 128, 1, 0],
];
it('does not add overflow beyond main on the smaller-preset and reveal states', () => {
  const fixtures = new Map(corpus().map(fixture => [fixture.id, fixture]));
  const failures: unknown[] = [];
  for (const [id, width, imagePx, step, allowance] of mainStateBounds) {
    const fixture = fixtures.get(id)!, request = requestFor(fixture, fixture.focuses[step], width, imagePx);
    const result = optimizedBand(request, { });
    const overflow = measure(result.placed, request.band!.key, width, request.items).overflow;
    if (overflow > allowance) failures.push({id,width,imagePx,step,allowance,overflow});
  }
  expect(failures).toEqual([]);
}, 30_000);
