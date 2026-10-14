import { describe, expect, it } from "vitest";
import { mustLayoutBeforePaint } from "$lib/domain/trace-graph/layout-workload";

const shown = (extent: number, width: number) => ({ extent, width });

describe("layout before paint", () => {
  it("is required when the pane narrowed past the scene on screen", () => {
    expect(mustLayoutBeforePaint(shown(1150, 1158), 870)).toBe(true);
    expect(mustLayoutBeforePaint(shown(870.5, 1158), 870)).toBe(true);
    // Already wider than its pane, and the pane narrowed further: still replaced at once.
    expect(mustLayoutBeforePaint(shown(1400, 1158), 870)).toBe(true);
  });

  it("is not required while the scene on screen still fits: it stays shown, whole, until the new layout commits", () => {
    expect(mustLayoutBeforePaint(shown(870, 870), 1158)).toBe(false);
    expect(mustLayoutBeforePaint(shown(860, 1158), 870)).toBe(false);
    expect(mustLayoutBeforePaint(shown(870, 870), 870)).toBe(false);
    expect(mustLayoutBeforePaint(shown(0, 0), 0)).toBe(false);
  });

  it("is not required for a scene already wider than its own pane when the width did not shrink", () => {
    expect(mustLayoutBeforePaint(shown(1300, 800), 800)).toBe(false);
    expect(mustLayoutBeforePaint(shown(1300, 800), 900)).toBe(false);
  });

  it("is never forced by nothing on screen or by a measure that is not a finite number", () => {
    expect(mustLayoutBeforePaint(null, 400)).toBe(false);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(mustLayoutBeforePaint(shown(bad, 800), 400)).toBe(false);
      expect(mustLayoutBeforePaint(shown(600, bad), 400)).toBe(false);
      expect(mustLayoutBeforePaint(shown(600, 800), bad)).toBe(false);
    }
  });

  it("compares extremely large extents exactly", () => {
    expect(mustLayoutBeforePaint(shown(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER - 1)).toBe(true);
    expect(mustLayoutBeforePaint(shown(Number.MAX_VALUE, Number.MAX_VALUE), Number.MAX_VALUE)).toBe(false);
  });
});
