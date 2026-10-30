import { describe, expect, it } from 'vitest';
import { clickStabilityCases, summarizeClickStability, type ClickTally } from '../../../layout-eval/click-stability';

const tally = (over: Partial<ClickTally>): ClickTally => ({ anchors: 0, denseAnchors: 0, displacement: 0, transitions: 0, screenAnchors: 0, denseScreenAnchors: 0, byVisit: { new: 0, revisit: 0, newDense: 0, revisitDense: 0 }, ...over });

describe('click-stability sweep totals', () => {
  it('adds counts and averages displacement over all transitions, not per case', () => {
    const summary = summarizeClickStability([
      tally({ anchors: 1, displacement: 30, transitions: 3, byVisit: { new: 1, revisit: 0, newDense: 0, revisitDense: 0 } }),
      tally({ denseAnchors: 2, denseScreenAnchors: 4, screenAnchors: 1, displacement: 10, transitions: 1, byVisit: { new: 0, revisit: 2, newDense: 5, revisitDense: 1 } }),
    ]);
    expect(summary).toEqual({ anchors: 1, denseAnchors: 2, screenAnchors: 1, denseScreenAnchors: 4, displacement: 10, byVisit: { new: 1, revisit: 2, newDense: 5, revisitDense: 1 } });
  });

  it('does not depend on the order cases finish in', () => {
    const a = tally({ anchors: 2, displacement: 5, transitions: 2 }), b = tally({ denseAnchors: 3, displacement: 1, transitions: 4 });
    expect(summarizeClickStability([a, b])).toEqual(summarizeClickStability([b, a]));
  });

  it('enumerates every corpus and dense case at every width, once', () => {
    const ids = clickStabilityCases().map(({ original, width }) => `${original.id}/${width}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(385);
  });
});
