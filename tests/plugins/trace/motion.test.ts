import { afterEach, describe, expect, it, vi } from "vitest";
import { holdAnchor, insetBottom, visibleClipHeight } from "$lib/plugins/trace/view/motion";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Scroll offsets affect screen rects as in a browser, including zoom and clamping. */
function anchorFixture(zoom = 1, quantize: (value: number) => number = (value) => value) {
  let sequence = 0, mutation!: (records: { type: string }[]) => void, resizeChanged!: () => void, present = true, top = 200, left = 20, limit = 1000;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const disconnect = vi.fn();
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: (records: { type: string }[]) => void) { mutation = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const resizeDisconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resizeChanged = callback; }
    observe() {}
    disconnect = resizeDisconnect;
  });
  vi.stubGlobal("getComputedStyle", () => ({ width: "200px", boxSizing: "border-box" }));
  const animations: Animation[] = [];
  const horizontal = Object.assign(new EventTarget(), { scrollLeft: left });
  Object.defineProperty(horizontal, "scrollLeft", { get: () => left, set: (value) => { left = Math.max(0, Math.min(1000, value)); } });
  const surface = Object.assign(new EventTarget(), {
    children: [], scrollTop: top, clientLeft: 0, clientTop: 0, clientWidth: 192, clientHeight: 400,
    getBoundingClientRect: () => ({ width: 200 * zoom, left: 0, top: 0 }) as DOMRect,
    getAnimations: () => animations,
    contains: () => present,
  });
  Object.defineProperty(surface, "scrollTop", { get: () => top, set: (value) => { top = Math.max(0, Math.min(limit, quantize(value))); } });
  Object.defineProperty(surface, "scrollHeight", { get: () => limit + surface.clientHeight });
  const position = { top: 300, left: 80 };
  const element = {
    getBoundingClientRect: () => ({ top: position.top - surface.scrollTop * zoom, left: position.left - horizontal.scrollLeft * zoom }) as DOMRect,
    closest: () => horizontal,
  } as unknown as HTMLElement;
  return {
    scroller: surface as unknown as HTMLElement, horizontal, element, position, animations, disconnect,
    pending: () => frames.size,
    shrinkLimit(value: number) { limit = value; top = Math.min(top, limit); },
    remove() { present = false; mutation([]); },
    mutate() { mutation([{ type: "childList" }]); },
    resize() { resizeChanged(); },
    startMotion(iterations = 1) { animations.push({ playState: "running", effect: { getTiming: () => ({ iterations }) } } as unknown as Animation); },
    finishMotion() { animations.length = 0; },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
  };
}

