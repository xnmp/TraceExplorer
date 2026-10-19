import { layoutStage, countLayoutWork } from './layout-profile';
/** Native obstacle constraints for incremental topology construction. Completed
 * drawings still pass the unchanged independent geometry gates. */
import type { GraphLayout, PlacedNode, PlacedRoute } from './layout';
import { JUNCTION_CLEARANCE } from './connector-ink';
import { ARROW, LANE_SEPARATION, PORT_BERTH } from './metrics';
import { inReach } from './coordinate-space';

type Charge = (work: number, reason?: string) => void;
type Point = { readonly x: number; readonly y: number };
type Segment = { readonly a: Point; readonly b: Point; readonly route: PlacedRoute; readonly source: string; readonly error: number; readonly hull: Box; readonly primitive: Primitive };
type Primitive = readonly [Point, Point] | readonly [Point, Point, Point, Point];
type Probe = { readonly p: Point; readonly radius: number };
export interface NativeEndpointMask { readonly start: boolean; readonly end: boolean }
export interface NativeClearanceOptions {
  /** Construction-only cuts have no synthetic port at their open boundary. */
  readonly endpointMasks?: ReadonlyMap<PlacedRoute, NativeEndpointMask>;
}
const sourceOf = (r: PlacedRoute) => JSON.stringify([r.from.kind, r.from.id]);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (p: Point, a: Point, b: Point): number => {
  const x = b.x - a.x, y = b.y - a.y, square = x * x + y * y;
  const t = square ? Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / square)) : 0;
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y);
};

/** Independent strict reader. Cubic subdivision has a geometric error bound, not a sample count. */
function read(path: string, charge: Charge): { points: Point[]; errors: number[]; hulls: Box[]; corners: Point[]; primitives: Primitive[]; pieces: Primitive[] } | null {
  charge(path.length + 1, 'native path parsing');
  const tokens = path.match(/[MLC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  if (path.replace(/[MLC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/gi, '') || tokens[0] !== 'M') return null;
  let at = 0, last = '';
  const points: Point[] = [], errors: number[] = [], hulls: Box[] = [], corners: Point[] = [], primitives: Primitive[] = [], pieces: Primitive[] = [];
  const point = (): Point => ({ x: Number(tokens[at++]), y: Number(tokens[at++]) });
  const curve = (a: Point, b: Point, c: Point, d: Point, depth: number): boolean => {
    charge(1, 'native curve subdivision');
    if (a.x === d.x && a.y === d.y && (b.x !== a.x || b.y !== a.y || c.x !== a.x || c.y !== a.y)) return false;
    if (Math.max(distance(b, a, d), distance(c, a, d)) <= .025) { points.push(d); errors.push(.025); hulls.push(boxOf(a, b, c, d)); pieces.push([a, b, c, d]); return true; }
    if (depth >= 16) return false;
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    return curve(a, ab, abc, middle, depth + 1) && curve(middle, bcd, cd, d, depth + 1);
  };
  while (at < tokens.length) {
    charge(1, 'native primitive');
    const command = tokens[at++];
    if (command === 'M' && !points.length || command === 'L' && points.length) {
      const p = point();
      if (![p.x, p.y].every(inReach)) return null;
      if (command === 'L' && last === 'L' && points.length > 1) {
        const a = points.at(-2)!, b = points.at(-1)!;
        if (Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) > 1e-7) corners.push(b);
      }
      if (command === 'L') primitives.push([points.at(-1)!, p]);
      hulls.push(boxOf(points.at(-1) ?? p, p)); pieces.push([points.at(-1) ?? p, p]); points.push(p); errors.push(0);
    } else if (command === 'C' && points.length) {
      const a = points.at(-1)!, b = point(), c = point(), d = point();
      primitives.push([a, b, c, d]);
      if (![b.x, b.y, c.x, c.y, d.x, d.y].every(inReach) || !curve(points.at(-1)!, b, c, d, 0)) return null;
    } else return null;
    last = command;
  }
  charge(4 * points.length, 'native sample metadata');
  const keep = points.map((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const clean = points.filter((_, i) => keep[i]), cleanErrors = errors.filter((_, i) => keep[i]);
  for (let i = 1; i + 1 < clean.length; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y));
    if (dot < .98) corners.push(b);
  }
  return clean.length > 1 ? { points: clean, errors: cleanErrors, hulls: hulls.filter((_, i) => keep[i]), corners, primitives, pieces: pieces.filter((_, i) => keep[i]) } : null;
}

interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
/** A Bézier curve lies inside the convex hull of its control points. */
const boxOf = (...points: readonly Point[]): Box => ({ minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)),
  maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)) });
