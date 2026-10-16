/**
 * Where lines of different sources read as joined though they are not.
 *
 * Two lines crossing steeply read as crossing; anywhere else, coming closer than a few pixels
 * reads as touching, and touching reads as a connection. Small crossing angles and near misses
 * are what makes a drawn graph misread (Huang, Hong and Eades 2008, "Effects of crossing angles"),
 * and orthogonal routers keep edge-to-edge and edge-to-node spacing for the same reason (ELK's
 * `spacing.edgeEdge` and `spacing.edgeNode`; libavoid's shape buffer and nudging distance). So a
 * route's line keeps every other source's line off:
 * - its ports, where it meets a tile (a stem leaving it, an arrowhead arriving), by `PORT_BERTH`:
 *   a line crossing a stem that close to its tile makes the stem seem to branch off that line;
 * - its corners (sharp or rounded) and its free ends (where a trunk parts into branches) by
 *   `CORNER_BERTH`: a line touching a turn or a fork reads as joining it there;
 * and no other source's line runs within `LANE_SEPARATION` of a slanted (curved) stretch of it
 * for longer than `SHALLOW_RUN`: a crossing that shallow reads as the lines merging.
 *
 * Parallel runs and junction dots have their own rules (`sharedLanePx`'s near lanes, a hard gate
 * of `layout-quality`, and `JUNCTION_BERTH`); the inputs of one junction meet at its dot by
 * design, so they are exempt from each other. The incremental router keeps these rules as it
 * builds routes (`band-incremental`): shallow runs always, touches whenever some placement avoids
 * them. The downward router keeps ports and corners apart through its tracks (`layout.ts`).
 *
 * Tiles are kept off the same way: a line drawn on or right beside a tile's border reads as part
 * of its outline, so as that tile's input or output (ELK's `spacing.edgeNode`, libavoid's shape
 * buffer). A route keeps `TILE_GRAZE` from every tile but where it leaves its own at a port
 * (`grazesTile`).
 */
import type { PlacedNode, PlacedRoute } from "./layout";
import { ARROW, LANE_SEPARATION, PORT_BERTH } from "./metrics";
import type { Point } from "./path-sampling";

type Segment = readonly [Point, Point];

/** A point other sources' lines keep `radius` from. */
export interface Berth { readonly x: number; readonly y: number; readonly radius: number }

/** Distance other sources keep from a route's corners and free ends (and its corners from them). */
export const CORNER_BERTH = LANE_SEPARATION;
/** A turn at least this sharp (radians), over `CORNER_WINDOW` either side, is a corner. */
const CORNER_TURN = Math.PI / 6;
/** Path length either side of a point over which its turn is measured: rounded corners count. */
const CORNER_WINDOW = LANE_SEPARATION;
/**
 * Longest stretch a line may run within `LANE_SEPARATION` of another source's slanted piece:
 * a square crossing's own neighbourhood (twice the separation) and an arrowhead's length. Two
 * lines crossing at angle θ stay that close for about 2·LANE_SEPARATION / sin θ, so crossings
 * below about 25° exceed it.
 */
export const SHALLOW_RUN = 2 * LANE_SEPARATION + ARROW.length;

/**
 * Rounding allowance of a berth: a line exactly `radius` from its point keeps it, as lanes
 * exactly `LANE_SEPARATION` apart stay apart (`NEAR_LANE`).
 */
export const BERTH_SLACK = .01;

/**
 * The closest a line passes a tile it does not meet at a port: centres 2 px apart leave a gap
 * between a plain stroke (1.35 px) and a tile's border (1 px), which a highlighted stroke
 * (2.3 px) just closes; the visibility grid keeps the same clearance (`orthogonalRoute`).
 * Closer, the line runs on the tile's border.
 */
export const TILE_GRAZE = 2;

/** Distance between the segment and a tile's rectangle (0 when they meet; NaN for malformed input). */
export function distanceToTile([a, b]: Segment, n: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): number {
  const right = n.x + n.width, bottom = n.y + n.height;
  if (!Number.isFinite(a.x + a.y + b.x + b.y + right + bottom + n.x + n.y)) return NaN;
  const toPoint = (p: Point) => Math.hypot(Math.max(n.x - p.x, 0, p.x - right), Math.max(n.y - p.y, 0, p.y - bottom));
  if (toPoint(a) === 0 || toPoint(b) === 0 || clipsRect(a, b, n.x, n.y, right, bottom)) return 0;
  return Math.min(toPoint(a), toPoint(b), distanceToSegment([a, b], { x: n.x, y: n.y }), distanceToSegment([a, b], { x: right, y: n.y }),
    distanceToSegment([a, b], { x: n.x, y: bottom }), distanceToSegment([a, b], { x: right, y: bottom }));
}

