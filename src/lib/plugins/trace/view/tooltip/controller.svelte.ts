/**
 * The document's one Trace tooltip: wires DOM events and a timer to the pure
 * state machine (machine.ts) and mounts the bubble (TileTooltip.svelte) in
 * `document.body`, so no scroll container or section overflow clips it.
 *
 * Triggers register through the `tooltipTrigger` attachment. The bubble and
 * the window listeners exist only while at least one trigger is mounted.
 */
import { mount, unmount } from "svelte";
import { deadline, initialTooltipState, stepTooltip, visibleTarget, type DismissReason, type TooltipEvent, type TooltipState } from "./machine";
import type { TileTooltipContent } from "./content";
import TileTooltip from "./TileTooltip.svelte";

export interface TooltipSource {
  /** Read reactively while the tooltip shows, so it may depend on state. */
  content(): TileTooltipContent;
  /** Called each time the tooltip opens (for example to load details). */
  onshow?(): void;
}

export interface TooltipTarget extends TooltipSource {
  readonly element: HTMLElement;
}

export interface ShownTooltip {
  readonly target: TooltipTarget;
  /** Handed off warm: no entrance animation. */
  readonly instant: boolean;
}

export const TOOLTIP_ID = "trace-tile-tooltip";

const now = () => performance.now();

let machine: TooltipState<TooltipTarget> = initialTooltipState();
let shown = $state.raw<ShownTooltip | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let triggers = 0;
let bubble: Record<string, unknown> | null = null;
let removeListeners: (() => void) | null = null;

export const tooltipView = {
  get current(): ShownTooltip | null { return shown; },
};

function dispatch(event: TooltipEvent<TooltipTarget>): void {
  machine = stepTooltip(machine, event);
  clearTimeout(timer);
  timer = undefined;
  const due = deadline(machine);
  // A timer can fire a fraction early; the tick then leaves the state pending and reschedules.
  if (due !== null) timer = setTimeout(() => dispatch({ type: "tick", at: now() }), Math.max(0, due - now()));
  const visible = visibleTarget(machine);
  if (visible === (shown?.target ?? null)) return;
  shown?.target.element.removeAttribute("aria-describedby");
  if (visible) {
    bubble ??= mount(TileTooltip, { target: document.body });
    visible.element.setAttribute("aria-describedby", TOOLTIP_ID);
    visible.onshow?.();
  }
  shown = visible ? { target: visible, instant: machine.instant } : null;
}

const dismiss = (reason: DismissReason) => () => dispatch({ type: "dismiss", reason, at: now() });

function listen(): () => void {
  const press = dismiss("press"), scroll = dismiss("scroll"), blur = dismiss("blur"), resize = dismiss("resize"), escape = dismiss("escape");
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") escape(); };
  // Capture phase: scroll does not bubble, and presses must close the tooltip before handlers move things around.
  const options = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", press, options);
  document.addEventListener("dragstart", press, options);
  document.addEventListener("scroll", scroll, options);
  document.addEventListener("keydown", key, options);
  window.addEventListener("blur", blur);
  window.addEventListener("resize", resize);
  return () => {
    document.removeEventListener("pointerdown", press, options);
    document.removeEventListener("dragstart", press, options);
    document.removeEventListener("scroll", scroll, options);
    document.removeEventListener("keydown", key, options);
    window.removeEventListener("blur", blur);
    window.removeEventListener("resize", resize);
  };
}

function focusVisible(element: HTMLElement): boolean {
  try { return element.matches(":focus-visible"); } catch { return true; }
}

/**
 * Attachment for an element that shows a tooltip on hover (mouse or pen,
 * never touch) and on keyboard focus. Pass a stable source object, so the
 * attachment is not recreated on every change.
 */
export function tooltipTrigger(source: TooltipSource): (element: HTMLElement) => () => void {
  return (element) => {
    const target: TooltipTarget = { element, content: () => source.content(), onshow: () => source.onshow?.() };
    const enter = () => dispatch({ type: "enter", target, at: now() });
    const leave = () => dispatch({ type: "leave", target, at: now() });
    const pointerEnter = (event: PointerEvent) => { if (event.pointerType !== "touch") enter(); };
    const focusIn = () => { if (focusVisible(element)) enter(); };
    element.addEventListener("pointerenter", pointerEnter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", leave);
    if (triggers++ === 0) removeListeners = listen();
    return () => {
      element.removeEventListener("pointerenter", pointerEnter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", leave);
      leave();
      if (--triggers > 0) return;
      removeListeners?.();
      removeListeners = null;
      clearTimeout(timer);
      timer = undefined;
      machine = initialTooltipState();
      shown = null;
      if (bubble) { void unmount(bubble); bubble = null; }
    };
  };
}
