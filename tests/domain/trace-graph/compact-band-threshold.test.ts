import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { layoutGraph as baselineLayout, type GraphLayout } from '../../../layout-eval/baseline/layout';
import { attached as baselineAttached } from '../../../layout-eval/baseline/placement';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { measure } from '$lib/domain/trace-graph/layout-quality';

it('fits a near-threshold wrapped column without an unexplained height regression', () => {
  const fixture = corpus().find(c => c.id === 'random-chainy-200-9303')!;
  let previous: Optimized | undefined, baseline: GraphLayout | undefined;
  for (const focus of fixture.focuses) {
    const request = requestFor(fixture, focus, 640, 64, baseline?.readingOrder);
    baseline = baselineLayout(request);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
    const height = (layout: GraphLayout) => measure(layout, request.band!.key, request.maxWidth, request.items).height;
    expect(height(next.placed)).toBeLessThanOrEqual(height(baselineAttached(baseline, request)) * 1.1);
    previous = next;
  }
}, 30_000);