describe("holding a scroll anchor", () => {
  it("keeps the clicked tile anchored through floor-quantized scrolling", () => {
    const fixture = anchorFixture(1, Math.floor), released = vi.fn();
    const captured = fixture.element.getBoundingClientRect().top;
    const hold = holdAnchor(fixture.scroller, fixture.element, released);
    fixture.startMotion();
    for (const shift of [14.59, 21.83, 70.16, 115]) {
      fixture.position.top = 300 - shift;
      hold.update();
      expect(Math.abs(fixture.element.getBoundingClientRect().top - captured)).toBeLessThan(1);
      expect(released).not.toHaveBeenCalled();
    }
    // Actual bounds still release the hold.
    fixture.position.top = -1000;
    hold.update();
    expect(released).toHaveBeenCalledOnce();
  });

  it.each([1, 1.3, 1.5])("compensates before a worker commit and through every motion frame at zoom %s", (zoom) => {
    const fixture = anchorFixture(zoom);
    const before = fixture.element.getBoundingClientRect();
    const hold = holdAnchor(fixture.scroller, fixture.element);
    expect(fixture.pending()).toBe(0);
    // The earlier section commits while the clicked graph is still pending.
    fixture.startMotion();
    fixture.position.top -= 60;
    hold.update();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
    expect(fixture.pending()).toBe(1);
    for (let i = 0; i < 10; i++) {
      fixture.position.top -= 3;
      fixture.position.left += 2;
      fixture.frame();
      expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
      expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
      expect(fixture.pending()).toBe(1);
    }
    fixture.finishMotion();
    fixture.position.top -= 25;
    fixture.frame(); // Sample the final frame even when motion has just ended.
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
    expect(fixture.pending()).toBe(0);
    fixture.position.top += 30;
    hold.update(); // A later commit wakes the retained anchor.
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
    expect(fixture.pending()).toBe(0);
    hold.release();
  });

  it("does not let continuous interrupted relayouts grow frames or fight subsequent scrolling", () => {
    const fixture = anchorFixture();
    const before = fixture.element.getBoundingClientRect();
    const hold = holdAnchor(fixture.scroller, fixture.element);
    for (let i = 0; i < 100; i++) {
      fixture.finishMotion();
      fixture.startMotion();
      fixture.position.top += 2;
      hold.update();
      hold.update();
      fixture.frame();
      fixture.scroller.dispatchEvent(new Event("scroll")); // Own queued/coalesced events.
      expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
      expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
      expect(fixture.pending()).toBe(1);
    }
    fixture.scroller.dispatchEvent(new Event("wheel"));
    fixture.scroller.scrollTop += 100;
    const scrolled = fixture.scroller.scrollTop;
    fixture.position.top += 20;
    hold.update();
    fixture.frame();
    expect(fixture.scroller.scrollTop).toBe(scrolled);
    expect(fixture.pending()).toBe(0);
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it.each(["scroll", "touchstart", "keydown", "scrollbar", "removed", "released"])("releases on %s and tears down motion monitoring", (reason) => {
    const fixture = anchorFixture();
    const released = vi.fn();
    fixture.startMotion();
    const hold = holdAnchor(fixture.scroller, fixture.element, released);
    if (reason === "scroll") { fixture.scroller.scrollTop += 40; fixture.scroller.dispatchEvent(new Event("scroll")); }
    else if (reason === "touchstart") fixture.scroller.dispatchEvent(new Event("touchstart"));
    else if (reason === "keydown") fixture.scroller.dispatchEvent(Object.assign(new Event("keydown"), { key: "PageDown" }));
    else if (reason === "scrollbar") fixture.scroller.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 196, clientY: 20 }));
    else if (reason === "removed") fixture.remove();
    else hold.release();
    const scrolled = fixture.scroller.scrollTop;
    fixture.position.top += 20;
    hold.update(); fixture.frame(); hold.release();
    fixture.scroller.dispatchEvent(new Event("wheel"));
    expect(fixture.scroller.scrollTop).toBe(scrolled);
    expect(fixture.pending()).toBe(0);
    expect(released).toHaveBeenCalledOnce();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it("detects scrolling before its scroll event is delivered", () => {
    const fixture = anchorFixture();
    fixture.startMotion();
    holdAnchor(fixture.scroller, fixture.element);
    fixture.scroller.scrollTop += 40;
    fixture.frame();
    expect(fixture.scroller.scrollTop).toBe(240);
    expect(fixture.pending()).toBe(0);
  });

  it("retains the hold on modifier keys and section content presses", () => {
    const fixture = anchorFixture();
    const before = fixture.element.getBoundingClientRect();
    const hold = holdAnchor(fixture.scroller, fixture.element);
    for (const key of ["Shift", "Control", "Meta", "a"]) fixture.scroller.dispatchEvent(Object.assign(new Event("keydown"), { key }));
    fixture.scroller.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 40, clientY: 20 }));
    fixture.position.top += 20;
    hold.update();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.element.getBoundingClientRect().left).toBeCloseTo(before.left, 8);
    hold.release();
  });

  it.each([-400, 1200])("releases when the vertical adjustment is clamped (%s)", (delta) => {
    const fixture = anchorFixture();
    const released = vi.fn();
    fixture.startMotion();
    const hold = holdAnchor(fixture.scroller, fixture.element, released);
    fixture.position.top += delta;
    fixture.frame();
    expect(fixture.scroller.scrollTop).toBe(delta < 0 ? 0 : 1000);
    expect(released).toHaveBeenCalledOnce();
    fixture.position.top -= delta;
    hold.update();
    expect(fixture.scroller.scrollTop).toBe(delta < 0 ? 0 : 1000);
    expect(fixture.pending()).toBe(0);
  });

  it("retains a reachable anchor when removing content automatically clamps the scroll offset", () => {
    const fixture = anchorFixture();
    fixture.scroller.scrollTop = 1000;
    fixture.position.top = 1100;
    const before = fixture.element.getBoundingClientRect();
    const released = vi.fn();
    const hold = holdAnchor(fixture.scroller, fixture.element, released);
    fixture.position.top -= 100;
    fixture.shrinkLimit(900);
    fixture.scroller.dispatchEvent(new Event("scroll"));
    hold.update();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(released).not.toHaveBeenCalled();
    fixture.position.top -= 20;
    hold.update();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.scroller.scrollTop).toBe(880);
    hold.release();
  });

  it("compensates structural changes and resized sections while motion is idle", () => {
    const fixture = anchorFixture();
    const before = fixture.element.getBoundingClientRect();
    const hold = holdAnchor(fixture.scroller, fixture.element);
    fixture.position.top -= 40;
    fixture.mutate();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    fixture.position.top += 30;
    fixture.resize();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.pending()).toBe(0);
    hold.release();
    fixture.position.top += 10;
    fixture.mutate(); fixture.resize();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top + 10, 8);
  });

  it("preserves the vertical anchor when horizontal preservation is clamped", () => {
    const fixture = anchorFixture();
    const before = fixture.element.getBoundingClientRect();
    fixture.startMotion();
    const hold = holdAnchor(fixture.scroller, fixture.element);
    fixture.position.left -= 100;
    fixture.position.top += 20;
    fixture.frame();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    fixture.position.top += 20;
    fixture.frame();
    expect(fixture.element.getBoundingClientRect().top).toBeCloseTo(before.top, 8);
    expect(fixture.pending()).toBe(1);
    hold.release();
  });

  it("ignores infinite spinners when deciding whether to schedule a frame", () => {
    const fixture = anchorFixture();
    fixture.startMotion(Infinity);
    const hold = holdAnchor(fixture.scroller, fixture.element);
    expect(fixture.pending()).toBe(0);
    hold.release();
  });
});

