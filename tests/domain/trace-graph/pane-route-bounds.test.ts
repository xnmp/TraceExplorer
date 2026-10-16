import { expect, it } from 'vitest';
import { paneRouteBounds } from '$lib/domain/trace-graph/folder-layout/route-bounds';

it('limits cosmetic horizontal route padding to available pane space', () => {
  expect(paneRouteBounds('M0 10 L200 10 L200 30',200)).toEqual({x:0,y:-2,width:200,height:44});
});
it('preserves real out-of-pane route geometry in the reported bounds', () => {
  const bounds=paneRouteBounds('M100 10 L220 10',200)!;
  expect(bounds.x+bounds.width).toBeGreaterThanOrEqual(220);
});
