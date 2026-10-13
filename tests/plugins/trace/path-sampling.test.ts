import { describe, expect, it } from "vitest";
import { orthogonalRouteTravel, moveOrthogonalRoute, displace, interpolatePath, flattenPath, polyline, resample, samplePathString } from "$lib/plugins/trace/view/path-sampling";

const close = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
};

describe("path sampling for connector motion", () => {
  it("reads the layout's paths and browser-serialized animated paths alike", () => {
    const layout = flattenPath("M0 0 L0 10 C0 15,20 15,20 20");
    const serialized = flattenPath('path("M 0 0 L 0 10 C 0 15, 20 15, 20 20")');
    expect(serialized).toEqual(layout);
    expect(layout![0]).toEqual({ x: 0, y: 0 });
    expect(layout!.at(-1)).toEqual({ x: 20, y: 20 });
  });

  it("accepts implicit repeated line commands, exponents and decimals without a leading digit", () => {
    expect(flattenPath("M0 0 L1 1 2 2")).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
    expect(flattenPath("M1e1 .5")).toEqual([{ x: 10, y: 0.5 }]);
  });

  it("rejects paths it cannot represent instead of guessing", () => {
    for (const bad of ["", "none", "M0 0 A5 5 0 0 1 10 10", "C1 1 2 2 3 3", "M0", "M0 0 L1"]) expect(flattenPath(bad), bad).toBeNull();
    expect(samplePathString("garbage", 8)).toBeNull();
  });

  it("resamples to evenly spaced points that keep both ends", () => {
    const points = resample([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 30, y: 10 }], 4);
    expect(points).toHaveLength(5);
    close(points[0], { x: 0, y: 0 });
    close(points[1], { x: 0, y: 10 });
    close(points[2], { x: 10, y: 10 });
    close(points[4], { x: 30, y: 10 });
  });

  it("gives any two paths the same point count so they can morph", () => {
    const short = samplePathString("M0 0 L0 1", 24)!, long = samplePathString("M0 0 L0 50 C0 60,200 60,200 70 L200 900", 24)!;
    expect(short).toHaveLength(25);
    expect(long).toHaveLength(25);
  });

  it("handles degenerate input", () => {
    expect(resample([], 4)).toEqual([]);
    expect(resample([{ x: 3, y: 4 }], 2)).toEqual([{ x: 3, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 4 }]);
    expect(resample([{ x: 1, y: 1 }, { x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }, { x: 1, y: 1 }]);
  });

  it("displaces the start and end by their own offsets and blends between them", () => {
    const moved = displace([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }], { x: 10, y: 0 }, { x: 0, y: -4 });
    expect(moved).toEqual([{ x: 10, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 6 }]);
  });

  it("keeps connector endpoints attached at intermediate travel progress", () => {
    const from = samplePathString("M10 20 L10 80", 24)!;
    const to = samplePathString("M10 20 L10 160 L90 160 L90 240", 24)!;
    const halfway = interpolatePath(from, to, .5);
    expect(halfway[0]).toEqual({ x: 10, y: 20 });
    expect(halfway.at(-1)).toEqual({ x: 50, y: 160 });
    expect(interpolatePath(from, to, 0)).toEqual(from);
    expect(interpolatePath(from, to, 1)).toEqual(to);
    expect(interpolatePath([], [], .5)).toEqual([]);
  });

  it("formats a polyline that parses back to the same points", () => {
    const points = [{ x: 1.5, y: 2 }, { x: 3, y: 4.25 }];
    expect(flattenPath(polyline(points))).toEqual(points);
  });
});

describe('orthogonal route travel', () => {
  const bridge = 'M100 0 L100 6 C100 9 103 12 106 12 L194 12 C197 12 200 15 200 18 L200 194 C200 197 197 200 194 200 L56 200 C53 200 50 203 50 206 L50 220';

  it('keeps a wrapped stem orthogonal while shortening its gutter and moving its child side', () => {
    for (const y of [0, -20, -80, -160]) {
      const moved = moveOrthogonalRoute(bridge, { x: 0, y: 0 }, { x: 0, y })!;
      const commands = [...moved.matchAll(/([MLC])([^MLC]+)/g)];
      let at = [0, 0];
      for (const [, kind, body] of commands) {
        const values = body.trim().split(/\s+/).map(Number);
        if (kind === 'L') expect(Math.abs(values[0] - at[0]) < .001 || Math.abs(values[1] - at[1]) < .001).toBe(true);
        at = values.slice(-2);
      }
      expect(flattenPath(moved)![0]).toEqual({ x: 100, y: 0 });
      expect(flattenPath(moved)!.at(-1)).toEqual({ x: 50, y: 220 + y });
      // The upper bridge stays above the first row, including its exact curves.
      expect(moved).toContain('M100 0 L100 6 C100 9 103 12 106 12 L194 12 C197 12 200 15 200 18');
    }
  });

  it('moves the descendant route and its cubic corners as a rigid unit', () => {
    const moved = moveOrthogonalRoute(bridge, { x: 13, y: -80 }, { x: 13, y: -80 })!;
    const original = flattenPath(bridge)!, translated = flattenPath(moved)!;
    translated.forEach((p, i) => close(p, { x: original[i].x + 13, y: original[i].y - 80 }));
  });

  it('stretches horizontal and vertical channels independently with different endpoint displacements', () => {
    const moved = moveOrthogonalRoute('M0 0 L0 100 L100 100 L100 120', { x: 0, y: 0 }, { x: 40, y: -50 });
    expect(flattenPath(moved!)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 140, y: 50 }, { x: 140, y: 70 }]);
  });

  it('rejects unsupported geometry or missing stretch channels instead of producing diagonals', () => {
    for (const path of ['', 'M0', 'M0 0 Q1 1 2 2', 'M0 0 LNaN 1', 'M0 0 L0 10']) {
      expect(moveOrthogonalRoute(path, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeNull();
    }
  });
});


describe('orthogonal topology changes', () => {
  it('retains a bridge channel throughout travel and reaches the moved endpoint', () => {
    const old = 'M0 0 L0 10 L100 10 L100 100 L50 100 L50 120';
    const target = 'M0 0 L0 10 L50 10 L50 30';
    const closing = orthogonalRouteTravel(old, target, { before: 128, after: 38 })!;
    expect(flattenPath(closing(.5)!)!.at(-1)).toEqual({ x: 50, y: 75 });
    expect(closing(.5)).toContain('L100 10 L100 55');
    const opening = orthogonalRouteTravel(target, old, { before: 38, after: 128 })!;
    expect(opening(.5)).toEqual(closing(.5));
  });

  it('never stretches a shared trunk inside the child rows', () => {
    const before = 'M0 0 L0 10 L50 10 L50 200';
    const after = 'M0 0 L0 30 L50 30 L50 220';
    const travel = orthogonalRouteTravel(before, after, { before: 20, after: 40 })!;
    expect(flattenPath(travel(.5)!)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 210 }]);
  });

  it('returns failure when there is no safe channel above the children', () => {
    expect(orthogonalRouteTravel('M0 0 L0 100', 'M0 0 L0 120', { before: 50, after: 70 })).toBeNull();
  });

  it('translates a junction route rigidly with the band', () => {
    const before = 'M0 100 C0 110 50 110 50 120 L50 130';
    const after = 'M0 200 C0 210 50 210 50 220 L50 230';
    const travel = orthogonalRouteTravel(before, after)!;
    const original = flattenPath(before)!, moved = flattenPath(travel(.5)!)!;
    moved.forEach((p, i) => close(p, { x: original[i].x, y: original[i].y + 50 }));
  });
});
