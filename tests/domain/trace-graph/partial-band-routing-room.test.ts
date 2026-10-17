import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { nodePenalties } from '$lib/domain/trace-graph/layout-quality';

it('keeps later reveals within the established movement bound after opening a partial band', () => {
  const fixture = { ...corpus().find(c => c.id === 'random-dag-100-8102')!, full: false };
  let previous: Optimized | undefined;
  for (const focus of [null, 'n56', 'n60']) {
    const request = requestFor(fixture, focus, 360, 96);
    const next = optimizedBand(request, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, request.band!.key, request.maxWidth)).toBeNull();
    // The established tour measured 657.91 px for the last reveal. Fitting a
    // tighter cold gutter before hidden members appear increased it to 1742.80 px.
    expect(nodePenalties(next.placed, request.band!.key, request.items, previous?.placed, focus ?? undefined).displacement)
      .toBeLessThanOrEqual(658);
    previous = next;
  }
}, 30_000);