const boxDistance = (a: Box, b: Box): number => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minY - b.maxY, b.minY - a.maxY));
const pointBoxDistance = (p: Point, box: Box): number => Math.hypot(Math.max(0, box.minX - p.x, p.x - box.maxX), Math.max(0, box.minY - p.y, p.y - box.maxY));
/** Distance between complete line segments, including interior crossings. */
const segmentDistance = (a: Point, b: Point, c: Point, d: Point): number => {
  const x = b.x - a.x, y = b.y - a.y, u = d.x - c.x, v = d.y - c.y;
  const cross = x * v - y * u;
  if (cross) {
    const px = c.x - a.x, py = c.y - a.y;
    const t = (px * v - py * u) / cross, s = (px * y - py * x) / cross;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return 0;
  }
  return Math.min(distance(a, c, d), distance(b, c, d), distance(c, a, b), distance(d, a, b));
};
const chordError = (p: Primitive): number => p.length === 2 ? 0 : Math.max(distance(p[1], p[0], p[3]), distance(p[2], p[0], p[3]));
function halves(p: readonly [Point, Point, Point, Point]): readonly [Primitive, Primitive] {
  const [a, b, c, d] = p, ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
  const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
  return [[a, ab, abc, middle], [middle, bcd, cd, d]];
}

/** Prove clearance on the original local curves, never on their uncertain chords.
 * Every curve lies within its control hull and its chord's error envelope.
 * Subdivision exhaustion remains a rejection; only a separation proof admits ink.
 * The pair proof also protects interior-to-interior contacts between parallel curves.
 */
function separatedPrimitives(a: Primitive, b: Primitive, radius: number, charge: Charge): boolean {
  const endStage = layoutStage('curve-refinement'); try {

  let budget = 4096;
  const visit = (p: Primitive, q: Primitive, depth: number): boolean => {
    charge(1, 'native primitive clearance refinement');
    if (boxDistance(boxOf(...p), boxOf(...q)) >= radius) return true;
    const pe = chordError(p), qe = chordError(q);
    if (segmentDistance(p[0], p.at(-1)!, q[0], q.at(-1)!) - pe - qe >= radius) return true;
    if (p.length === 2 && q.length === 2 || depth >= 32 || --budget <= 0) return false;
    if (p.length === 4 && (q.length === 2 || pe >= qe)) {
      const [left, right] = halves(p);
      return visit(left, q, depth + 1) && visit(right, q, depth + 1);
    }
    const [left, right] = halves(q as readonly [Point, Point, Point, Point]);
    return visit(p, left, depth + 1) && visit(p, right, depth + 1);
  };
  return visit(a, b, 0);

  } finally { endStage(); }
}

interface Branch extends Box { readonly source: string | null; readonly entries?: readonly Segment[]; readonly left?: Branch; readonly right?: Branch }
function index(entries: Segment[], charge: Charge): Branch {
  charge(entries.length * (2 + Math.ceil(Math.log2(Math.max(1, entries.length)))), 'native clearance index');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let source: string | null = entries[0]?.source ?? null;
  for (const s of entries) {
    minX = Math.min(minX, s.a.x, s.b.x); minY = Math.min(minY, s.a.y, s.b.y);
    maxX = Math.max(maxX, s.a.x, s.b.x); maxY = Math.max(maxY, s.a.y, s.b.y);
    if (s.source !== source) source = null;
  }
  const box = { minX, minY, maxX, maxY, source };
  if (entries.length <= 8) return { ...box, entries };
  const axis = maxX - minX >= maxY - minY ? 'x' : 'y';
  entries.sort((a, b) => a.a[axis] + a.b[axis] - b.a[axis] - b.b[axis]);
  const middle = Math.floor(entries.length / 2);
  return { ...box, left: index(entries.slice(0, middle), charge), right: index(entries.slice(middle), charge) };
}

