import { describe, expect, it } from "vitest";
import { deselectGesture, inClientArea, scaledClientArea, type DeselectEvent, type DeselectGesture, type DeselectPointer } from "$lib/domain/deselect-click";

const pointer: DeselectPointer = { x: 20, y: 30, id: 1, button: 0, primary: true };
const down = (sample = pointer, emptyTarget = true): DeselectEvent => ({ type: "down", pointer: sample, emptyTarget });
const up = (sample = pointer, emptyTarget = true): DeselectEvent => ({ type: "up", pointer: sample, emptyTarget });
const click = (sample = pointer, emptyTarget = true): DeselectEvent => ({ type: "click", position: sample, button: sample.button, emptyTarget });
const move = (x: number, y: number): DeselectEvent => ({ type: "move", pointer: { ...pointer, x, y } });

/** Observe only whether a sequence clears, rather than the gesture's representation. */
function clears(...events: DeselectEvent[]): boolean[] {
  let gesture: DeselectGesture | null = null;
  return events.map((event) => {
    const next = deselectGesture(gesture, event);
    gesture = next.gesture;
    return next.deselect;
  });
}

describe("empty-space click gestures", () => {
  it("clears only on click after a stationary press or small movement, including 5 px", () => {
    for (const sample of [pointer, { ...pointer, x: 23, y: 34 }, { ...pointer, x: 17, y: 26 }]) {
      expect(clears(down(), { type: "move", pointer: sample }, up(sample), click(sample))).toEqual([false, false, false, true]);
    }
  });

  it("rejects drags, including a pointer that returns to its starting position", () => {
    for (const sample of [{ x: 26, y: 30 }, { x: 20, y: 36 }, { x: 24, y: 34 }, { x: Number.MAX_VALUE, y: 30 }]) {
      expect(clears(down(), move(sample.x, sample.y), move(pointer.x, pointer.y), up(), click())).not.toContain(true);
      expect(clears(down(), up({ ...pointer, ...sample }), click())).not.toContain(true);
    }
  });

  it.each(["wheel", "scroll", "cancel", "blur"] as const)("invalidates a pending press on %s", (type) => {
    expect(clears(down(), { type }, up(), click())).not.toContain(true);
    expect(clears(down(), up(), { type }, click())).not.toContain(true);
    expect(clears(down(), { type }, down(), up(), click())).toEqual([false, false, false, false, true]);
  });

  it("keeps selection for scrollbar thumb/track coordinates when there is no click", () => {
    // A 200 x 100 client area: vertical/horizontal gutters can target the scroller
    // itself. Coordinates alone cannot distinguish them from canvas background.
    for (const sample of [{ ...pointer, x: 207, y: 30 }, { ...pointer, x: 20, y: 107 }]) {
      expect(clears(down(sample), up(sample))).toEqual([false, false]);
    }
  });

  it("requires an empty target at press, release and click", () => {
    expect(clears(down(pointer, false), up(), click())).not.toContain(true);
    expect(clears(down(), up(pointer, false), click())).not.toContain(true);
    expect(clears(down(), up(), click(pointer, false))).not.toContain(true);
    expect(clears(click(), down(), click(), up())).not.toContain(true);
    expect(clears(down(), up(), click(), click())).toEqual([false, false, true, false]);
  });

  it("requires the primary pointer and matching primary button", () => {
    for (const sample of [{ ...pointer, button: 1 }, { ...pointer, button: 2 }, { ...pointer, primary: false }]) {
      expect(clears(down(sample), up(sample), click(sample))).not.toContain(true);
    }
    expect(clears(down(), up({ ...pointer, button: 2 }), click())).not.toContain(true);
    expect(clears(down(), up(), click({ ...pointer, button: 2 }))).not.toContain(true);
    expect(clears(down(), up({ ...pointer, id: 2 }), click())).not.toContain(true);
  });

  it("rejects malformed positions and handles very large finite coordinates", () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(clears(down({ ...pointer, x: invalid }), up(), click())).not.toContain(true);
      expect(clears(down(), move(20, invalid), up(), click())).not.toContain(true);
      expect(clears(down(), up({ ...pointer, y: invalid }), click())).not.toContain(true);
      expect(clears(down(), up(), click({ ...pointer, x: invalid }))).not.toContain(true);
    }
    const large = { ...pointer, x: Number.MAX_VALUE, y: Number.MAX_VALUE };
    expect(clears(down(large), up(large), click(large))).toEqual([false, false, true]);
  });
});

describe("inClientArea", () => {
  const area = { left: 0, top: 10, width: 885, height: 400 };
  it("accepts content points and rejects the scrollbar gutter, borders and bad coordinates", () => {
    expect(inClientArea({ x: 100, y: 50 }, area)).toBe(true);
    expect(inClientArea({ x: 0, y: 10 }, area)).toBe(true);
    expect(inClientArea({ x: 884.9, y: 409.9 }, area)).toBe(true);
    expect(inClientArea({ x: 892, y: 50 }, area)).toBe(false);
    expect(inClientArea({ x: 885, y: 50 }, area)).toBe(false);
    expect(inClientArea({ x: 100, y: 410 }, area)).toBe(false);
    expect(inClientArea({ x: 100, y: 9 }, area)).toBe(false);
    expect(inClientArea({ x: Number.NaN, y: 50 }, area)).toBe(false);
  });
});

describe("scaledClientArea", () => {
  // A 900x400 CSS px pane with a 15 px scrollbar, at viewport origin (100, 50).
  const client = { left: 0, top: 0, width: 885, height: 385 };
  const hit = (zoom: number, cssX: number, cssY: number) =>
    inClientArea({ x: 100 + cssX * zoom, y: 50 + cssY * zoom }, scaledClientArea({ x: 100, y: 50 }, client, zoom));
  it.each([1, 1.25, 0.8])("separates content from the scrollbar gutter at zoom %s", (zoom) => {
    expect(hit(zoom, 880, 380)).toBe(true);
    expect(hit(zoom, 892, 100)).toBe(false);
    expect(hit(zoom, 100, 392)).toBe(false);
  });
  it("treats a bad zoom as 1", () => {
    for (const zoom of [0, -1, Number.NaN]) expect(scaledClientArea({ x: 0, y: 0 }, client, zoom)).toEqual(client);
  });
});
