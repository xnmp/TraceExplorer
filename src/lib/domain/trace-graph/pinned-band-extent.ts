/** Allocate pinned geometry without applying arrow width to unrelated internal gutters. */
import type { GraphLayout } from './layout';
import { bandExtent } from './band-geometry';
import { ARROW } from './metrics';
import { importPaintedCorridors, RoutingImportError } from './routing-plan';

/** Existing comfortable allocations are unchanged. At a tight pane edge, reserve
 * each painted primitive's actual width instead of a global arrow half-width.
 * Native cubic control hulls conservatively include the complete curve. */
export function pinnedBandExtent(layout: GraphLayout, cover: string): ReturnType<typeof bandExtent> | null {
  const unallocated = { ...layout, bandBounds: undefined }, raw = bandExtent(unallocated, cover, 0);
  const available = Math.min(8, raw.left, layout.width - raw.left - raw.width);
  const comfortable = bandExtent(unallocated, cover, Math.max(ARROW.width / 2, available));
  if (comfortable.left >= 0 && comfortable.left + comfortable.width <= layout.width) return comfortable;
  const tight = bandExtent(unallocated, cover, Math.max(0, available));
  let left = tight.left, right = tight.left + tight.width;
  let plan;
  try { plan = importPaintedCorridors(layout); }
  catch (error) { if (error instanceof RoutingImportError) return null; throw error; }
  for (const { ink } of plan) {
    left = Math.min(left, ink.left); right = Math.max(right, ink.right);
  }
  return left >= 0 && right <= layout.width ? { ...tight, left, width: right - left } : null;
}
