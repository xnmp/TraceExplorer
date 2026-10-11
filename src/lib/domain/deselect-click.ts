export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/** Allow small pointer jitter, but never treat a drag as an empty-space click. */
export const DESELECT_CLICK_DISTANCE = 5;

export function isDeselectClick(down: PointerPosition | null, up: PointerPosition, emptyTarget: boolean): boolean {
  if (!down || !emptyTarget || ![down.x, down.y, up.x, up.y].every(Number.isFinite)) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) <= DESELECT_CLICK_DISTANCE;
}
