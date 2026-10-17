/** Allocate pinned geometry without applying arrow width to unrelated internal gutters. */
import type { GraphLayout } from './layout';
import { bandExtent } from './band-geometry';
import { segments } from './layout-quality';
import { routeBounds } from './folder-layout/route-bounds';
import { arrowTip } from './route-contacts';
import { ARROW } from './metrics';
import { CONNECTOR_STROKE, JUNCTION_RADIUS, JUNCTION_STROKE_WIDTH } from './connector-ink';

const STROKE_RADIUS = Math.max(...Object.values(CONNECTOR_STROKE)) / 2;

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
  for (const route of layout.routes) {
    const bounds = routeBounds(route.path, 0, 0, STROKE_RADIUS);
    if (!bounds) return null;
    left = Math.min(left, bounds.x);
    right = Math.max(right, bounds.x + bounds.width);
    if (!route.terminal) continue;
    const last = segments(route.path).at(-1), tip = last && arrowTip(last);
    if (!last || !tip) return null;
    const [a, b] = last, length = Math.hypot(b.x - a.x, b.y - a.y);
    const wing = ARROW.width / 2 * Math.abs(b.y - a.y) / length;
    left = Math.min(left, b.x - wing, tip.x);
    right = Math.max(right, b.x + wing, tip.x);
  }
  for (const dot of layout.junctions.values()) {
    const radius = JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2;
    left = Math.min(left, dot.x - radius); right = Math.max(right, dot.x + radius);
  }
  return left >= 0 && right <= layout.width ? { ...tight, left, width: right - left } : null;
}
