import { describe, expect, it } from "vitest";
import { mustLayoutBeforePaint } from "$lib/domain/trace-graph/layout-workload";

describe("layout before paint", () => {
  it("is required when the scene on screen reaches past the width the pane now has", () => {
    expect(mustLayoutBeforePaint(1150, 870)).toBe(true);
    expect(mustLayoutBeforePaint(870.5, 870)).toBe(true);
  });

  it("is not required while the scene on screen still fits: it stays shown, whole, until the new layout commits", () => {
    expect(mustLayoutBeforePaint(870, 1158)).toBe(false);
    expect(mustLayoutBeforePaint(870, 870)).toBe(false);
    expect(mustLayoutBeforePaint(0, 0)).toBe(false);
  });

  it("is never forced by nothing on screen or by a measure that is not a finite number", () => {
    expect(mustLayoutBeforePaint(null, 400)).toBe(false);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(mustLayoutBeforePaint(bad, 400)).toBe(false);
      expect(mustLayoutBeforePaint(400, bad)).toBe(false);
    }
  });

  it("compares extremely large extents exactly", () => {
    expect(mustLayoutBeforePaint(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1)).toBe(true);
    expect(mustLayoutBeforePaint(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(false);
  });
});
