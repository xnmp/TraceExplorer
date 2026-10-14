import { describe, expect, it } from "vitest";
import { orthogonalRoute, type ForeignLanes } from "$lib/domain/trace-graph/orthogonal-route";
import type { PlacedNode } from "$lib/domain/trace-graph/layout";
import type { Point } from "$lib/domain/trace-graph/path-sampling";

const box = (key: string, x: number, y: number, width = 40, height = 40): PlacedNode => ({ key, x, y, width, height, band: 0, row: 0 });
/** Every leg of `path` is axis-parallel. */
const rectilinear = (path: readonly Point[]) => path.every((p, i) => !i || p.x === path[i - 1].x || p.y === path[i - 1].y);

describe("orthogonal route: further goals on the goal's column", () => {
  const start = { x: 50, y: 0 }, goal = { x: 200, y: 300 };

  it("ends at whichever goal it reaches first", () => {
    const path = orthogonalRoute(start, goal, [], 400, undefined, { column: [100] })!;
    expect(rectilinear(path)).toBe(true);
    expect(path[0]).toEqual(start);
    expect(path.at(-1)).toEqual({ x: 200, y: 100 });
  });

  it("passes over a further goal inside a tile", () => {
    const path = orthogonalRoute(start, goal, [box("t", 180, 80)], 400, undefined, { column: [100] })!;
    expect(path.at(-1)).toEqual(goal);
  });

  it("still ends at a further goal when the goal itself is inside a tile", () => {
    const path = orthogonalRoute(start, goal, [box("t", 180, 280)], 400, undefined, { column: [100] })!;
    expect(path.at(-1)).toEqual({ x: 200, y: 100 });
  });

  it("ignores non-finite further goals", () => {
    expect(orthogonalRoute(start, goal, [], 400, undefined, { column: [NaN, Infinity] })?.at(-1)).toEqual(goal);
  });
});

describe("orthogonal route: bounded search", () => {
  // A wall of tiles with one gap far to the right.
  const wall = Array.from({ length: 8 }, (_, i) => box(`w${i}`, 44 * i, 150, 44));
  const start = { x: 30, y: 0 }, goal = { x: 30, y: 300 };

  it("fails, and reports its work, when the budget runs out before the goal", () => {
    const spent = { cells: 0, pops: 0 };
    expect(orthogonalRoute(start, goal, wall, 400, undefined, { budget: 3, spent })).toBeNull();
    expect(spent.pops).toBe(3);
    expect(spent.cells).toBeGreaterThan(0);
  });

  it("finds the route around the wall when the budget allows", () => {
    const path = orthogonalRoute(start, goal, wall, 400, undefined, { budget: 10_000 })!;
    expect(rectilinear(path)).toBe(true);
    expect(path.at(-1)).toEqual(goal);
    expect(Math.max(...path.map(p => p.x))).toBeGreaterThan(44 * 8);
  });
});

describe("orthogonal route: lanes beside every foreign run", () => {
  // The only gap through the wall is lined with other sources' vertical runs.
  const wall = [box("l", 0, 150, 190, 40), box("r", 230, 150, 170, 40)];
  const runs = [192, 195, 225, 228];
  const foreign: ForeignLanes = { horizontal: [], vertical: runs.map(at => ({ at, lo: 0, hi: 400 })) };
  const start = { x: 100, y: 0 }, goal = { x: 100, y: 300 };

  it("finds a lane between the foreign runs only when asked to look beside every one", () => {
    expect(orthogonalRoute(start, goal, wall, 400, foreign)).toBeNull();
    const path = orthogonalRoute(start, goal, wall, 400, foreign, { everyLane: true })!;
    expect(rectilinear(path)).toBe(true);
    expect(path.at(-1)).toEqual(goal);
    const verticals = path.flatMap((p, i) => i > 0 && p.x === path[i - 1].x && p.y !== path[i - 1].y ? [p.x] : []);
    expect(verticals.some(x => x > 190 && x < 230)).toBe(true);
    for (const x of verticals) for (const at of runs) expect(Math.abs(x - at)).toBeGreaterThan(0.5);
  });
});
