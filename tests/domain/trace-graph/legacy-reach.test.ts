/** Production reach of the legacy repair stages (T23/T25/T28; T24 is deleted) is measured by
 * profile counters, so a stage can be deleted only once production stops reaching
 * it. These tests pin what each counter means. */
import { describe, expect, it } from 'vitest';
import { incrementalBudget, incrementalTree } from '$lib/domain/trace-graph/band-incremental';
import { profileLayout } from '$lib/domain/trace-graph/layout-profile';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand } from '../../../layout-eval/engine';

describe('legacy stage reach counters', () => {
  it('does not count a stage for an arrival that the plain insertion places', () => {
    const fan = corpus().find(f => f.id === 'fan-80')!;
    const band = (n: number) => requestFor({ ...fan, nodes: fan.nodes.slice(0, n), full: false }, null, 400, 48);
    const request = band(8), previous = optimizedBand(band(7), {}).placed;
    expect(request.items.filter(n => !previous.nodes.has(n.key))).toHaveLength(1);
    const { result, profile } = profileLayout(() => incrementalTree(request, previous, incrementalBudget()));
    expect(result).not.toBeNull();
    expect(profile.counters['pinned-search']).toBeGreaterThan(0);
    expect(Object.keys(profile.counters).filter(k => k.startsWith('legacy:'))).toEqual([]);
  });
});