/** A declared junction permits contact only at that junction, never along the whole route. */
function intentional(layout: GraphLayout, a: PlacedRoute, b: PlacedRoute, p: Point): boolean {
  for (const end of [a.from, a.to]) {
    if (end.kind !== 'junction' || ![b.from, b.to].some(other => other.kind === 'junction' && other.id === end.id)) continue;
    const dot = layout.junctions.get(end.id);
    // The final fan occupies a berth on each axis. A disk clips its corners:
    // a valid approach at (3, -6) lies outside radius 6 before reaching the dot.
    // This remains local to the declared join; earlier shared runs still reject.
    if (dot && Math.abs(p.x - dot.x) <= PORT_BERTH && Math.abs(p.y - dot.y) <= PORT_BERTH) return true;
  }
  return false;
}

export function chargedNativeClearance(layout: GraphLayout, charge: Charge, options?: NativeClearanceOptions): string | null {
  return checkClearance(layout, charge, options);
}

/** Constructor-side native tile constraints. Charge the corresponding oracle
 * traversal in advance too; the independent gate remains unchanged. */
export function chargedNativeTileClearance(layout: GraphLayout, charge: Charge): { readonly ok: true; readonly samples: number }
  | { readonly ok: false; readonly failure: string } {
  const prepaid: Charge = (work, reason) => charge(2 * work, reason);
  prepaid(layout.routes.length + layout.nodes.size + 1, 'native tile admission input');
  let samples = 0;
  for (const route of layout.routes) {
    const parsed = read(route.path, prepaid);
    if (!parsed) return { ok: false, failure: 'invalid-path' };
    samples += parsed.points.length + Number(route.terminal);
    for (const primitive of parsed.primitives) for (const tile of layout.nodes.values()) {
      if (entersNativeTile(primitive, tile, prepaid)) return { ok: false, failure: 'route-through-tile' };
    }
  }
  return { ok: true, samples };
}

