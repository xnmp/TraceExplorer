/**
 * Where a tooltip goes: centred above its anchor (WinUI's default placement),
 * flipped below when there is no room above, and clamped so it never leaves
 * the bounds. All values share one coordinate space (the caller's viewport
 * rects); the result is the tooltip's top-left corner in that space.
 */

export interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface Size { readonly width: number; readonly height: number }
export type Side = "above" | "below";
export interface Placement { readonly left: number; readonly top: number; readonly side: Side }

export interface PlacementOptions {
  /** Space between anchor and tooltip. */
  readonly gap: number;
  /** Space kept free at the bounds' edges. */
  readonly margin: number;
}

export const PLACEMENT: PlacementOptions = { gap: 6, margin: 8 };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

/** The intersection of two rects, or null when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top), right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

export function placeTooltip(anchor: Rect, size: Size, bounds: Rect, options: PlacementOptions = PLACEMENT): Placement {
  const { gap, margin } = options;
  const width = Math.max(0, size.width), height = Math.max(0, size.height);
  const centre = (anchor.left + anchor.right) / 2;
  const left = clamp(centre - width / 2, bounds.left + margin, bounds.right - margin - width);
  const above = anchor.top - gap - height;
  const below = anchor.bottom + gap;
  const fitsAbove = above >= bounds.top + margin;
  const fitsBelow = below + height <= bounds.bottom - margin;
  // Neither side fits: take the roomier one and keep the tooltip inside, even if it covers the anchor.
  const side: Side = fitsAbove || (!fitsBelow && anchor.top - bounds.top >= bounds.bottom - anchor.bottom) ? "above" : "below";
  const top = clamp(side === "above" ? above : below, bounds.top + margin, bounds.bottom - margin - height);
  return { left, top, side };
}