/** Whether the segment from `a` to `b` passes through the closed rectangle (Liang–Barsky clipping). */
function clipsRect(a: Point, b: Point, left: number, top: number, right: number, bottom: number): boolean {
  let lo = 0, hi = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - left], [dx, right - a.x], [-dy, a.y - top], [dy, bottom - a.y]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return false;
  }
  return true;
}

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * Whether a route drawn through `ss` comes within `TILE_GRAZE` of the tile, other than where it
 * leaves it: a route that starts on the tile's outline (`leaves`) meets it along the run it
 * leaves by (`leavingRunFrom`). Malformed points never graze.
 */
export function grazesTile(ss: readonly Segment[], tile: Rect, leaves = false): boolean {
  for (let i = leaves ? leavingRunFrom(ss, tile) : 0; i < ss.length; i++) {
    const d = distanceToTile(ss[i], tile);
    if (d < TILE_GRAZE - 1e-9) return true;
  }
  return false;
}

/**
 * How many of a route's first segments form the run it leaves its start along: the pieces up to
 * its first turn, zero-length ones included (a straight route drawn through a bend that does not
 * turn is one run). Along it the route moves straight away from where it started.
 */
export function leavingRun(ss: readonly Segment[]): number {
  let i = 0, dx = 0, dy = 0;
  const origin = ss[0]?.[0];
  if (!origin) return 0;
  for (; i < ss.length; i++) {
    const [a, b] = ss[i], ex = b.x - a.x, ey = b.y - a.y, length = Math.hypot(ex, ey);
    if (!(length >= 0)) break;
    if (length < 1e-9) continue;
    if (!dx && !dy) { dx = ex / length; dy = ey / length; continue; }
    // The piece continues the run: it heads the same way, on the run's line.
    const across = Math.abs((b.x - origin.x) * dy - (b.y - origin.y) * dx) + Math.abs((a.x - origin.x) * dy - (a.y - origin.y) * dx);
    if (!(ex * dx + ey * dy > 0) || !(across < 1e-3)) break;
  }
  return i;
}

/**
 * How many of a route's first segments it leaves `tile` by: its first run (`leavingRun`) when the
 * route starts on the tile's outline and that run heads away from the tile; otherwise none. A
 * first run heading along the outline lies on the tile's border: it does not leave the tile.
 */
export function leavingRunFrom(ss: readonly Segment[], tile: Rect): number {
  const start = ss[0]?.[0];
  if (!start || !onOutline(tile, start)) return 0;
  const run = leavingRun(ss);
  for (let i = 0; i < run; i++) {
    const [a, b] = ss[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > 1e-9)) continue;
    // A step along the run from where it starts: leaving, the step takes it that far off the tile.
    const step = Math.min(1, length), q = { x: a.x + (b.x - a.x) / length * step, y: a.y + (b.y - a.y) / length * step };
    return distanceToTile([q, q], tile) >= step / 2 ? run : 0;
  }
  return run;
}

/** Distance from `p` to the segment. */
export function distanceToSegment([a, b]: Segment, p: { readonly x: number; readonly y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Whether the segment enters the berth: passes closer than its radius (less `BERTH_SLACK`) to its point. */
export function entersBerth([a, b]: Segment, berth: Berth): boolean {
  const reach = berth.radius - BERTH_SLACK;
  if (!(reach > 0)) return false;
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((berth.x - a.x) * dx + (berth.y - a.y) * dy) / length)) : 0;
  const ex = a.x + t * dx - berth.x, ey = a.y + t * dy - berth.y;
  return ex * ex + ey * ey < reach * reach;
}

/**
 * The corners of a line drawn through consecutive segments: interior points where its direction
 * over `CORNER_WINDOW` before differs from that over `CORNER_WINDOW` after by `CORNER_TURN` or
 * more. Sharp turns and rounded ones (a flattened curve) both count; a long gentle curve does not.
 */
export function cornersOf(ss: readonly Segment[]): Point[] {
  if (ss.length < 2) return [];
  const points: Point[] = [ss[0][0]];
  for (const [, b] of ss) points.push(b);
  const along: number[] = [0];
  for (let k = 1; k < points.length; k++) along.push(along[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y));
  const out: Point[] = [];
  const cos = Math.cos(CORNER_TURN);
  for (let k = 1, i = 0, j = 1; k < points.length - 1; k++) {
    while (i + 1 < k && along[k] - along[i + 1] >= CORNER_WINDOW) i++;
    if (j <= k) j = k + 1;
    while (j < points.length - 1 && along[j] - along[k] < CORNER_WINDOW) j++;
    const ux = points[k].x - points[i].x, uy = points[k].y - points[i].y, vx = points[j].x - points[k].x, vy = points[j].y - points[k].y;
    const u = Math.hypot(ux, uy), v = Math.hypot(vx, vy);
    if (u > 1e-9 && v > 1e-9 && (ux * vx + uy * vy) / (u * v) <= cos) out.push(points[k]);
  }
  return out;
}

