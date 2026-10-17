/**
 * Connector bounds computed from path data, never measured: layouts emit absolute M/L/C paths,
 * whose control points contain the curve (a Bézier lies in its control polygon's hull). The
 * padding covers the arrowhead and stroke, as the DOM measurement it replaces did (12 px).
 */
import type { GridRect } from "../grid-flow";
import { importPathGeometry } from "../routing-plan";

export const ROUTE_BOUNDS_PADDING = 12;

/** The padded control-point bounds of `path`, translated by (dx, dy); null for a path with no point. */
export function routeBounds(path: string, dx = 0, dy = 0, padding = ROUTE_BOUNDS_PADDING): GridRect | null {
  if (!path.trim()) return null;
  const hull = importPathGeometry(path).hull;
  // Preserve the old translate-before-padding arithmetic exactly.
  const left = hull.left + dx, top = hull.top + dy, right = hull.right + dx, bottom = hull.bottom + dy;
  return { x: left - padding, y: top - padding, width: right - left + 2 * padding, height: bottom - top + 2 * padding };
}

/** Keep cosmetic padding inside the pane, without concealing real route overflow. */
export function paneRouteBounds(path: string, paneWidth: number, dx = 0, dy = 0): GridRect | null {
  const raw = routeBounds(path, dx, dy, 0);
  if (!raw) return null;
  const paddedLeft = raw.x - ROUTE_BOUNDS_PADDING, paddedRight = raw.x + raw.width + ROUTE_BOUNDS_PADDING;
  const left = raw.x >= 0 ? Math.max(0, paddedLeft) : paddedLeft;
  const right = raw.x + raw.width <= paneWidth ? Math.min(paneWidth, paddedRight) : paddedRight;
  return { x: left, y: raw.y - ROUTE_BOUNDS_PADDING, width: right - left, height: raw.height + 2 * ROUTE_BOUNDS_PADDING };
}

/** The smallest rectangle containing both (either may be null). */
export function unionRect(a: GridRect | null, b: GridRect | null): GridRect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