function entersNativeTile(primitive: Primitive, tile: PlacedNode, charge: Charge): boolean {
  const x0 = tile.x + 1e-7, x1 = tile.x + tile.width - 1e-7, y0 = tile.y + 1e-7, y1 = tile.y + tile.height - 1e-7;
  let budget = 4096;
  const visit = (p: Primitive, depth: number): boolean => {
    charge(1, 'native tile refinement and oracle');
    if (p.every(q => q.x <= x0) || p.every(q => q.x >= x1) || p.every(q => q.y <= y0) || p.every(q => q.y >= y1)) return false;
    if (p.length === 2) {
      const [a, b] = p;
      let lo = 0, hi = 1;
      for (const [start, delta, min, max] of [[a.x, b.x - a.x, x0, x1], [a.y, b.y - a.y, y0, y1]]) {
        if (!delta) { if (start <= min || start >= max) return false; continue; }
        const t0 = (min - start) / delta, t1 = (max - start) / delta;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      return lo < hi;
    }
    if (depth === 24 || --budget <= 0) return true;
    const [left, right] = halves(p);
    return visit(left, depth + 1) || visit(right, depth + 1);
  };
  return visit(primitive, 0);
}

function checkClearance(layout: GraphLayout, charge: Charge, options?: NativeClearanceOptions): string | null {
  const endStage = layoutStage('clearance-compute'); try {

  const entries: Segment[] = [], probes: { route: PlacedRoute; source: string; probes: Probe[] }[] = [];
  for (const route of layout.routes) {
    charge(1, 'native clearance route');
    const parsed = read(route.path, charge);
    if (!parsed) return 'invalid-path';
    charge(8 * (route.from.kind.length + route.from.id.length + 8), 'native source identity bytes');
    const source = sourceOf(route), { points, errors, hulls, corners, pieces } = parsed;
    const end = points.at(-1)!, before = points.at(-2)!;
    if (route.terminal) {
      const length = Math.hypot(end.x - before.x, end.y - before.y);
      if (!length) return 'invalid-terminal';
      errors.push(0);
      points.push({ x: end.x + ARROW.length * (end.x - before.x) / length, y: end.y + ARROW.length * (end.y - before.y) / length });
      hulls.push(boxOf(end, points.at(-1)!));
      pieces.push([end, points.at(-1)!]);
      // The arrow base is part of the target approach, not an ordinary interior crossing.
      corners.push(end);
    }
    charge(2 * points.length + corners.length, 'native probes and segments');
    for (let i = 1; i < points.length; i++) entries.push({ a: points[i - 1], b: points[i], route, source, error: errors[i], hull: hulls[i], primitive: pieces[i] });
    const portRadius = (p: Point, end: PlacedRoute['from']) => {
      const dot = end.kind === 'junction' ? layout.junctions.get(end.id) : undefined;
      if (dot && Math.hypot(p.x - dot.x, p.y - dot.y) < 1e-7) return Math.max(LANE_SEPARATION, JUNCTION_CLEARANCE);
      const n = layout.nodes?.get(end.id);
      const onOutline = n && p.x >= n.x - .01 && p.x <= n.x + n.width + .01 && p.y >= n.y - .01 && p.y <= n.y + n.height + .01
        && Math.min(Math.abs(p.x - n.x), Math.abs(p.x - n.x - n.width), Math.abs(p.y - n.y), Math.abs(p.y - n.y - n.height)) < .01;
      return onOutline ? PORT_BERTH : LANE_SEPARATION;
    };
    const mask = options?.endpointMasks?.get(route);
    probes.push({ route, source, probes: [...corners.map(p => ({ p, radius: LANE_SEPARATION })),
      ...(mask?.start === false ? [] : [{ p: points[0], radius: portRadius(points[0], route.from) }]),
      ...(mask?.end === false ? [] : [{ p: points.at(-1)!, radius: portRadius(points.at(-1)!, route.to) }])] });
  }
  if (!entries.length) return null;
  const tree = index(entries, charge);
  for (const { route, source, probes: checks } of probes) for (const { p, radius } of checks) {
    const search = (branch: Branch): boolean => {
      charge(1, 'native clearance query');
      if (branch.source === source || p.x + radius + .025 < branch.minX || p.x - radius - .025 > branch.maxX || p.y + radius + .025 < branch.minY || p.y - radius - .025 > branch.maxY) return false;
      if (branch.entries) return branch.entries.some(s => { charge(1, 'native probe pair'); return s.source !== source && !intentional(layout, route, s.route, p) && pointBoxDistance(p, s.hull) < radius - 1e-7 && distance(p, s.a, s.b) < radius + s.error - 1e-7
        && !separatedPrimitives([p, p], s.primitive, radius - 1e-7, charge); });
      return search(branch.left!) || search(branch.right!);
    };
    if (search(tree)) return 'route-contact';
  }
  // Smooth contacts are not corners. Check nearly parallel local tangents as well;
  // transverse interior crossings remain distinct from joins.
  for (const a of entries) {
    const radius = LANE_SEPARATION + .05;
    const minX = Math.min(a.a.x, a.b.x) - radius, maxX = Math.max(a.a.x, a.b.x) + radius;
    const minY = Math.min(a.a.y, a.b.y) - radius, maxY = Math.max(a.a.y, a.b.y) + radius;
    const dx = a.b.x - a.a.x, dy = a.b.y - a.a.y, length = Math.hypot(dx, dy);
    const search = (branch: Branch): boolean => {
      charge(1, 'native clearance query');
      if (branch.source === a.source || maxX < branch.minX || minX > branch.maxX || maxY < branch.minY || minY > branch.maxY) return false;
      if (!branch.entries) return search(branch.left!) || search(branch.right!);
      return branch.entries.some(b => {
        charge(1, 'native tangent pair');
        // Chord error is only an upper uncertainty bound. A separated control hull
        // proves exact clearance even when the conservative chord test cannot.
        if (a.source === b.source || boxDistance(a.hull, b.hull) >= LANE_SEPARATION - 1e-7) return false;
        const bx = b.b.x - b.a.x, by = b.b.y - b.a.y;
        if (Math.abs(dx * by - dy * bx) > .2 * length * Math.hypot(bx, by)) return false;
        const cross=dx*by-dy*bx;
        if (cross) {
          const x=b.a.x-a.a.x,y=b.a.y-a.a.y,t=(x*by-y*bx)/cross,u=(x*dy-y*dx)/cross;
          if (t>=0 && t<=1 && u>=0 && u<=1 && !intentional(layout,a.route,b.route,{x:a.a.x+t*dx,y:a.a.y+t*dy})) return true;
        }
        const possibleContact = [a.a, a.b].some(p => !intentional(layout, a.route, b.route, p) && distance(p, b.a, b.b) < LANE_SEPARATION + a.error + b.error - 1e-7)
          || [b.a, b.b].some(p => !intentional(layout, a.route, b.route, p) && distance(p, a.a, a.b) < LANE_SEPARATION + a.error + b.error - 1e-7);
        return possibleContact && !separatedPrimitives(a.primitive, b.primitive, LANE_SEPARATION - 1e-7, charge);
      });
    };
    if (search(tree)) return 'route-contact';
  }
  return null;

  } finally { endStage(); }
}