/** Whether `p` lies on the tile's outline (within half a pixel). */
function onOutline(tile: Rect | undefined, p: Point): boolean {
  if (!tile) return false;
  const inX = p.x >= tile.x - .5 && p.x <= tile.x + tile.width + .5, inY = p.y >= tile.y - .5 && p.y <= tile.y + tile.height + .5;
  return (inX && (Math.abs(p.y - tile.y) <= .5 || Math.abs(p.y - tile.y - tile.height) <= .5))
    || (inY && (Math.abs(p.x - tile.x) <= .5 || Math.abs(p.x - tile.x - tile.width) <= .5));
}

/** The tip of the arrowhead drawn on the end of `last` (the route's final segment). */
export function arrowTip([a, b]: Segment): Point | null {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return length > 0 ? { x: b.x + (b.x - a.x) / length * ARROW.length, y: b.y + (b.y - a.y) / length * ARROW.length } : null;
}

/** How a route's ends keep other sources off: the berths at its first and last point (0 at a junction's dot), and whether it ends in an arrowhead. */
export interface Ends { readonly start: number; readonly end: number; readonly arrow?: boolean }
/** A route from a tile's port into a junction's dot. */
export const INTO_JUNCTION: Ends = Object.freeze({ start: PORT_BERTH, end: 0 });
/** A route from a tile's port into another tile, ending in an arrowhead. */
export const INTO_TILE: Ends = Object.freeze({ start: PORT_BERTH, end: PORT_BERTH, arrow: true });

/**
 * A drawn route's ends: a start on its tile's outline is a port, elsewhere a free end (a branch
 * leaving its trunk); an arrowhead's end is a port, a trunk's end short of any tile is free; a
 * junction's dot keeps its own berth.
 */
export function routeEnds(route: PlacedRoute, ss: readonly Segment[], nodes: ReadonlyMap<string, PlacedNode>): Ends {
  if (!ss.length) return { start: 0, end: 0 };
  const start = route.from.kind === "junction" ? 0 : onOutline(nodes.get(route.from.id), ss[0][0]) ? PORT_BERTH : CORNER_BERTH;
  const end = route.to.kind === "junction" ? 0 : route.terminal ? PORT_BERTH : CORNER_BERTH;
  return { start, end, arrow: route.to.kind === "node" && route.terminal };
}

/** The berths of a line drawn through `ss` with `ends`: its ends (and arrowhead tip) and its corners. */
export function berthsOf(ss: readonly Segment[], ends: Ends): Berth[] {
  if (!ss.length) return [];
  const out: Berth[] = [];
  const first = ss[0][0], last = ss[ss.length - 1][1];
  if (ends.start > 0) out.push({ x: first.x, y: first.y, radius: ends.start });
  if (ends.end > 0) {
    out.push({ x: last.x, y: last.y, radius: ends.end });
    const tip = ends.arrow ? arrowTip(ss[ss.length - 1]) : null;
    if (tip) out.push({ x: tip.x, y: tip.y, radius: ends.end });
  }
  for (const corner of cornersOf(ss)) out.push({ x: corner.x, y: corner.y, radius: CORNER_BERTH });
  return out;
}

/** Whether a segment is axis-parallel: horizontal (1), vertical (2), or neither (0). */
export function axisOf([a, b]: Segment): 0 | 1 | 2 {
  return a.y === b.y && a.x !== b.x ? 1 : a.x === b.x && a.y !== b.y ? 2 : 0;
}

/**
 * Length along axis-parallel `s` within `LANE_SEPARATION` of `t`, a slanted piece within 45° of
 * `s`'s axis (otherwise zero: steeper pieces cross it, and parallel runs are the near-lane rule's).
 */
export function shallowRun(s: Segment, t: Segment): number {
  const axis = axisOf(s);
  if (!axis) return 0;
  // Work in coordinates where `s` is horizontal: u along it, w across.
  const u = (p: Point) => axis === 1 ? p.x : p.y, w = (p: Point) => axis === 1 ? p.y : p.x;
  const [a, b] = t, du = u(b) - u(a), dw = w(b) - w(a);
  if (!(Math.abs(dw) > 1e-9) || !(Math.abs(du) > Math.abs(dw))) return 0;
  const level = w(s[0]), lo = Math.min(u(s[0]), u(s[1])), hi = Math.max(u(s[0]), u(s[1]));
  // Points of t's line lie within LANE_SEPARATION of s's line where |w - level| < LANE_SEPARATION / cos θ.
  const slope = dw / du, reach = LANE_SEPARATION * Math.hypot(1, slope);
  // w(t at u) = w(a) + slope (u - u(a)); solve |w - level| < reach for u.
  const u1 = u(a) + (level - reach - w(a)) / slope, u2 = u(a) + (level + reach - w(a)) / slope;
  const from = Math.max(Math.min(u1, u2), Math.min(u(a), u(b)), lo), to = Math.min(Math.max(u1, u2), Math.max(u(a), u(b)), hi);
  return Math.max(0, to - from);
}
