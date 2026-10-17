/** Fillets within a channel's reserved tracks and lanes. No new path representation. */
import { roundedStem } from './band-geometry';
import { pathTokens } from './path-data';
import { distanceToTile, distanceToSegment } from './route-contacts';
import { crossing, type Segment } from './layout-quality';
import type { Point } from './path-sampling';

const rect = (a: Point, b: Point) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

type Cubic = readonly [Point, Point, Point, Point];
export type ChannelInk = Segment | Cubic;
const bounds = (points: readonly Point[]) => {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x); y = Math.min(y, p.y);
    right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  return { x, y, right, bottom };
};
const boxDistance = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) => Math.hypot(Math.max(0, a.x - b.right, b.x - a.right), Math.max(0, a.y - b.bottom, b.y - a.bottom));
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const chord = (p: ChannelInk): Segment => [p[0], p[p.length - 1]];
const error = (p: ChannelInk): number => {
  if (p.length === 2) return 0;
  const line = chord(p);
  return Math.max(distanceToSegment(line, p[1]), distanceToSegment(line, p[2]));
};
const segmentDistance = (a: Segment, b: Segment): number => crossing(a, b) ? 0
  : Math.min(distanceToSegment(a, b[0]), distanceToSegment(a, b[1]), distanceToSegment(b, a[0]), distanceToSegment(b, a[1]));
function split(p: Cubic): readonly [Cubic, Cubic] {
  const a = mid(p[0], p[1]), b = mid(p[1], p[2]), c = mid(p[2], p[3]), d = mid(a, b), e = mid(b, c), f = mid(d, e);
  return [[p[0], a, d, f], [f, e, c, p[3]]];
}

/** Native M/L/C primitives retain foreign curves exactly, including their control points. */
export function channelInk(path: string): ChannelInk[] {
  const tokens = pathTokens(path), out: ChannelInk[] = [];
  let i = 0, from: Point = { x: 0, y: 0 };
  const point = (): Point => ({ x: tokens[i++] as number, y: tokens[i++] as number });
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') from = point();
    else if (command === 'L') { const to = point(); out.push([from, to]); from = to; }
    else if (command === 'C') { const a = point(), b = point(), to = point(); out.push([from, a, b, to]); from = to; }
  }
  return out;
}

/** An upper bound within 1e-7px of the sharp segment's true distance to foreign ink. */
function sharpDistance(segment: Segment, ink: ChannelInk): number {
  if (ink.length === 2) return segmentDistance(segment, ink);
  const segmentBounds = bounds(segment);
  let best = Math.min(distanceToSegment(segment, ink[0]), distanceToSegment(segment, ink[3]));
  const visit = (p: Cubic, depth: number): void => {
    if (boxDistance(segmentBounds, bounds(p)) >= best - 1e-7 || segmentDistance(segment, chord(p)) - error(p) >= best - 1e-7 || depth >= 28) return;
    const [left, right] = split(p);
    best = Math.min(best, distanceToSegment(segment, left[3]));
    visit(left, depth + 1); visit(right, depth + 1);
  };
  visit(ink, 0);
  return best;
}

/** Certify the complete cubics using chord error envelopes, never sampled polylines. */
function clearsCurve(curve: Cubic, ink: ChannelInk, clearance: number): boolean {
  let budget = 4096;
  const visit = (a: ChannelInk, b: ChannelInk, depth: number): boolean => {
    if (boxDistance(bounds(a), bounds(b)) >= clearance - 1e-7) return true;
    // A point on the curve inside the forbidden clearance proves rejection just as
    // a separated hull proves admission. Do not subdivide an already known collision.
    const middle = (p: ChannelInk): Point => p.length === 2 ? mid(p[0], p[1]) : {
      x: (p[0].x + 3 * p[1].x + 3 * p[2].x + p[3].x) / 8,
      y: (p[0].y + 3 * p[1].y + 3 * p[2].y + p[3].y) / 8,
    };
    const am = middle(a), bm = middle(b), threshold = clearance - 1e-7;
    if (b.length === 2 && [a[0], am, a[a.length - 1]].some(p => distanceToSegment(b, p) < threshold)
      || a.length === 2 && [b[0], bm, b[b.length - 1]].some(p => distanceToSegment(a, p) < threshold)
      || Math.hypot(am.x - bm.x, am.y - bm.y) < threshold) return false;
    const ae = error(a), be = error(b);
    if (segmentDistance(chord(a), chord(b)) - ae - be >= clearance - 1e-7) return true;
    if (a.length === 2 && b.length === 2 || depth >= 32 || --budget <= 0) return false;
    if (a.length === 4 && (b.length === 2 || ae >= be)) {
      const [left, right] = split(a);
      return visit(left, b, depth + 1) && visit(right, b, depth + 1);
    }
    const [left, right] = split(b as Cubic);
    return visit(a, left, depth + 1) && visit(a, right, depth + 1);
  };
  return visit(curve, ink, 0);
}

