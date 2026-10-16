/** Global checks on the drawing, independent of placement and router occupancy tables. */
import type { GraphLayout, LayoutItem, PlacedRoute } from './layout';
import { validateLayout, cost } from './layout-quality';
import { ARROW, LANE_SEPARATION, PORT_BERTH } from './metrics';
import { inReach } from './band-incremental';
import { geometrySignature } from './layout-signature';
import { createBoundedCache } from './folder-layout/bounded-cache';

type Point = { readonly x: number; readonly y: number };
type Segment = { readonly a: Point; readonly b: Point; readonly route: PlacedRoute; readonly source: string; readonly error: number };
type Probe = { readonly p: Point; readonly radius: number };
const sourceOf = (r: PlacedRoute) => JSON.stringify([r.from.kind, r.from.id]);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (p: Point, a: Point, b: Point): number => {
  const x = b.x - a.x, y = b.y - a.y, square = x * x + y * y;
  const t = square ? Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / square)) : 0;
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y);
};

/** Independent strict reader. Cubic subdivision has a geometric error bound, not a sample count. */
function read(path: string): { points: Point[]; errors: number[]; corners: Point[] } | null {
  const tokens = path.match(/[MLC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  if (path.replace(/[MLC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/gi, '') || tokens[0] !== 'M') return null;
  let at = 0, last = '';
  const points: Point[] = [], errors: number[] = [], corners: Point[] = [];
  const point = (): Point => ({ x: Number(tokens[at++]), y: Number(tokens[at++]) });
  const curve = (a: Point, b: Point, c: Point, d: Point, depth: number): boolean => {
    if (a.x === d.x && a.y === d.y && (b.x !== a.x || b.y !== a.y || c.x !== a.x || c.y !== a.y)) return false;
    if (Math.max(distance(b, a, d), distance(c, a, d)) <= .025) { points.push(d); errors.push(.025); return true; }
    if (depth >= 16) return false;
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d), abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    return curve(a, ab, abc, middle, depth + 1) && curve(middle, bcd, cd, d, depth + 1);
  };
  while (at < tokens.length) {
    const command = tokens[at++];
    if (command === 'M' && !points.length || command === 'L' && points.length) {
      const p = point();
      if (![p.x, p.y].every(inReach)) return null;
      if (command === 'L' && last === 'L' && points.length > 1) {
        const a = points.at(-2)!, b = points.at(-1)!;
        if (Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) > 1e-7) corners.push(b);
      }
      points.push(p); errors.push(0);
    } else if (command === 'C' && points.length) {
      const b = point(), c = point(), d = point();
      if (![b.x, b.y, c.x, c.y, d.x, d.y].every(inReach) || !curve(points.at(-1)!, b, c, d, 0)) return null;
    } else return null;
    last = command;
  }
  const keep = points.map((p, i) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  const clean = points.filter((_, i) => keep[i]), cleanErrors = errors.filter((_, i) => keep[i]);
  for (let i = 1; i + 1 < clean.length; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y));
    if (dot < .98) corners.push(b);
  }
  return clean.length > 1 ? { points: clean, errors: cleanErrors, corners } : null;
}

interface Box { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }
interface Branch extends Box { readonly source: string | null; readonly entries?: readonly Segment[]; readonly left?: Branch; readonly right?: Branch }
function index(entries: Segment[]): Branch {
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
  return { ...box, left: index(entries.slice(0, middle)), right: index(entries.slice(middle)) };
}

/** A declared junction permits contact only at that junction, never along the whole route. */
function intentional(layout: GraphLayout, a: PlacedRoute, b: PlacedRoute, p: Point): boolean {
  for (const end of [a.from, a.to]) {
    if (end.kind !== 'junction' || ![b.from, b.to].some(other => other.kind === 'junction' && other.id === end.id)) continue;
    const dot = layout.junctions.get(end.id);
    if (dot && Math.hypot(p.x - dot.x, p.y - dot.y) <= PORT_BERTH) return true;
  }
  return false;
}

const clearanceCache = createBoundedCache<string | null>(() => 64, { maxEntries: 64, maxBytes: 8 * 1024 * 1024 });

