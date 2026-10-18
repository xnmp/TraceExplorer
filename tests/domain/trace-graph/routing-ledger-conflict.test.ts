import { expect, it } from 'vitest';
import { corpus, requestFor } from '../../../layout-eval/corpus';
import { optimizedBand, type Optimized } from '../../../layout-eval/engine';
import { geometryGate } from '../../../src/lib/domain/trace-graph/geometry-gate';
import { importCommittedRouting, routingCoordinate } from '../../../src/lib/domain/trace-graph/routing-problem';
import { solveRoutingComponents } from '../../../src/lib/domain/trace-graph/routing-components';

it('reports the reproduced legacy ledger contradiction as an equality conflict', () => {
  const fixture = { ...corpus().find(c => c.id === 'random-tree-12-7122')!, full: false };
  let previous: Optimized | undefined;
  for (const focus of [null, 'n1', 'n3', 'n1', 'n4', 'n3', 'n4']) {
    const request = requestFor(fixture, focus, 454, 96);
    const next = optimizedBand({ ...request, hint: previous?.layout.readingOrder }, { previous, anchorKey: focus ?? undefined });
    expect(geometryGate(next.placed, request.items, request.band!.key, 454)).toBeNull();
    if (next.revisited && focus === 'n4') {
      expect(previous!.placed.nodes.get('n4')!.y).toBe(321);
      expect(next.placed.nodes.get('n4')!.y).toBe(312);
      const imported = importCommittedRouting([{ id: 'committed', space: 'attached', drawing: previous!.placed }]);
      expect(imported.ok).toBe(true);
      if (!imported.ok) throw new Error(JSON.stringify(imported.conflict));
      const id = routingCoordinate('committed', 'tile', 'n4', 'y');
      const result = solveRoutingComponents({ ...imported.problem.metric, equalities: [{ id: 'saved-revisit:n4.y', variable: id, value: next.placed.nodes.get('n4')!.y }] });
      expect(result).toEqual({ ok: false, conflict: { kind: 'equality', variable: id, constraints: [id + ':pin', 'saved-revisit:n4.y'] } });
      expect(previous!.placed.nodes.get('n4')!.y).toBe(321);
      return;
    }
    previous = next;
  }
  throw new Error('the legacy contradictory revisit was not exercised');
});
