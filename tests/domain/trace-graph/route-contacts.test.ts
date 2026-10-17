/**
 * The rules for where lines of different sources read as joined (`route-contacts`): berths kept
 * from ports, corners and forks, and the length a line may run beside another's curve.
 */
import { describe, expect, it } from "vitest";
import {
  arrowTip, axisOf, BERTH_SLACK, berthsOf, CORNER_BERTH, cornersOf, distanceToSegment, distanceToTile, entersBerth, grazesTile, INTO_JUNCTION, INTO_TILE,
  leavingRun, leavingRunFrom, routeEnds, shallowRun, SHALLOW_RUN, TILE_GRAZE,
} from "$lib/domain/trace-graph/route-contacts";
import type { PlacedNode, PlacedRoute } from "$lib/domain/trace-graph/layout";
import { ARROW, LANE_SEPARATION, PORT_BERTH } from "$lib/domain/trace-graph/metrics";

type P = { x: number; y: number };
const p = (x: number, y: number): P => ({ x, y });
const polyline = (...points: P[]) => points.slice(1).map((b, i) => [points[i], b] as const);
/** A quarter circle of `radius` from (0, 0) heading right to (radius, radius) heading down, in `steps` chords. */
const roundedCorner = (radius: number, steps: number) =>
  Array.from({ length: steps + 1 }, (_, i) => { const a = Math.PI / 2 * i / steps; return p(radius * Math.sin(a), radius - radius * Math.cos(a)); });
/** Line through (0, 0) at `degrees` to the x axis, `half` px either side along x. */
const slanted = (degrees: number, half = 100) => { const k = Math.tan(degrees * Math.PI / 180); return [p(-half, -k * half), p(half, k * half)] as const; };

describe("distanceToSegment and entersBerth", () => {
  it("measures to the nearest point of the segment, ends included", () => {
    expect(distanceToSegment([p(0, 0), p(10, 0)], p(5, 3))).toBeCloseTo(3);
    expect(distanceToSegment([p(0, 0), p(10, 0)], p(13, 4))).toBeCloseTo(5);
    expect(distanceToSegment([p(2, 2), p(2, 2)], p(5, 6))).toBeCloseTo(5);
  });

  it("a line exactly a berth's radius away keeps the berth; closer, it enters", () => {
    const berth = { x: 5, y: 0, radius: 3 };
    expect(entersBerth([p(0, 3), p(10, 3)], berth)).toBe(false);
    expect(entersBerth([p(0, 3 - BERTH_SLACK * 2), p(10, 3 - BERTH_SLACK * 2)], berth)).toBe(true);
    expect(entersBerth([p(0, -2.5), p(10, -2.5)], berth)).toBe(true);
    // Past the segment's end, the end point counts.
    expect(entersBerth([p(-10, 0), p(2.5, 0)], berth)).toBe(true);
    expect(entersBerth([p(-10, 0), p(1.5, 0)], berth)).toBe(false);
  });

  it("malformed input never enters a berth", () => {
    expect(entersBerth([p(NaN, 0), p(10, 0)], { x: 5, y: 0, radius: 3 })).toBe(false);
    expect(entersBerth([p(0, 0), p(10, 0)], { x: 5, y: 0, radius: 0 })).toBe(false);
    expect(entersBerth([p(0, 0), p(10, 0)], { x: 5, y: 0, radius: -1 })).toBe(false);
  });
});

describe("cornersOf", () => {
  it("finds the elbow of a sharp turn, and nothing on a straight line", () => {
    expect(cornersOf(polyline(p(0, 0), p(20, 0), p(20, 20)))).toEqual([p(20, 0)]);
    expect(cornersOf(polyline(p(0, 0), p(10, 0), p(20, 0), p(30, 0)))).toEqual([]);
  });

  it("finds a rounded corner drawn as a curve, but not a long gentle curve", () => {
    const tight = cornersOf(polyline(...roundedCorner(2, 8)));
    expect(tight.length).toBeGreaterThan(0);
    for (const corner of tight) expect(Math.hypot(corner.x - 2, corner.y - 0)).toBeLessThan(3);
    expect(cornersOf(polyline(...roundedCorner(200, 64)))).toEqual([]);
  });

  it("a single segment or none has no corners", () => {
    expect(cornersOf([])).toEqual([]);
    expect(cornersOf(polyline(p(0, 0), p(10, 10)))).toEqual([]);
  });
});

describe("arrowTip", () => {
  it("lies an arrowhead beyond the route's end, along its final segment", () => {
    expect(arrowTip([p(5, 0), p(5, 10)])).toEqual(p(5, 10 + ARROW.length));
    expect(arrowTip([p(0, 7), p(4, 7)])).toEqual(p(4 + ARROW.length, 7));
  });

  it("a zero-length final segment has no direction, so no tip", () => {
    expect(arrowTip([p(3, 3), p(3, 3)])).toBeNull();
  });
});

