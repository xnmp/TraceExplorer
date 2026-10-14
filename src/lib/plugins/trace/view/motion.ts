/**
 * View motion helpers shared by the Trace view: zoom measurement, the reduced-motion preference,
 * and scroll anchoring (`holdAnchor`) through a presentation's motion. Presentation motion itself
 * is modelled in `presentation.ts` and driven natively by `scene-motion.ts`; whether it is active
 * is the scene controller's to say (`SceneController.moving`), never read from the DOM.
 *
 * Positions are measured in the view's own CSS pixels, the space that keyframes, inline
 * positions and scroll offsets use. Hosts may zoom the whole document (CSS `zoom` on the root),
 * and most engines then report `getBoundingClientRect` in zoomed pixels; rect reads are divided
 * by the measured zoom (`zoomOf`).
 */
import { anchorDelta, releasesAnchor } from "$lib/domain/scroll-anchor";
import { onFrame } from "./frame-loop";

export const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/**
 * Visual pixels per CSS pixel of `element`: the document zoom a host applies,
 * or 1. Measured rather than assumed, so it holds whichever space an engine
 * reports rects in. `element` must not be transformed itself.
 */
export function zoomOf(element: Element, rect: DOMRect = element.getBoundingClientRect()): number {
  const style = getComputedStyle(element);
  const edges = style.boxSizing === "border-box" ? 0
    : parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  const width = parseFloat(style.width) + edges;
  return width > 0 && rect.width > 0 ? rect.width / width : 1;
}

/** A Trace grid's presentation activity (its scene controller's), for code that only holds an element (the tooltip). */
export interface PresentationActivity {
  readonly moving: boolean;
  whenIdle(): Promise<void>;
}
const activities = new WeakMap<Element, PresentationActivity>();
/** Attachment: registers `activity` for the element it is attached to (a grid) and its descendants. */
export const presentationActivity = (activity: PresentationActivity) => (element: Element) => {
  activities.set(element, activity);
  return () => { if (activities.get(element) === activity) activities.delete(element); };
};
/** The presentation activity of the grid holding `element`, if any. */
export function activityOf(element: Element | null): PresentationActivity | null {
  for (let at = element; at; at = at.parentElement) {
    const activity = activities.get(at);
    if (activity) return activity;
  }
  return null;
}

const anchorOffsets = new WeakMap<Element, { top: number; left: number }>();

/**
 * Whether a scroll event only reports an offset the anchor hold set itself, as
 * opposed to a user scroll, so other listeners (the tooltip) can ignore it.
 */
export function isAnchorScroll(target: EventTarget | null): boolean {
  const set = target instanceof Element ? anchorOffsets.get(target) : undefined;
  return !!target && !!set && !releasesAnchor({ type: "scroll", actual: (target as Element).scrollTop, expected: set.top })
    && !releasesAnchor({ type: "scroll", actual: (target as Element).scrollLeft, expected: set.left });
}

export interface AnchorHold {
  /** Compensates now. Called once after each publication's motion starts; motion frames compensate on their own. */
  update(): void;
  release(): void;
}

export interface AnchorOptions {
  /**
   * Subscribes to the frames presentation motion runs in, after their poses are written (default:
   * the motion frame loop's `scroll` phase); returns the unsubscription.
   */
  readonly frames?: (listener: () => void) => () => void;
  readonly onRelease?: () => void;
}

const motionFrames = (listener: () => void) => onFrame("scroll", listener);

/**
 * Holds `element` where it is on screen: capture before changing selection. The owner calls
 * `update` once after each publication's motion starts (layout only changes by publication);
 * while the presentation moves, every motion frame compensates once its poses are written, in
 * that frame (`frame-loop.ts`), never from a frame callback of its own. An idle presentation runs
 * no frames, and leaves the anchor valid without a pending promise. User scrolling, scrollbar
 * presses and navigation keys release it, and so does an adjustment the scroll range cannot take.
 */
