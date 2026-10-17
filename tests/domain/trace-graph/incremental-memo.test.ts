import { expect, it } from 'vitest';
import { node, requestFor } from '../../../layout-eval/corpus';
import { layoutGraph } from '../../../src/lib/domain/trace-graph/layout';
import { attachSingleBand } from '../../../src/lib/domain/trace-graph/band-geometry';
import { incrementalTree, incrementalBudget } from '../../../src/lib/domain/trace-graph/band-incremental';
import { profileLayout } from '../../../src/lib/domain/trace-graph/layout-profile';

it('reuses identical insertion work across transports while charging the same shared budget', () => {
  const fixture = { id:'memo-insertion',nodes:[node('root'),node('memo-a',['root'],1),node('memo-b',['memo-a'],2)],focuses:[null] };
  const before=requestFor(fixture,null,641,96), request=requestFor(fixture,'memo-a',641,96);
  const previous=attachSingleBand(layoutGraph(before),before);
  const budget=incrementalBudget();
  const first=profileLayout(()=>incrementalTree(request,previous,budget));
  const otherBudget=incrementalBudget();
  const second=profileLayout(()=>incrementalTree(structuredClone(request),structuredClone(previous),otherBudget));
  expect(first.result).not.toBeNull();
  expect(second.result).toEqual(first.result);
  expect(otherBudget).toEqual(budget);
  expect(first.profile.counters['pinned-search']).toBe(1);
  expect(second.profile.counters['pinned-search']??0).toBe(0);
  // A consumer cannot poison the cached drawing by modifying a returned Map or route.
  (first.result!.nodes as Map<string,unknown>).clear();
  expect(incrementalTree(request,previous)?.nodes.size).toBe(3);
  const changed={...request,maxWidth:642};
  expect(profileLayout(()=>incrementalTree(changed,previous)).profile.counters['pinned-search']).toBe(1);
});

it('preserves cover validity independently of the insertion cache call order', () => {
  const fixture = { id: 'memo-cover-validity', nodes: [node('root'), node('validity-a', ['root'], 1), node('validity-b', ['validity-a'], 2)], focuses: [null] };
  for (const invalidFirst of [false, true]) {
    const width = invalidFirst ? 645 : 644;
    const before = requestFor(fixture, null, width, 96), request = requestFor(fixture, 'validity-a', width, 96);
    const previous = attachSingleBand(layoutGraph(before), before);
    const invalid = { ...previous, pinnedViolation: 'not-a-root' as const };
    for (const source of invalidFirst ? [invalid, previous] : [previous, invalid]) {
      const result = incrementalTree(request, source);
      expect(result).not.toBeNull();
      expect(result?.pinnedViolation).toBe(source.pinnedViolation);
    }
  }
});
