/** Rects are in viewport pixels; scroll offsets are in the scroller's CSS pixels. */
export function anchorDelta(captured: number, current: number, zoom = 1): number {
  if (![captured, current, zoom].every(Number.isFinite) || zoom <= 0) return 0;
  const movement = current - captured;
  const delta = movement / zoom;
  return Math.abs(movement) < 0.5 || !Number.isFinite(delta) ? 0 : delta;
}

export type AnchorEvent =
  | { type: "wheel" | "touchstart" | "replaced" | "removed" | "unmounted" }
  | { type: "keydown"; key: string }
  | { type: "pointerdown"; scrollbar: boolean }
  | { type: "scroll"; actual: number; expected: number }
  | { type: "adjustment"; actual: number; requested: number }
  | { type: "motion" | "settled" };

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);
const differs = (a: number, b: number) => !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) >= 0.5;

/** Own scroll events and idle motion preserve the anchor; clamped adjustments cannot. */
export function releasesAnchor(event: AnchorEvent): boolean {
  switch (event.type) {
    case "keydown": return SCROLL_KEYS.has(event.key);
    case "pointerdown": return event.scrollbar;
    case "scroll": return differs(event.actual, event.expected);
    case "adjustment": return differs(event.actual, event.requested);
    case "motion": case "settled": return false;
    default: return true;
  }
}
