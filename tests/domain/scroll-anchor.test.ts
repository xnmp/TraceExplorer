import { describe, expect, it } from "vitest";
import { anchorDelta, releasesAnchor, type AnchorEvent } from "$lib/domain/scroll-anchor";

describe("scroll anchor displacement", () => {
  it.each([[100, 215, 1, 115], [100, -15, 1, -115], [100, 250, 1.5, 100], [-50, -50, 1, 0]])(
    "converts viewport displacement (%s → %s, zoom %s) to %s scroll pixels",
    (before, after, zoom, expected) => { expect(anchorDelta(before, after, zoom)).toBe(expected); },
  );
  it("ignores subpixel noise and invalid geometry", () => {
    expect(anchorDelta(100, 100.49)).toBe(0);
    expect(anchorDelta(100, 100.5)).toBe(0.5);
    for (const [before, after, zoom] of [[NaN, 10, 1], [10, Infinity, 1], [10, 20, 0], [10, 20, -1], [10, 20, NaN], [-1e308, 1e308, 1], [0, 1e308, 1e-308]]) {
      expect(anchorDelta(before, after, zoom)).toBe(0);
    }
  });
});

describe("scroll anchor invalidation", () => {
  it.each<AnchorEvent>([
    { type: "wheel" }, { type: "touchstart" }, { type: "replaced" }, { type: "removed" }, { type: "unmounted" },
    { type: "pointerdown", scrollbar: true },
    ...["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "].map((key): AnchorEvent => ({ type: "keydown", key })),
    { type: "scroll", actual: 200, expected: 100 },
    { type: "adjustment", actual: 0, requested: -10 }, { type: "adjustment", actual: 100, requested: 110 },
    { type: "adjustment", actual: 0, requested: NaN },
  ])("releases for %j", (event) => { expect(releasesAnchor(event)).toBe(true); });

  it.each<AnchorEvent>([
    { type: "motion" }, { type: "settled" }, { type: "pointerdown", scrollbar: false },
    { type: "scroll", actual: 100, expected: 100 }, { type: "scroll", actual: 100.1, expected: 100 },
    { type: "adjustment", actual: 0, requested: 0 }, { type: "adjustment", actual: 100, requested: 100 },
    ...["Shift", "Control", "Alt", "Meta", "AltGraph", "a", "Enter"].map((key): AnchorEvent => ({ type: "keydown", key })),
  ])("preserves the anchor for %j", (event) => { expect(releasesAnchor(event)).toBe(false); });
});
