import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph } from '$lib/domain/trace-graph/layout';
import { attachSingleBand, bandExtent } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
it('fits the near-four-column chainy case without an unexplained height regression', () => {
  const fixture = corpus().find(c => c.id === 'random-chainy-200-9303')!;
  const request = requestFor(fixture,null,454,48), raw=layoutGraph(request), placed=attachSingleBand(raw,request);
  expect(geometryGate(placed,request.items,request.band!.key,454)).toBeNull();
  expect(placed.width).toBeLessThanOrEqual(454);
  expect(bandExtent(placed,request.band!.key).height).toBeLessThanOrEqual(9531.5);
});
