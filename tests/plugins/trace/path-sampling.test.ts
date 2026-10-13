import { describe, expect, it } from "vitest";
import { pathTranslation, translatePath, displace, interpolatePath, flattenPath, polyline, resample, samplePathString } from "$lib/plugins/trace/view/path-sampling";

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

describe("native route translation", () => {
  const path = "M0 100 C0 110 50 110 50 120 L50 130";
  it("recognizes a rigid route including its cubic control points", () => {
    const moved = "M13 20 C13 30 63 30 63 40 L63 50";
    expect(pathTranslation(path, moved)).toEqual({ x: 13, y: -80 });
    expect(translatePath(path, { x: 13, y: -80 })).toBe(moved);
    expect(pathTranslation(path, path)).toEqual({ x: 0, y: 0 });
  });
  it("rejects rerouting, including a changed control point with unchanged endpoints", () => {
    expect(pathTranslation(path, "M0 100 C1 110 50 110 50 120 L50 130")).toBeNull();
    expect(pathTranslation(path, "M0 100 L50 130")).toBeNull();
  });
  it("rejects non-finite translations and arithmetic overflow", () => {
    expect(translatePath(path, { x: NaN, y: 0 })).toBeNull();
    expect(translatePath("M1e308 0", { x: 1e308, y: 0 })).toBeNull();
  });
  it("rejects malformed and unsupported geometry instead of guessing", () => {
    for (const bad of ["", "M0", "M0 0 Q1 1 2 2", "M0 0 LNaN 1", "M0 0 L1e999 2"]) {
      expect(pathTranslation(bad, bad)).toBeNull();
      expect(translatePath(bad, { x: 0, y: 1 })).toBeNull();
    }
  });
});