export function holdAnchor(scroller: HTMLElement, element: HTMLElement, { frames = motionFrames, onRelease = () => {} }: AnchorOptions = {}): AnchorHold {
  const before = element.getBoundingClientRect();
  const horizontal = element.closest<HTMLElement>("[data-horizontal-scroll]");
  let expectedTop = scroller.scrollTop, expectedLeft = horizontal?.scrollLeft ?? 0;
  let held = true;
  let unsubscribe = () => {};
  const release = () => {
    if (!held) return;
    held = false;
    anchorOffsets.delete(scroller);
    if (horizontal) anchorOffsets.delete(horizontal);
    unsubscribe();
    for (const type of USER_SCROLL) scroller.removeEventListener(type, onInput, true);
    scroller.removeEventListener("scroll", onScroll, true);
    onRelease();
  };
  const onInput = (event: Event) => {
    if (event.type === "keydown") {
      if (releasesAnchor({ type: "keydown", key: (event as KeyboardEvent).key })) release();
    } else if (event.type === "pointerdown") {
      // Content clicks can toggle sections while retaining the anchor. A
      // classic scrollbar is outside the target scroller's client area.
      const target = event.target;
      if (target !== scroller && target !== horizontal) return;
      const container = target as HTMLElement, box = container.getBoundingClientRect(), zoom = zoomOf(container, box);
      const { clientX: x, clientY: y } = event as PointerEvent;
      const left = box.left + container.clientLeft * zoom, top = box.top + container.clientTop * zoom;
      if (releasesAnchor({ type: "pointerdown", scrollbar: x < left || x >= left + container.clientWidth * zoom || y < top || y >= top + container.clientHeight * zoom })) release();
    } else release();
  };
  const movedByOther = () => {
    // Removing content can clamp scrolling as part of layout, before we can
    // adjust. Use that actual offset to compute the remaining displacement;
    // the anchor may already be satisfied, or still be reachable from there.
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (expectedTop > maxTop && !releasesAnchor({ type: "scroll", actual: scroller.scrollTop, expected: maxTop })) expectedTop = scroller.scrollTop;
    if (horizontal) {
      const maxLeft = Math.max(0, horizontal.scrollWidth - horizontal.clientWidth);
      if (expectedLeft > maxLeft && !releasesAnchor({ type: "scroll", actual: horizontal.scrollLeft, expected: maxLeft })) expectedLeft = horizontal.scrollLeft;
    }
    return releasesAnchor({ type: "scroll", actual: scroller.scrollTop, expected: expectedTop })
      || (!!horizontal && releasesAnchor({ type: "scroll", actual: horizontal.scrollLeft, expected: expectedLeft }));
  };
  const onScroll = (event: Event) => { if ((event.target === scroller || event.target === horizontal) && movedByOther()) release(); };
  for (const type of USER_SCROLL) scroller.addEventListener(type, onInput, { passive: true, capture: true });
  scroller.addEventListener("scroll", onScroll, { passive: true, capture: true });
  const adjust = () => {
    if (!held) return;
    if (!scroller.contains(element) || movedByOther()) { release(); return; }
    // Rects may be in zoomed pixels; scroll offsets are in the scroller's own.
    const box = element.getBoundingClientRect();
    const zoom = zoomOf(scroller);
    const dy = anchorDelta(before.top, box.top, zoom), dx = anchorDelta(before.left, box.left, zoom);
    const requestedTop = expectedTop + dy;
    if (dy) scroller.scrollTop = requestedTop;
    expectedTop = scroller.scrollTop;
    const requestedLeft = expectedLeft + dx;
    if (horizontal && dx) horizontal.scrollLeft = requestedLeft;
    expectedLeft = horizontal?.scrollLeft ?? 0;
    if (dy) anchorOffsets.set(scroller, { top: scroller.scrollTop, left: scroller.scrollLeft });
    if (horizontal && dx) anchorOffsets.set(horizontal, { top: horizontal.scrollTop, left: horizontal.scrollLeft });
    // Horizontal preservation is best effort: a graph can move sideways even
    // when its section has no horizontal overflow. That must not end the hold
    // on the view's vertical scroll axis.
    if (releasesAnchor({ type: "adjustment", actual: expectedTop, requested: requestedTop })) release();
  };
  adjust();
  if (held) unsubscribe = frames(adjust);
  return { update: adjust, release };
}

/** Input that may mean the user is scrolling (or about to) themselves; see `scrollsByUser`. */
export const USER_SCROLL = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
/** A held modifier (auto-repeating during a Ctrl- or Shift-click) is not scrolling. */
export const scrollsByUser = (event: Event) => !(event instanceof KeyboardEvent && MODIFIERS.has(event.key));