describe("routeEnds and berthsOf", () => {
  const tile: PlacedNode = { key: "a", x: 0, y: 0, width: 100, height: 80, band: 0, row: 0 };
  const nodes = new Map([["a", tile], ["b", { ...tile, key: "b", y: 200 }]]);
  const route = (from: PlacedRoute["from"], to: PlacedRoute["to"], terminal: boolean): PlacedRoute => ({ id: "r", from, to, consumers: [], path: "", terminal });
  const stem = polyline(p(50, 80), p(50, 120), p(50, 192));

  it("a route leaving its tile's edge starts at a port; one starting off it (a branch leaving its trunk) at a free end", () => {
    expect(routeEnds(route({ kind: "node", id: "a" }, { kind: "node", id: "b" }, true), stem, nodes, new Map())).toEqual({ start: PORT_BERTH, end: PORT_BERTH, arrow: true });
    const branch = polyline(p(50, 120), p(80, 120), p(80, 192));
    expect(routeEnds(route({ kind: "node", id: "a" }, { kind: "node", id: "b" }, true), branch, nodes, new Map()).start).toBe(CORNER_BERTH);
  });

  it("a junction's dot keeps its own berth, and a trunk ending short of any tile ends free", () => {
    expect(routeEnds(route({ kind: "node", id: "a" }, { kind: "junction", id: "j" }, false), stem, nodes, new Map([['j',stem[stem.length-1][1]]]))).toEqual({ start: PORT_BERTH, end: 0, arrow: false });
    expect(routeEnds(route({ kind: "junction", id: "j" }, { kind: "node", id: "b" }, true), stem, nodes, new Map([["j",stem[0][0]]]))).toEqual({ start: 0, end: PORT_BERTH, arrow: true });
    expect(routeEnds(route({ kind: "node", id: "a" }, { kind: "node", id: "b" }, false), stem, nodes, new Map()).end).toBe(CORNER_BERTH);
    expect(routeEnds(route({ kind: "node", id: "a" }, { kind: "node", id: "b" }, true), [], nodes, new Map())).toEqual({ start: 0, end: 0 });
  });

  it("a route's berths are its ends as given, its arrowhead's tip, and its corners", () => {
    const into = polyline(p(50, 80), p(50, 100), p(150, 100), p(150, 192));
    const berths = berthsOf(into, INTO_TILE);
    expect(berths).toEqual(expect.arrayContaining([
      { x: 50, y: 80, radius: PORT_BERTH }, { x: 150, y: 192, radius: CORNER_BERTH }, { x: 150, y: 192 + ARROW.length, radius: PORT_BERTH },
      { x: 50, y: 100, radius: CORNER_BERTH }, { x: 150, y: 100, radius: CORNER_BERTH },
    ]));
    expect(berths).toHaveLength(5);
    // Into a junction: the dot keeps its own berth, and there is no arrowhead.
    expect(berthsOf(into, INTO_JUNCTION)).toHaveLength(3);
    expect(berthsOf([], INTO_TILE)).toEqual([]);
  });
});

describe("axisOf and shallowRun", () => {
  it("tells horizontal, vertical and slanted segments apart", () => {
    expect(axisOf([p(0, 5), p(9, 5)])).toBe(1);
    expect(axisOf([p(5, 0), p(5, 9)])).toBe(2);
    expect(axisOf([p(0, 0), p(9, 1)])).toBe(0);
    expect(axisOf([p(3, 3), p(3, 3)])).toBe(0);
  });

  it("a crossing shallower than about 25° runs too long beside the line; a steeper one does not", () => {
    const axis = [p(-100, 0), p(100, 0)] as const;
    expect(shallowRun(axis, slanted(15))).toBeGreaterThan(SHALLOW_RUN);
    expect(shallowRun(axis, slanted(35))).toBeLessThan(SHALLOW_RUN);
    // Points of a line within LANE_SEPARATION of another crossing it at θ span 2·LANE_SEPARATION / sin θ.
    expect(shallowRun(axis, slanted(10))).toBeCloseTo(2 * LANE_SEPARATION / Math.sin(10 * Math.PI / 180), 6);
  });

  it("is the same for a vertical line and a near-vertical curve", () => {
    const k = Math.tan(10 * Math.PI / 180);
    expect(shallowRun([p(0, -100), p(0, 100)], [p(-k * 100, -100), p(k * 100, 100)])).toBeCloseTo(shallowRun([p(-100, 0), p(100, 0)], slanted(10)), 6);
  });

  it("counts only what both pieces span, and nothing for parallel, steep or distant pieces", () => {
    const axis = [p(0, 0), p(10, 0)] as const;
    expect(shallowRun(axis, slanted(10))).toBeCloseTo(10, 6);
    expect(shallowRun(axis, [p(0, 2), p(10, 2)])).toBe(0);
    expect(shallowRun(axis, slanted(60))).toBe(0);
    expect(shallowRun(axis, [p(0, 50), p(10, 51)])).toBe(0);
    expect(shallowRun([p(0, 0), p(1, 1)], slanted(10))).toBe(0);
  });
});

