/** Repair connector contacts on a pinned drawing; admission remains the independent gate. */
import type { GraphLayout, LayoutRequest, PlacedRoute } from './layout';
import { geometryGate } from './geometry-gate';
import { segments, type Segment } from './layout-quality';
import { berthsOf, distanceToSegment, paintedSegments, routeEnds, type Berth } from './route-contacts';
import { PORT_BERTH } from './metrics';
import type { Point } from './path-sampling';

interface Line { readonly route: PlacedRoute; readonly pieces: readonly Segment[]; readonly berths: readonly Berth[] }
interface Contact { readonly route: PlacedRoute; readonly other: PlacedRoute; readonly berth: Berth }
const OFFSETS = [-3, 3, -6, 6, -9, 9, -12, 12, -18, 18] as const;
const MAX_PROBES = 384;
const MAX_REPAIRS = 12;

function intentional(layout: GraphLayout, a: PlacedRoute, b: PlacedRoute, p: Point): boolean {
  return [a.from, a.to].some(end => {
    if (end.kind !== 'junction' || ![b.from, b.to].some(other => other.kind === 'junction' && other.id === end.id)) return false;
    const dot = layout.junctions.get(end.id);
    return !!dot && Math.abs(dot.x - p.x) <= PORT_BERTH && Math.abs(dot.y - p.y) <= PORT_BERTH;
  });
}

/** Constructor witnesses are only search hints; they never certify a repaired drawing. */
function lineOf(route: PlacedRoute, layout: GraphLayout): Line {
  const pieces = segments(route.path), ends = routeEnds(route, pieces, layout.nodes, layout.junctions);
  return {route, pieces:paintedSegments(pieces, ends), berths:berthsOf(pieces, ends)};
}

function contacts(lines: readonly Line[], layout: GraphLayout, changed?: PlacedRoute): readonly Contact[] {
  const found: Contact[] = [];
  for (const a of lines) for (const berth of a.berths) for (const b of lines) {
    if (changed && a.route !== changed && b.route !== changed) continue;
    if (a.route.from.kind === b.route.from.kind && a.route.from.id === b.route.from.id || intentional(layout, a.route, b.route, berth)) continue;
    const radius = berth.radius - 1e-7;
    if (b.pieces.some(([p, q]) => Math.min(p.x, q.x) < berth.x + radius && Math.max(p.x, q.x) > berth.x - radius
      && Math.min(p.y, q.y) < berth.y + radius && Math.max(p.y, q.y) > berth.y - radius
      && distanceToSegment([p, q], berth) < radius)) found.push({route:a.route,other:b.route,berth});
  }
  return found;
}

const pathOf = (points: readonly Point[]): string => points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');

/**
 * Move only internal orthogonal connector runs. Rectangles, junctions, route identities,
 * consumers, and both endpoints remain fixed. A bounded search may fail; failed drafts
 * never escape. Every accepted result passes the complete independent geometry gate.
 */
export function repairRouteContacts(layout: GraphLayout, request: LayoutRequest): GraphLayout | null {
  const cover = request.band?.key;
  if (!cover || layout.routes.length > 1024) return null;
  const certify = (drawing: GraphLayout) => geometryGate(drawing, request.items, cover, request.maxWidth);
  const originalFailure = certify(layout);
  if (!originalFailure) return layout;
  if (originalFailure !== 'route-contact') return null;
  let current = layout, probes = MAX_PROBES;
  const seen = new Set<string>();
  for (let iteration = 0; iteration < MAX_REPAIRS && probes > 0; iteration++) {
    const lines = current.routes.map(route => lineOf(route, current));
    if (lines.reduce((sum, line) => sum + line.pieces.length, 0) > 8192) return null;
    const witnesses = contacts(lines, current);
    if (!witnesses.length) return null;
    const first = witnesses[0];
    let chosen: GraphLayout | undefined, score = witnesses.length;
    for (const route of [first.other, first.route]) {
      if (!/^M[-+0-9.,eE\sL]*$/.test(route.path)) continue;
      const unaffected = witnesses.filter(c => c.route !== route && c.other !== route).length;
      const pieces = segments(route.path);
      if (!pieces.length) continue;
      const points = [pieces[0][0], ...pieces.map(s => s[1])];
      for (let i = 1; i < points.length - 2 && probes > 0; i++) {
        const a = points[i], b = points[i + 1], axis = a.x === b.x ? 'x' : a.y === b.y ? 'y' : null;
        if (!axis || distanceToSegment([a, b], first.berth) > 100) continue;
        for (const offset of OFFSETS) {
          if (--probes < 0) break;
          const moved = points.map((p, j) => j === i || j === i + 1 ? {...p, [axis]:p[axis] + offset} : p);
          if (moved.some(p => p.x < 0 || p.x > request.maxWidth || p.y < 0 || p.y > layout.height)) continue;
          const path = pathOf(moved), key = `${route.id}\u0000${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const replacement = {...route, path};
          const next = {...current, routes:current.routes.map(r => r === route ? replacement : r)};
          const nextLines = lines.map(line => line.route === route ? lineOf(replacement, next) : line);
          const remaining = unaffected + contacts(nextLines, next, replacement).length;
          if (remaining >= score) continue;
          const failure = certify(next);
          if (!failure) return next;
          if (failure !== 'route-contact') continue;
          chosen = next; score = remaining;
        }
      }
    }
    if (!chosen) return null;
    current = chosen;
  }
  return null;
}
