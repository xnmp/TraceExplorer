import { describe, expect, it } from "vitest";
import { intersect, placeTooltip, type Rect } from "$lib/plugins/trace/view/tooltip/placement";

const OPTIONS = { gap: 6, margin: 8 };
const WINDOW: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height });
const SIZE = { width: 200, height: 60 };

function inside(spot: { left: number; top: number }, size: { width: number; height: number }, bounds: Rect, margin = OPTIONS.margin) {
  expect(spot.left).toBeGreaterThanOrEqual(bounds.left + margin);
  expect(spot.top).toBeGreaterThanOrEqual(bounds.top + margin);
  expect(spot.left + size.width).toBeLessThanOrEqual(bounds.right - margin);
  expect(spot.top + size.height).toBeLessThanOrEqual(bounds.bottom - margin);
}

describe("placeTooltip", () => {
  it("centres the tooltip above the anchor when there is room", () => {
    const spot = placeTooltip(rect(400, 300, 100, 120), SIZE, WINDOW, OPTIONS);
    expect(spot).toEqual({ left: 350, top: 300 - 6 - 60, side: "above" });
  });

  it("flips below an anchor near the top edge", () => {
    const spot = placeTooltip(rect(400, 20, 100, 120), SIZE, WINDOW, OPTIONS);
    expect(spot).toEqual({ left: 350, top: 146, side: "below" });
  });

  it("clamps at the right and left edges", () => {
    const right = placeTooltip(rect(940, 300, 60, 120), SIZE, WINDOW, OPTIONS);
    expect(right.left).toBe(1000 - 8 - 200);
    const left = placeTooltip(rect(0, 300, 40, 120), SIZE, WINDOW, OPTIONS);
    expect(left.left).toBe(8);
  });

  it("stays inside at the bottom-right corner", () => {
    const anchor = rect(930, 700, 70, 100);
    const spot = placeTooltip(anchor, SIZE, WINDOW, OPTIONS);
    expect(spot.side).toBe("above");
    inside(spot, SIZE, WINDOW);
  });

  it("when neither side fits, uses the roomier one and stays inside", () => {
    const tall = { width: 200, height: 500 };
    const nearTop = placeTooltip(rect(400, 150, 100, 400), tall, WINDOW, OPTIONS);
    expect(nearTop.side).toBe("below");
    inside(nearTop, tall, WINDOW);
    const nearBottom = placeTooltip(rect(400, 260, 100, 400), tall, WINDOW, OPTIONS);
    expect(nearBottom.side).toBe("above");
    inside(nearBottom, tall, WINDOW);
  });

  it("pins a tooltip larger than the bounds to the top-left margin", () => {
    const huge = { width: 5000, height: 5000 };
    const spot = placeTooltip(rect(400, 300, 100, 100), huge, WINDOW, OPTIONS);
    expect(spot.left).toBe(8);
    expect(spot.top).toBe(8);
  });

  it("respects bounds that do not start at the origin", () => {
    const bounds = rect(200, 100, 400, 300);
    const spot = placeTooltip(rect(560, 110, 40, 40), SIZE, bounds, OPTIONS);
    inside(spot, SIZE, bounds);
  });

  it("tolerates a zero or negative size", () => {
    const spot = placeTooltip(rect(400, 300, 100, 100), { width: -5, height: 0 }, WINDOW, OPTIONS);
    expect(spot).toEqual({ left: 450, top: 294, side: "above" });
  });
});

describe("intersect", () => {
  it("returns the overlap, or null when the rects do not overlap", () => {
    expect(intersect(rect(0, 0, 100, 100), rect(50, 60, 100, 100))).toEqual({ left: 50, top: 60, right: 100, bottom: 100 });
    expect(intersect(rect(0, 0, 100, 100), rect(100, 0, 50, 50))).toBeNull();
    expect(intersect(rect(0, 0, 100, 100), rect(0, 200, 50, 50))).toBeNull();
  });
});
