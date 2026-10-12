import { describe, expect, it } from "vitest";
import { clampPoint, intersectedTiles, marqueeSelection, normalizeRect, sameSelection } from "$lib/plugins/trace/view/marquee-selection";

const rect = { left: 10, top: 20, width: 30, height: 40 };
const tiles = [{ key: "a", rect }, { key: "b", rect: { left: 50, top: 20, width: 20, height: 40 } }];

describe("marquee geometry", () => {
  it("normalizes all four drag directions", () => {
    for (const [start, end] of [
      [{ x: 10, y: 20 }, { x: 40, y: 60 }], [{ x: 40, y: 60 }, { x: 10, y: 20 }],
      [{ x: 40, y: 20 }, { x: 10, y: 60 }], [{ x: 10, y: 60 }, { x: 40, y: 20 }],
    ]) expect(normalizeRect(start!, end!)).toEqual(rect);
  });
  it("requires positive-area overlap, including for zero-size and invalid drags", () => {
    expect(intersectedTiles(rect, tiles)).toEqual(["a"]);
    expect(intersectedTiles({ left: 40, top: 20, width: 10, height: 40 }, tiles)).toEqual([]);
    for (const invalid of [{ ...rect, width: 0 }, { ...rect, height: 0 }, { ...rect, width: -1 }, { ...rect, left: NaN }, { ...rect, height: Infinity }]) {
      expect(intersectedTiles(invalid, tiles)).toEqual([]);
    }
    expect(intersectedTiles(rect, [])).toEqual([]);
    expect(intersectedTiles(rect, [{ key: "bad", rect: { ...rect, width: NaN } }])).toEqual([]);
  });
  it("clamps releases outside the pane, including negative directions", () => {
    const pane = { left: 100, top: 200, width: 300, height: 400 };
    expect(clampPoint({ x: 900, y: 900 }, pane)).toEqual({ x: 400, y: 600 });
    expect(clampPoint({ x: -100, y: -100 }, pane)).toEqual({ x: 100, y: 200 });
    expect(intersectedTiles(normalizeRect({ x: 120, y: 220 }, clampPoint({ x: 900, y: 900 }, pane)), [{ key: "last", rect: { left: 380, top: 580, width: 20, height: 20 } }])).toEqual(["last"]);
  });
  it("uses live viewport boxes after scrolling rather than applying scroll twice", () => {
    const drag = { left: 0, top: 100, width: 100, height: 100 };
    const tile = { key: "scrolled", rect: { left: 10, top: 300, width: 40, height: 40 } };
    expect(intersectedTiles(drag, [tile])).toEqual([]);
    expect(intersectedTiles(drag, [{ ...tile, rect: { ...tile.rect, top: 150 } }])).toEqual(["scrolled"]);
  });
  it("handles many tiles and duplicate representations without duplicate selections", () => {
    const many = Array.from({ length: 100_000 }, (_, i) => ({ key: String(i), rect: { left: i * 10, top: 0, width: 5, height: 5 } }));
    expect(intersectedTiles({ left: 999_970, top: 0, width: 30, height: 5 }, many)).toEqual(["99997", "99998", "99999"]);
    expect(intersectedTiles(rect, [tiles[0]!, tiles[0]!])).toEqual(["a"]);
  });
});

describe("host marquee selection rules", () => {
  it("plain and Shift drags replace, including empty hits", () => {
    expect(marqueeSelection(["old"], ["a", "b"], {})).toEqual(["a", "b"]);
    expect(marqueeSelection(["old"], ["a"], { shiftKey: true })).toEqual(["a"]);
    expect(marqueeSelection(["old"], [], {})).toEqual([]);
  });
  it("Ctrl/Cmd accumulate from drag start and previous frames, never toggle", () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      const first = marqueeSelection(["old"], ["old", "a"], modifiers);
      expect(first).toEqual(["old", "a"]);
      expect(marqueeSelection(first, ["b"], modifiers)).toEqual(["old", "a", "b"]);
      expect(marqueeSelection(first, [], modifiers)).toEqual(first);
      expect(marqueeSelection([], [], modifiers)).toEqual([]);
    }
  });
  it("compares content rather than ordering or object identity", () => {
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameSelection(["a"], ["b"])).toBe(false);
    expect(sameSelection([], [])).toBe(true);
  });
});
