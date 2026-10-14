import { deselectGesture, inClientArea, scaledClientArea, type DeselectEvent, type DeselectGesture, type DeselectPointer, type PointerPosition } from "$lib/domain/deselect-click";
import { zoomOf } from "./motion";
import { SELECTABLE_TILES } from "./selectable";
import { clampPoint, intersectedTiles, normalizeRect, sameSelection, marqueeSelection, type MarqueeRect } from "./marquee-selection";

interface Options {
  background(): void;
  captureSelection(): () => boolean;
  start(): void;
  end(commit: boolean): void;
  select(keys: readonly string[], additive: boolean): void;
  draw(rect: MarqueeRect | null): void;
  /** Whether the presentation is moving: hits are re-read every frame while it does. */
  moving(): boolean;
}

/** Host semantics: immediate start, window listeners (no capture), no edge auto-scroll, rAF moves. */
export function attachMarqueeSelection(element: HTMLElement, options: Options) {
  const controls = `button, a, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [tabindex], [contenteditable]:not([contenteditable="false"]), [data-tile-key], ${SELECTABLE_TILES}`;
  const at = (event: MouseEvent): PointerPosition => ({ x: event.clientX, y: event.clientY });
  const area = () => {
    const box = element.getBoundingClientRect();
    return scaledClientArea({ x: box.left, y: box.top }, { left: element.clientLeft, top: element.clientTop, width: element.clientWidth, height: element.clientHeight }, zoomOf(element, box));
  };
  const empty = (target: EventTarget | null, position: PointerPosition) => {
    if (!(target instanceof Element) || !element.contains(target) || !inClientArea(position, area())) return false;
    const control = target.closest(controls);
    return !control || !element.contains(control);
  };
  const pointer = (event: PointerEvent): DeselectPointer => ({ ...at(event), id: event.pointerId, button: event.button, primary: event.isPrimary });
  let gesture: DeselectGesture | null = null;
  let drag: { id: number; start: PointerPosition; current: PointerPosition; additive: boolean; moved: boolean; hits: readonly string[] | null; visited: readonly string[]; ownsSelection: () => boolean } | null = null;
  let frame = 0;
  let pending = false;
  let pendingPointerSelection: (() => boolean) | null = null;
  let suppressClickUntil = 0;
  const handle = (event: DeselectEvent) => {
    const next = deselectGesture(gesture, event);
    gesture = next.gesture;
    if (next.deselect) options.background();
  };
  const flush = () => {
    frame = 0;
    if (!drag || !pending) return;
    pending = false;
    const fromPointer = pendingPointerSelection?.() ?? false;
    pendingPointerSelection = null;
    const box = element.getBoundingClientRect(), scale = zoomOf(element, box);
    const bounds = area();
    // Like the host, the start stays fixed in viewport space when the contents scroll.
    const rect = normalizeRect(drag.start, clampPoint(drag.current, bounds));
    options.draw({ left: (rect.left - box.left) / scale + element.scrollLeft - element.clientLeft, top: (rect.top - box.top) / scale + element.scrollTop - element.clientTop, width: rect.width / scale, height: rect.height / scale });
    const tiles = [...element.querySelectorAll<HTMLElement>(SELECTABLE_TILES)]
      .filter((tile) => !tile.closest("[data-motion-ghosts], [inert]"))
      .map((tile) => ({ key: tile.dataset.nodeKey ?? tile.dataset.referenceKey ?? tile.dataset.entryPath!, rect: tile.getBoundingClientRect() }));
    const hits = intersectedTiles(rect, tiles);
    // Geometry changes and release must not undo a newer host command.
    // A subsequent pointer move can start a new selection baseline.
    if (!drag.moved || (!drag.ownsSelection() && !fromPointer)) return;
    if (drag.hits === null || !sameSelection(hits, drag.hits)) {
      drag.hits = hits;
      // A host command (Escape, another pane) starts a new additive baseline.
      if (!drag.ownsSelection()) drag.visited = [];
      drag.visited = marqueeSelection(drag.visited, hits, { ctrlKey: drag.additive });
      options.select(drag.visited, drag.additive);
      drag.ownsSelection = options.captureSelection();
    }
    if (options.moving()) schedule(false);
  };
  const schedule = (fromPointer = true) => {
    pending = true;
    // Input queued before a newer command cannot reclaim that command's selection.
    if (fromPointer) pendingPointerSelection = options.captureSelection();
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const finish = (commit: boolean) => {
    if (!drag) return;
    cancelAnimationFrame(frame);
    frame = 0;
    if (commit) { pending = true; flush(); }
    cancelAnimationFrame(frame);
    frame = 0;
    if (drag.moved) { suppressClickUntil = performance.now() + 500; gesture = null; }
    drag = null;
    pending = false;
    pendingPointerSelection = null;
    options.draw(null);
    options.end(commit);
  };
  const down = (event: PointerEvent) => {
    handle({ type: "down", pointer: pointer(event), emptyTarget: empty(event.target, at(event)) });
    if (!gesture) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    drag = { id: event.pointerId, start: at(event), current: at(event), additive: event.ctrlKey || event.metaKey, moved: false, hits: null, visited: [], ownsSelection: options.captureSelection() };
    suppressClickUntil = 0;
    options.start();
    const box = element.getBoundingClientRect(), scale = zoomOf(element, box);
    options.draw({ left: (event.clientX - box.left) / scale + element.scrollLeft - element.clientLeft, top: (event.clientY - box.top) / scale + element.scrollTop - element.clientTop, width: 0, height: 0 });
    event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    handle({ type: "move", pointer: pointer(event) });
    if (!drag || event.pointerId !== drag.id) return;
    if (!event.buttons) { finish(false); gesture = null; return; }
    drag.current = at(event);
    drag.moved ||= event.clientX !== drag.start.x || event.clientY !== drag.start.y;
    if (drag.moved) schedule();
  };
  const up = (event: PointerEvent) => {
    handle({ type: "up", pointer: pointer(event), emptyTarget: empty(event.target, at(event)) });
    if (drag?.id === event.pointerId) finish(true);
  };
  const click = (event: MouseEvent) => {
    if (performance.now() < suppressClickUntil) { suppressClickUntil = 0; gesture = null; return; }
    handle({ type: "click", position: at(event), button: event.button, emptyTarget: empty(event.target, at(event)) });
  };
  const contextMenu = (event: MouseEvent) => { if (empty(event.target, at(event))) options.background(); };
  const cancel = () => { gesture = null; finish(false); };
  const wheel = () => handle({ type: "wheel" });
  const scroll = () => { handle({ type: "scroll" }); if (drag?.moved) schedule(false); };
  element.addEventListener("pointerdown", down, true);
  element.addEventListener("click", click, true);
  element.addEventListener("contextmenu", contextMenu);
  element.addEventListener("wheel", wheel, { capture: true, passive: true });
  element.addEventListener("scroll", scroll, true);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("dragstart", cancel);
  return {
    // Resolving a cold cover is this drag's own selection, not a newer command.
    selectionApplied() {
      if (drag) drag.ownsSelection = options.captureSelection();
      if (pendingPointerSelection) pendingPointerSelection = options.captureSelection();
    },
    layoutChanged() { if (drag?.moved) schedule(false); }, destroy() {
    cancel();
    element.removeEventListener("pointerdown", down, true);
    element.removeEventListener("click", click, true);
    element.removeEventListener("contextmenu", contextMenu);
    element.removeEventListener("wheel", wheel, true);
    element.removeEventListener("scroll", scroll, true);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("dragstart", cancel);
  } };
}
