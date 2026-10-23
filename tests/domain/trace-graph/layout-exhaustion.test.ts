import { describe, expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';
import { layoutBand, ladderPins } from '$lib/domain/trace-graph/band-layout';
import { gridRowsAttempt, serialRowsAttempt } from '$lib/domain/trace-graph/cold-embeddings';
import { exhaustionReason, conflictReason, LayoutExhaustedError, type AttemptOutcome } from '$lib/domain/trace-graph/layout-exhaustion';
import { profileLayout } from '$lib/domain/trace-graph/layout-profile';
import type { GraphLayout, LayoutItem, LayoutRequest } from '$lib/domain/trace-graph/layout';

const outcome = (attempt: GraphLayout | AttemptOutcome): AttemptOutcome => {
  if (typeof attempt !== 'string') throw new Error('expected a failed attempt, got a drawing');
  return attempt;
};
const tile = (key: string, order: number, parents: string[], size: number): LayoutItem => ({ key, order, width: size, height: size, parents });

describe('exhaustion reason', () => {
  it('names the furthest stage any attempt reached', () => {
    expect(exhaustionReason(['not-applicable', 'topology', 'gate-rejected', 'search-exhausted'])).toBe('budget-exhaustion');
    expect(exhaustionReason(['not-applicable', 'topology', 'metric'])).toBe('metric-conflict');
    expect(exhaustionReason(['pinned-skip', 'gate-rejected'])).toBe('metric-conflict');
    expect(exhaustionReason(['not-applicable', 'pins-lost'])).toBe('topology-conflict');
    expect(exhaustionReason(['pinned-skip', 'topology'])).toBe('topology-conflict');
    expect(exhaustionReason(['not-applicable', 'pinned-skip', 'invalid'])).toBe('unsupported-input');
    expect(exhaustionReason([])).toBe('unsupported-input');
  });

  it('maps a corridor conflict as the incremental solve does', () => {
    expect(conflictReason('search-exhausted')).toBe('budget-exhaustion');
    expect(conflictReason('metric')).toBe('metric-conflict');
    expect(conflictReason('topology')).toBe('topology-conflict');
    expect(conflictReason('invalid')).toBe('unsupported-input');
  });

  it('is a RangeError whose message leads with the reason', () => {
    const error = new LayoutExhaustedError('folder', ['gate-rejected'], 'every isolation rung failed');
    expect(error).toBeInstanceOf(RangeError);
    expect(error.reason).toBe('metric-conflict');
    expect(error.message).toBe('No certified folder layout (metric-conflict): every isolation rung failed');
  });
});

describe('representative inputs', () => {
  it('metric conflict: a chain of tiles wider than the pane, with a merge, exhausts the band ladder', () => {
    // Every embedding of the common solve draws it beyond the coordinate reach,
    // the legacy chain does not apply to a merge, and nothing is published.
    const size = 100_000;
    const items = [tile('r', 0, [], size), ...Array.from({ length: 43 }, (_, i) => tile('c' + i, i + 1, [i ? 'c' + (i - 1) : 'r'], size)), tile('x', 60, ['r', 'c5'], size)];
    const request = { items, band: { key: 'r', items }, maxWidth: 900, tileWidth: size };
    let thrown: unknown;
    const { profile } = profileLayout(() => { try { layoutBand(request); } catch (error) { thrown = error; } });
    expect(thrown).toBeInstanceOf(LayoutExhaustedError);
    expect((thrown as LayoutExhaustedError).reason).toBe('metric-conflict');
    expect((thrown as LayoutExhaustedError).outcomes).toContain('gate-rejected');
    expect(profile.counters['exhausted:band:metric-conflict']).toBe(1);
  });

  it('budget exhaustion: a solve given too little work', () => {
    const request = requestFor({ ...corpus().find(c => c.id === 'random-dag-40-7501')!, full: true }, null, 640, 96);
    const spent = outcome(serialRowsAttempt(request, { work: 1_000 }));
    expect(spent).toBe('search-exhausted');
    expect(new LayoutExhaustedError('band', ['gate-rejected', spent]).reason).toBe('budget-exhaustion');
  });

  it('topology conflict: the only drawing moves the clicked tile', () => {
    const fixture = corpus().find(c => c.id === 'screenshot')!;
    const first = optimizedBand(requestFor(fixture, null, 454, 96));
    const request: LayoutRequest = { ...requestFor(fixture, 'Saffron', 454, 96), anchorKey: 'Saffron',
      history: { signature: first.signature, layout: first.layout, placed: first.placed } };
    // Grid rows do not apply; serial rows certify a drawing that moves the clicked tile.
    const outcomes = [gridRowsAttempt(request), serialRowsAttempt(request)].map(attempt =>
      typeof attempt === 'string' ? attempt : ladderPins(request).held(attempt) ? null : 'pins-lost' as const);
    expect(outcomes).toEqual(['not-applicable', 'pins-lost']);
    expect(new LayoutExhaustedError('band', outcomes as AttemptOutcome[]).reason).toBe('topology-conflict');
  });

  it('unsupported input: no construction applies', () => {
    const chain = { items: [tile('a', 0, [], 96), tile('b', 1, ['a'], 96)], maxWidth: 360 } as LayoutRequest;
    const attempts = [outcome(gridRowsAttempt({ ...chain, band: { key: 'a', items: chain.items } })),
      outcome(serialRowsAttempt({ ...chain, band: { key: 'missing', items: chain.items } }))];
    expect(attempts).toEqual(['not-applicable', 'not-applicable']);
    expect(new LayoutExhaustedError('band', attempts).reason).toBe('unsupported-input');
  });
});