/** Largest fillet preserving sharp-run clearance, within its track and half-run bounds.
 * The square is a cheap sufficient test; tight turns certify the actual quarter cubic. */
export function channelCornerRadius(before: Point, corner: Point, after: Point, foreign: readonly ChannelInk[], cap: number): number {
  const incoming = Math.hypot(corner.x - before.x, corner.y - before.y), outgoing = Math.hypot(after.x - corner.x, after.y - corner.y);
  const limit = Math.min(6, cap, incoming / 2, outgoing / 2);
  if (!(limit > 0)) return 0;
  const ux = (corner.x - before.x) / incoming, uy = (corner.y - before.y) / incoming;
  const vx = (after.x - corner.x) / outgoing, vy = (after.y - corner.y) / outgoing;
  const envelope = bounds([{ x: corner.x - ux * limit, y: corner.y - uy * limit }, { x: corner.x + vx * limit, y: corner.y + vy * limit }]);
  const incomingRun: Segment = [before, corner], outgoingRun: Segment = [corner, after];
  // Endpoints belong to the foreign curve, so their nearest distance is an upper
  // bound on the sharp runs' required clearance.
  const clearanceUpperBound = (ink: ChannelInk): number => {
    const last = ink[ink.length - 1];
    return Math.max(3, Math.min(distanceToSegment(incomingRun, ink[0]), distanceToSegment(incomingRun, last),
      distanceToSegment(outgoingRun, ink[0]), distanceToSegment(outgoingRun, last)));
  };
  const nearby = foreign.filter(ink => {
    const inkBounds = bounds(ink), separation = boxDistance(envelope, inkBounds);
    // In either outside halfplane, projection onto an original leg is always
    // closer than the fillet. The control hull proves this for the whole cubic.
    if (separation >= 3 - 1e-7 && (ink.every(p => (p.x - corner.x) * vx + (p.y - corner.y) * vy <= 0)
      || ink.every(p => (p.x - corner.x) * ux + (p.y - corner.y) * uy >= 0))) return false;
    return separation < clearanceUpperBound(ink) - 1e-7;
  });
  const limitA = { x: corner.x - ux * limit, y: corner.y - uy * limit }, limitB = { x: corner.x + vx * limit, y: corner.y + vy * limit }, k = .5522847498;
  const limitCurve: Cubic = [limitA, { x: limitA.x + ux * limit * k, y: limitA.y + uy * limit * k },
    { x: limitB.x - vx * limit * k, y: limitB.y - vy * limit * k }, limitB], limitSquare = rect(limitA, limitB);
  // Proving the maximum against this stricter clearance avoids finding exact
  // nearest points on foreign curves. Uncertain cases use the full search below.
  if (nearby.every(ink => {
    const upper = clearanceUpperBound(ink);
    return (ink.length === 2 && distanceToTile(ink, limitSquare) >= upper - 1e-7) || clearsCurve(limitCurve, ink, upper);
  })) return limit;
  const constraints = nearby.map(ink => ({ ink, distance: Math.max(3, Math.min(sharpDistance(incomingRun, ink), sharpDistance(outgoingRun, ink))) }))
    .filter(({ ink, distance }) => sharpDistance([corner, corner], ink) < distance + limit * Math.SQRT2);
  const fits = (radius: number) => {
    const a = { x: corner.x - ux * radius, y: corner.y - uy * radius }, b = { x: corner.x + vx * radius, y: corner.y + vy * radius };
    const square = rect(a, b), k = .5522847498;
    const curve: Cubic = [a, { x: a.x + ux * radius * k, y: a.y + uy * radius * k }, { x: b.x - vx * radius * k, y: b.y - vy * radius * k }, b];
    return constraints.every(({ ink, distance }) => (ink.length === 2 && distanceToTile(ink, square) >= distance - 1e-7) || clearsCurve(curve, ink, distance));
  };
  if (fits(limit)) return limit;
  let low = 0, high = limit;
  for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
  return low < 1e-6 ? 0 : low;
}

/** Round only orthogonal M/L runs. Existing swap/fan cubics remain ordinary cubics. */
export function roundChannelPath(path: string, foreign: readonly ChannelInk[], capAt: (corner: Point) => number): string {
  const tokens = pathTokens(path);
  let points: Point[] = [], output = '';
  const flush = () => {
    if (!points.length) return;
    if (points.length === 1) {
      if (!output) output = `M${points[0].x} ${points[0].y}`;
      return;
    }
    const rounded = roundedStem(points, (before, corner, after) => channelCornerRadius(before, corner, after, foreign, capAt(corner)));
    output += output ? rounded.replace(/^M[^LC]*/, '') : rounded;
    points = [points.at(-1)!];
  };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    if (command === 'M' || command === 'L') points.push({ x: tokens[i++] as number, y: tokens[i++] as number });
    else if (command === 'C') {
      flush();
      const values = tokens.slice(i, i + 6) as number[]; i += 6;
      output += ` C${values.join(' ')}`;
      points = [{ x: values[4], y: values[5] }];
    }
  }
  flush();
  return output;
}
