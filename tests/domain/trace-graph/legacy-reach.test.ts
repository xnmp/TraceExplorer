/** Production reach of the legacy repair stages (T23/T24/T25/T28) is measured by
 * profile counters, so a stage can be deleted only once production stops reaching
 * it. These tests pin what each counter means. */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { incrementalBudget, incrementalTree } from '$lib/domain/trace-graph/band-incremental';
import { attachSingleBand } from '$lib/domain/trace-graph/band-geometry';
import { geometryGate } from '$lib/domain/trace-graph/geometry-gate';
import { profileLayout } from '$lib/domain/trace-graph/layout-profile';
import type { GraphLayout, LayoutRequest } from '$lib/domain/trace-graph/layout';
import { decode } from './routing-hint-next-click-codec';

/** A captured corpus click whose legacy insertion needs a free port lane (T24):
 * a retained run occludes a new child's source port. */
const portLane = (): { request: LayoutRequest; previous: GraphLayout } =>
  decode(fs.readFileSync(new URL('./fixtures/routing-adoption/t24-port-lane.json', import.meta.url), 'utf8'));

describe('legacy stage reach counters', () => {
  it('counts a port-lane repair (T24) exactly when the legacy insertion used it, including memo hits', () => {
    const { request, previous } = portLane();
    const first = profileLayout(() => incrementalTree(request, previous, incrementalBudget()));
    expect(first.result).not.toBeNull();
    expect(geometryGate(attachSingleBand(first.result!, request), request.items, request.band!.key, request.maxWidth)).toBeNull();
    expect(first.profile.counters['legacy:T24']).toBe(1);
    expect(first.profile.counters['legacy:T23']).toBeUndefined();
    // An identical later request reuses the memoised insertion; production still reaches T24.
    const again = profileLayout(() => incrementalTree(structuredClone(request), structuredClone(previous), incrementalBudget()));
    expect(again.profile.counters['pinned-cache-hit']).toBe(1);
    expect(again.profile.counters['legacy:T24']).toBe(1);
  });

  it('does not count a stage for an insertion that needs no repair', () => {
    const { request, previous } = portLane();
    // Without the new children there is nothing to insert, so no repair can run.
    const retained = { ...request, items: request.items.filter(n => previous.nodes.has(n.key)) };
    const { profile } = profileLayout(() => incrementalTree(retained, previous, incrementalBudget()));
    expect(Object.keys(profile.counters).filter(k => k.startsWith('legacy:'))).toEqual([]);
  });
});
