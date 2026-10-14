import { describe, expect, it } from "vitest";
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { roundedStem } from "$lib/domain/trace-graph/band-geometry";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";
import narrowPane from "./narrow-pane-request.json";

describe("downward bound at a pane width that is not a multiple of 32", () => {
  it("bounds the downward layout at the band's own width budget, so it is not pruned", () => {
    // 276 px panes lay the downward candidate out at 256 px; a bound at 276 px assumed wider
    // rows and pruned it, although it scores best.
    const request = { ...narrowPane, band: { ...narrowPane.band, items: narrowPane.band.items } } as unknown as LayoutRequest;
    const layout = layoutGraph(request);
    expect(layout.decision?.candidate).toBe("visible-down");
    expect(layout.orientation).toBe("down");
  });
});

describe("rounded cover stems", () => {
  it("never writes NaN for a stem that doubles back on itself", () => {
    for (const points of [
      [{ x: 382, y: 128 }, { x: 382, y: 146 }, { x: 382, y: 140 }, { x: 382, y: 146 }, { x: 300, y: 146 }, { x: 300, y: 200 }],
      [{ x: 10, y: 0 }, { x: 10, y: 20 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }],
    ]) {
      const d = roundedStem(points);
      expect(d, JSON.stringify(points)).not.toContain("NaN");
      expect(pathNumbers(d).every(Number.isFinite)).toBe(true);
      // It still starts and ends where it was asked to.
      const numbers = pathNumbers(d);
      expect(numbers.slice(0, 2)).toEqual([points[0].x, points[0].y]);
      expect(numbers.slice(-2)).toEqual([points.at(-1)!.x, points.at(-1)!.y]);
    }
  });
  it("keeps ordinary stems unchanged: rounded corners on an L-shaped run", () => {
    expect(roundedStem([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 30, y: 20 }])).toMatch(/^M0 0 L0 14 C/);
  });
});