describe("reading a section's displayed clip", () => {
  it("reads the bottom inset from every form an engine serializes", () => {
    expect(insetBottom("inset(0px 0px 12.5px 0px round 5px)")).toBe(12.5);
    expect(insetBottom("inset(0px 0px 12.5px round 5px)")).toBe(12.5);
    expect(insetBottom("inset(3px 0px)")).toBe(3);
    expect(insetBottom("inset(7px)")).toBe(7);
    expect(insetBottom("  inset(1px 2px 3px 4px)  ")).toBe(3);
  });

  it("treats no clip, other shapes and malformed values as unclipped", () => {
    for (const value of ["none", "", "circle(50%)", "inset()", "inset(a b c)", "inset(0px 0px 4px", "polygon(0 0, 1px 1px)"]) {
      expect(insetBottom(value), value).toBe(0);
    }
  });
});


describe("visible motion clip", () => {
  it("preserves the displayed bottom for inset and rectangular polygon clips", () => {
    expect(visibleClipHeight("inset(0 0 40px 0)", 200)).toBe(160);
    expect(visibleClipHeight("polygon(0px 0px, 300px 0px, 300px 160px, 0px 160px)", 200)).toBe(160);
    expect(visibleClipHeight("none", 200)).toBe(200);
    expect(visibleClipHeight("polygon(0px 0px, 300px 0px, 300px 240px, 0px 240px)", 200)).toBe(200);
  });
  it("falls back for malformed or unsupported polygon coordinates", () => {
    for (const clip of ["polygon()", "polygon(0px 0px, NaNpx 0px)", "polygon(0% 0%, 100% 0%, 100% 50%, 0% 50%)"]) {
      expect(visibleClipHeight(clip, 200)).toBe(200);
    }
  });
});