export function routeClearanceViolation(layout: GraphLayout): string | null {
  // Exact values, not object identity: even an externally mutated history is rechecked.
  const signature = JSON.stringify([layout.nodes ? [...layout.nodes].map(([id,n]) => [id,n.x,n.y,n.width,n.height]) : [], layout.routes.map(r => [r.path, r.from.kind, r.from.id, r.to.kind, r.to.id, r.terminal]),
    [...layout.junctions].map(([id, j]) => [id, j.x, j.y])]);
  const known = clearanceCache.get(signature);
  if (known !== undefined) return known;
  const result = checkClearance(layout);
  clearanceCache.set(signature, result);
  return result;
}

function checkClearance(layout: GraphLayout): string | null {
  const entries: Segment[] = [], probes: { route: PlacedRoute; source: string; probes: Probe[] }[] = [];
  for (const route of layout.routes) {
    const parsed = read(route.path);
    if (!parsed) return 'invalid-path';
    const source = sourceOf(route), { points, errors, corners } = parsed;
    const end = points.at(-1)!, before = points.at(-2)!;
    if (route.terminal) {
      const length = Math.hypot(end.x - before.x, end.y - before.y);
      if (!length) return 'invalid-terminal';
      errors.push(0);
      points.push({ x: end.x + ARROW.length * (end.x - before.x) / length, y: end.y + ARROW.length * (end.y - before.y) / length });
    }
    for (let i = 1; i < points.length; i++) entries.push({ a: points[i - 1], b: points[i], route, source, error: errors[i] });
    const portRadius = (p: Point, end: PlacedRoute['from']) => {
      const n = end.kind === 'node' ? layout.nodes?.get(end.id) : undefined;
      const onOutline = n && p.x >= n.x - .01 && p.x <= n.x + n.width + .01 && p.y >= n.y - .01 && p.y <= n.y + n.height + .01
        && Math.min(Math.abs(p.x - n.x), Math.abs(p.x - n.x - n.width), Math.abs(p.y - n.y), Math.abs(p.y - n.y - n.height)) < .01;
      return onOutline ? PORT_BERTH : LANE_SEPARATION;
    };
    probes.push({ route, source, probes: [...corners.map(p => ({ p, radius: LANE_SEPARATION })),
      { p: points[0], radius: portRadius(points[0], route.from) }, { p: points.at(-1)!, radius: portRadius(points.at(-1)!, route.to) }] });
  }
  if (!entries.length) return null;
  const tree = index(entries);
  for (const { route, source, probes: checks } of probes) for (const { p, radius } of checks) {
    const search = (branch: Branch): boolean => {
      if (branch.source === source || p.x + radius + .025 < branch.minX || p.x - radius - .025 > branch.maxX || p.y + radius + .025 < branch.minY || p.y - radius - .025 > branch.maxY) return false;
      if (branch.entries) return branch.entries.some(s => s.source !== source && !intentional(layout, route, s.route, p) && distance(p, s.a, s.b) < radius + s.error - 1e-7);
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
      if (branch.source === a.source || maxX < branch.minX || minX > branch.maxX || maxY < branch.minY || minY > branch.maxY) return false;
      if (!branch.entries) return search(branch.left!) || search(branch.right!);
      return branch.entries.some(b => {
        if (a.source === b.source) return false;
        const bx = b.b.x - b.a.x, by = b.b.y - b.a.y;
        if (Math.abs(dx * by - dy * bx) > .2 * length * Math.hypot(bx, by)) return false;
        return [a.a, a.b].some(p => !intentional(layout, a.route, b.route, p) && distance(p, b.a, b.b) < LANE_SEPARATION + a.error + b.error - 1e-7)
          || [b.a, b.b].some(p => !intentional(layout, a.route, b.route, p) && distance(p, a.a, a.b) < LANE_SEPARATION + a.error + b.error - 1e-7);
      });
    };
    if (search(tree)) return 'route-contact';
  }
  return null;
}

const geometryChecks = createBoundedCache<string | null>(() => 64, { maxEntries: 64, maxBytes: 8 * 1024 * 1024 });

/** This is the admission boundary for a complete drawing, whatever generated it. */
export function geometryGate(layout: GraphLayout, items: readonly LayoutItem[], cover: string, width: number): string | null {
  const key = JSON.stringify([cover, width, items.map(n => [n.key, n.width, n.height, n.parents]), geometrySignature(layout)]);
  const known = geometryChecks.get(key);
  if (known !== undefined) return known;
  const metrics = validateLayout(layout, cover, width, items);
  const failure = !Number.isFinite(cost(metrics, 92)) ? metrics.sharedLanePx ? 'shared-lane' : 'invalid-geometry' : routeClearanceViolation(layout);
  geometryChecks.set(key, failure);
  return failure;
}
