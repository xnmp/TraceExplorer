import { describe, expect, it } from "vitest";
import { isDeselectClick } from "$lib/domain/deselect-click";

describe("empty-space clicks", () => {
  const down = { x: 20, y: 30 };

  it("accepts a stationary click and small jitter, including the threshold", () => {
    expect(isDeselectClick(down, down, true)).toBe(true);
    expect(isDeselectClick(down, { x: 23, y: 34 }, true)).toBe(true);
    expect(isDeselectClick(down, { x: 17, y: 26 }, true)).toBe(true);
  });

  it("rejects horizontal, vertical and diagonal drags", () => {
    for (const up of [{ x: 26, y: 30 }, { x: 20, y: 36 }, { x: 24, y: 34 }, { x: Number.MAX_VALUE, y: 30 }]) {
      expect(isDeselectClick(down, up, true)).toBe(false);
    }
  });

  it("requires an empty target and a valid pointer-down position", () => {
    expect(isDeselectClick(down, down, false)).toBe(false);
    expect(isDeselectClick(null, down, true)).toBe(false);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(isDeselectClick({ x: invalid, y: 30 }, down, true)).toBe(false);
      expect(isDeselectClick(down, { x: 20, y: invalid }, true)).toBe(false);
    }
    expect(isDeselectClick({ x: Number.MAX_VALUE, y: Number.MAX_VALUE }, { x: Number.MAX_VALUE, y: Number.MAX_VALUE }, true)).toBe(true);
  });
});