describe("tile clearance (grazesTile)", () => {
  const tile = { x: 100, y: 100, width: 80, height: 60 };

  it("measures a segment's distance to a tile's rectangle, zero where they meet", () => {
    expect(distanceToTile([p(0, 50), p(300, 50)], tile)).toBeCloseTo(50);
    expect(distanceToTile([p(190, 0), p(190, 300)], tile)).toBeCloseTo(10);
    // Past a corner, the corner counts.
    expect(distanceToTile([p(183, 163), p(200, 200)], tile)).toBeCloseTo(Math.hypot(3, 3));
    expect(distanceToTile([p(0, 160), p(300, 160)], tile)).toBe(0);
    expect(distanceToTile([p(0, 0), p(300, 300)], tile)).toBe(0);
    expect(distanceToTile([p(140, 130), p(150, 130)], tile)).toBe(0);
  });

  it("a line running a pixel off a tile's border grazes it; TILE_GRAZE off, it does not", () => {
    expect(grazesTile(polyline(p(0, 161), p(300, 161)), tile)).toBe(true);
    expect(grazesTile(polyline(p(0, 160 + TILE_GRAZE), p(300, 160 + TILE_GRAZE)), tile)).toBe(false);
    expect(grazesTile(polyline(p(181, 0), p(181, 300)), tile)).toBe(true);
    expect(grazesTile(polyline(p(0, 0), p(10, 10)), tile)).toBe(false);
  });

  it("a route leaving the tile's port straight away does not graze it, through bends that do not turn", () => {
    // Out of the right port, through a lane column that turns nowhere (a zero-length piece), on to the next tile.
    const straight = polyline(p(180, 130), p(181.5, 130), p(181.5, 130), p(200, 130));
    expect(leavingRun(straight)).toBe(3);
    expect(grazesTile(straight, tile, true)).toBe(false);
    // Not leaving from the tile (`leaves` unset), the same line meets it.
    expect(grazesTile(straight, tile)).toBe(true);
    // Out of the right port, then down along the tile's right border: the run along it grazes.
    const hugging = polyline(p(180, 130), p(181.5, 130), p(181.5, 240), p(140, 240));
    expect(leavingRun(hugging)).toBe(1);
    expect(grazesTile(hugging, tile, true)).toBe(true);
    // Doubling back along the run is a turn.
    expect(leavingRun(polyline(p(180, 130), p(190, 130), p(185, 130)))).toBe(1);
  });

  it("a first run along the tile's border does not leave it: it lies on the border", () => {
    // Out of the right port and straight down the right edge (a gutter or gap lane on the edge itself).
    const down = polyline(p(180, 130), p(180, 240), p(140, 240));
    expect(leavingRunFrom(down, tile)).toBe(0);
    expect(grazesTile(down, tile, true)).toBe(true);
    // The same through a zero-length piece at the port first.
    expect(grazesTile(polyline(p(180, 130), p(180, 130), p(180, 240)), tile, true)).toBe(true);
    // Leaving the bottom port straight down, or the right port straight right, it leaves the tile.
    expect(leavingRunFrom(polyline(p(140, 160), p(140, 200), p(300, 200)), tile)).toBe(1);
    expect(grazesTile(polyline(p(140, 160), p(140, 200), p(300, 200)), tile, true)).toBe(false);
    expect(leavingRunFrom(polyline(p(180, 130), p(181.5, 130), p(181.5, 130), p(200, 130)), tile)).toBe(3);
    // A route starting off the outline leaves nothing.
    expect(leavingRunFrom(polyline(p(190, 130), p(200, 130)), tile)).toBe(0);
    expect(leavingRunFrom([], tile)).toBe(0);
  });

  it("malformed or empty routes never graze", () => {
    expect(grazesTile([], tile)).toBe(false);
    expect(grazesTile(polyline(p(NaN, 130), p(200, 130)), tile)).toBe(false);
    expect(grazesTile(polyline(p(0, 161), p(300, 161)), { x: NaN, y: 100, width: 80, height: 60 })).toBe(false);
    expect(leavingRun([])).toBe(0);
  });
});

it('reserves both sharp corners of a short dogleg between long parallel runs', () => {
  const a = [{x:172,y:1231},{x:172,y:2189},{x:170,y:2189},{x:170,y:2424}];
  const b = [{x:175,y:1225},{x:175,y:2189},{x:173,y:2189},{x:173,y:2481}];
  const pieces = (points: typeof a) => points.slice(1).map((p,i)=>[points[i],p] as const);
  const berths = berthsOf(pieces(a), {start:0,end:0});
  expect(berths).toContainEqual({x:172,y:2189,radius:3});
  expect(pieces(b).some(s=>berths.some(berth=>entersBerth(s,berth)))).toBe(true);
});

it('permits transverse ink four pixels from an arrow base while protecting its tip', () => {
  const ss=polyline(p(0,0),p(100,0));
  const berths=berthsOf(ss,INTO_TILE);
  const allowed=polyline(p(96,-10),p(96,10))[0];
  const nearTip=polyline(p(113,-10),p(113,10))[0];
  expect(berths.some(b=>entersBerth(allowed,b))).toBe(false);
  expect(berths.some(b=>entersBerth(nearTip,b))).toBe(true);
});
