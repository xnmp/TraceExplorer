/**
 * When a closing band's retirees vanish (docs/scene-transactions.md §6): a pure helper of the
 * presentation's exit groups. Pure CSS-pixel geometry.
 */
/** Eased progress when a retiring child meets the boundary of reclaimed space. */
export function departureVisibility(fromHeight: number, toHeight: number, childTop: number, shift = 0): number {
  if (![fromHeight, toHeight, childTop, shift].every(Number.isFinite)) return 0;
  if (childTop >= fromHeight) return 0;
  // Normalize before subtracting: finite, extremely large inputs must not
  // overflow into a NaN keyframe offset.
  const scale = Math.max(1, Math.abs(fromHeight), Math.abs(toHeight), Math.abs(childTop), Math.abs(shift));
  const closing = fromHeight / scale - toHeight / scale + shift / scale;
  return closing > 0 ? Math.max(0, Math.min(1, (fromHeight / scale - childTop / scale) / closing)) : 1;
}
