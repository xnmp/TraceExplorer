import { expect, it } from 'vitest';
import { movementSummary } from '../../../layout-eval/movement-summary';

it('separates exact restores without diluting changed-transition movement with initial states', () => {
  const rows = [
    { changed: false, metrics: { movedFraction: 0, anchorDisplacement: 0 } },
    { changed: true, metrics: { movedFraction: .2, anchorDisplacement: 4 } },
    { changed: true, revisited: true, metrics: { movedFraction: .8, anchorDisplacement: 20 } },
    { changed: false, revisited: true, metrics: { movedFraction: 0, anchorDisplacement: 0 } },
  ];
  expect(movementSummary(rows)).toEqual({
    newStates: { layouts: 2, transitions: 1, mean: { movedFraction: .1, anchorDisplacement: 2 }, changed: { movedFraction: .2, anchorDisplacement: 4 } },
    exactRestores: { layouts: 2, transitions: 1, mean: { movedFraction: .4, anchorDisplacement: 10 }, changed: { movedFraction: .8, anchorDisplacement: 20 } },
  });
});

it('reports absent restore populations as null, not a fabricated zero-movement result', () => {
  const row = { changed: true, metrics: { movedFraction: .25, anchorDisplacement: 2 } };
  const result = movementSummary([row, { changed: true, metrics: null }]);
  expect(result.newStates).toMatchObject({ layouts: 1, transitions: 1, changed: row.metrics });
  expect(result.exactRestores).toEqual({ layouts: 0, transitions: 0, mean: null, changed: null });
});
