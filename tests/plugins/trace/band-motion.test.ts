import { expect, it } from "vitest";
import { departureVisibility } from "$lib/plugins/trace/view/band-motion";

it("ends retiring edge visibility when its child leaves reclaimed space", () => {
  // At 60% progress: child top = 288 + 129*.6, boundary = 383 - 28*.6.
  const gone = departureVisibility(383, 355, 288, 129);
  expect(gone).toBeGreaterThan(.6); expect(gone).toBeLessThan(.61);
  expect(departureVisibility(220, 0, 130)).toBeCloseTo(90 / 220);
  expect(departureVisibility(220, 300, 130)).toBe(1);
  expect(departureVisibility(Number.MAX_VALUE, 0, -Number.MAX_VALUE, Number.MAX_VALUE)).toBe(1);
});

it("never gives a retiring route invalid timing or visibility without a child", () => {
  for (const values of [[0, 0, 0], [100, 20, 100], [100, 20, Infinity], [NaN, 20, 50]]) {
    expect(departureVisibility(...values as [number, number, number])).toBe(0);
  }
});
