export interface PointerPosition {
  readonly x: number;
  readonly y: number;
}

/** Allow small pointer jitter, but never treat a drag as an empty-space click. */
export const DESELECT_CLICK_DISTANCE = 5;

function withinClickDistance(down: PointerPosition, up: PointerPosition): boolean {
  if (![down.x, down.y, up.x, up.y].every(Number.isFinite)) return false;
  return Math.hypot(up.x - down.x, up.y - down.y) <= DESELECT_CLICK_DISTANCE;
}

export interface ClientArea { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/**
 * Whether a pointer position is over content rather than a native scrollbar or
 * border. Chromium reports a scrollbar press as a full pointerdown/up/click on
 * the scroller itself, so only the position tells it apart from background.
 */
export function inClientArea(position: PointerPosition, area: ClientArea): boolean {
  return [position.x, position.y].every(Number.isFinite)
    && position.x >= area.left && position.x < area.left + area.width
    && position.y >= area.top && position.y < area.top + area.height;
}

/**
 * The scroller's content box in the pointer's coordinate space. Pointer and
 * rect coordinates are zoomed viewport pixels, while clientLeft/Top/Width/Height
 * are unzoomed CSS pixels, so the latter are scaled by `zoom` (visual px per CSS px).
 */
export function scaledClientArea(origin: PointerPosition, client: ClientArea, zoom: number): ClientArea {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { left: origin.x + client.left * scale, top: origin.y + client.top * scale, width: client.width * scale, height: client.height * scale };
}

export interface DeselectPointer extends PointerPosition {
  readonly id: number;
  readonly button: number;
  readonly primary: boolean;
}

export interface DeselectGesture {
  readonly down: DeselectPointer;
  readonly released: boolean;
}

export type DeselectEvent =
  | { readonly type: "down" | "up"; readonly pointer: DeselectPointer; readonly emptyTarget: boolean }
  | { readonly type: "move"; readonly pointer: DeselectPointer }
  | { readonly type: "click"; readonly position: PointerPosition; readonly button: number; readonly emptyTarget: boolean }
  | { readonly type: "wheel" | "scroll" | "cancel" | "blur" };

/**
 * A release only validates the press. Native scrollbars deliver pointer events
 * without a click, so only the subsequent empty-background click can clear.
 * Movement or scrolling invalidates the whole gesture, even if it returns to
 * its starting position before release.
 */
export function deselectGesture(gesture: DeselectGesture | null, event: DeselectEvent): { gesture: DeselectGesture | null; deselect: boolean } {
  switch (event.type) {
    case "down":
      return {
        gesture: event.emptyTarget && event.pointer.primary && event.pointer.button === 0 && withinClickDistance(event.pointer, event.pointer)
          ? { down: event.pointer, released: false } : null,
        deselect: false,
      };
    case "move":
      return {
        gesture: gesture?.down.id === event.pointer.id && !withinClickDistance(gesture.down, event.pointer) ? null : gesture,
        deselect: false,
      };
    case "up":
      if (!gesture || gesture.down.id !== event.pointer.id) return { gesture, deselect: false };
      return {
        gesture: !gesture.released && event.emptyTarget && event.pointer.button === gesture.down.button && withinClickDistance(gesture.down, event.pointer)
          ? { ...gesture, released: true } : null,
        deselect: false,
      };
    case "click":
      return {
        gesture: null,
        deselect: !!gesture?.released && event.emptyTarget && event.button === gesture.down.button && withinClickDistance(gesture.down, event.position),
      };
    default:
      return { gesture: null, deselect: false };
  }
}
