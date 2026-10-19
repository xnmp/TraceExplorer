/** Repair connector contacts on a pinned drawing; admission remains the independent gate. */
import type { GraphLayout, LayoutRequest, PlacedRoute } from './layout';
import { geometryGate } from './geometry-gate';
import { segments, type Segment } from './layout-quality';
import { berthsOf, distanceToSegment, paintedSegments, routeEnds, type Berth } from './route-contacts';
import { JUNCTION_CLEARANCE } from './connector-ink';
import { PORT_BERTH } from './metrics';
import { pathCommands, type Point } from './path-sampling';
import { countLayoutWork } from './layout-profile';

interface Line { readonly route: PlacedRoute; readonly pieces: readonly Segment[]; readonly berths: readonly Berth[] }
interface Contact { readonly route: PlacedRoute; readonly other: PlacedRoute; readonly berth: Berth }
const OFFSETS = [-3, 3, -6, 6, -9, 9, -12, 12, -18, 18] as const;
const MAX_PROBES = 3072;
const MAX_REPAIRS = 96;

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
  // routeEnds leaves junction berths to the constructor's dot index. Repair
  // needs the same witnesses explicitly, including contacts on straight runs.
  const dots = [route.from, route.to].flatMap(end => {
    const dot = end.kind === 'junction' ? layout.junctions.get(end.id) : undefined;
    return dot ? [{ x: dot.x, y: dot.y, radius: JUNCTION_CLEARANCE }] : [];
  });
  return {route, pieces:paintedSegments(pieces, ends), berths:[...berthsOf(pieces, ends), ...dots]};
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

/**
 * Move internal orthogonal runs or bypass a contact on a short portion of one. Rectangles, junctions, route identities,
 * consumers, and target endpoints remain fixed. An occupied source port may use the
 * same tile's other real departure. A bounded search may fail; failed drafts
 * never escape. Every accepted result passes the complete independent geometry gate.
 */
export function repairRouteContacts(layout: GraphLayout, request: LayoutRequest, site: 'band' | 'hint' | 'folder'): GraphLayout | null {
  const cover = request.band?.key;
  if (!cover || layout.routes.length > 1024) return null;
  const certify = (drawing: GraphLayout) => geometryGate(drawing, request.items, cover, request.maxWidth);
  const originalFailure = certify(layout);
  if (!originalFailure) return layout;
  if (originalFailure !== 'route-contact' && originalFailure !== 'shared-lane') return null;
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
      const unaffected = witnesses.filter(c => c.route !== route && c.other !== route).length;
      for (const path of alternatives(route, first.berth, current)) {
        if (--probes < 0) break;
        const key = `${route.id}\u0000${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const replacement = {...route, path};
        const next = {...current, routes:current.routes.map(r => r === route ? replacement : r)};
        const nextLines = lines.map(line => line.route === route ? lineOf(replacement, next) : line);
        if (nextLines.some(line => line.pieces.some(([a, b]) => a.x < 0 || b.x < 0 || a.x > request.maxWidth || b.x > request.maxWidth
          || a.y < 0 || b.y < 0 || a.y > layout.height || b.y > layout.height))) continue;
        const remaining = unaffected + contacts(nextLines, next, replacement).length;
        if (remaining >= score) continue;
        const failure = certify(next);
        // Production reach of this legacy stage (T28), counted per call site. A caller
        // may still discard the repaired drawing, so this counts reach, not publication.
        if (!failure) { countLayoutWork(`legacy:T28:${site}`); return next; }
        if (failure !== 'route-contact' && failure !== 'shared-lane') continue;
        chosen = next; score = remaining;
      }
    }
    if (!chosen) return null;
    current = chosen;
  }
  return null;
}

/** Exact commands retain curve controls and endpoints; flattened curves are never rewritten. */
function* alternatives(route: PlacedRoute, berth: Berth, layout: GraphLayout): Generator<string> {
  const commands = pathCommands(route.path), raw = [...route.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
  if (!commands || commands.length !== raw.length) return;
  const at = (i: number): Point => ({x:commands[i].values.at(-2)!, y:commands[i].values.at(-1)!});
  const line = (p: Point): string => `L${p.x} ${p.y}`;
  // Only straight neighbours can follow a shifted run without altering a curve endpoint.
  for (let i = 2; i < commands.length - 1; i++) {
    if ([commands[i - 1], commands[i], commands[i + 1]].some(c => c.kind !== 'L')) continue;
    const a = at(i - 1), b = at(i), axis = a.x === b.x ? 'x' : a.y === b.y ? 'y' : null;
    if (!axis || distanceToSegment([a, b], berth) > 100) continue;
    const before = at(i - 2), after = at(i + 1);
    // A redundant collinear neighbour would become diagonal when this run moves.
    if (axis === 'x' ? before.y !== a.y || after.y !== b.y : before.x !== a.x || after.x !== b.x) continue;
    for (const delta of OFFSETS) {
      const pa = {...a, [axis]:a[axis] + delta}, pb = {...b, [axis]:b[axis] + delta};
      yield raw.map((r, j) => j === i - 1 ? line(pa) : j === i ? line(pb) : r).join(' ');
    }
  }
  // A long run can be pinned by remote obstacles while a short local bypass remains free.
  for (let i = 1; i < commands.length; i++) {
    if (commands[i].kind !== 'L') continue;
    const a = at(i - 1), b = at(i), horizontal = a.y === b.y, vertical = a.x === b.x;
    if ((!horizontal && !vertical) || distanceToSegment([a, b], berth) > berth.radius + 3) continue;
    const along = horizontal ? 'x' : 'y', across = horizontal ? 'y' : 'x';
    const length = Math.abs(b[along] - a[along]), sign = Math.sign(b[along] - a[along]);
    if (!length) continue;
    const center = (berth[along] - a[along]) * sign;
    for (const span of [berth.radius + 3, berth.radius + 6, berth.radius + 12]) {
      // Keep the departure and arrival directions, with room before the first new turn.
      const lo = Math.max(i === 1 ? 9 : 1, center - span);
      const hi = Math.min(length - (i === commands.length - 1 ? 9 : 1), center + span);
      if (!(lo < hi) || center < lo || center > hi) continue;
      const p = {...a, [along]:a[along] + sign * lo}, q = {...a, [along]:a[along] + sign * hi};
      for (const delta of [...OFFSETS, -24, 24]) {
        const c = {...p, [across]:p[across] + delta}, d = {...q, [across]:q[across] + delta};
        const bypass = [p, c, d, q, b].map(line).join(' ');
        yield raw.map((r, j) => j === i ? bypass : r).join(' ');
      }
    }
  }
  // A foreign run or nearby corner can occupy a source's port berth while its
  // other departure is clear. The first contact witness need not be the port itself.
  // Reconnect only to an early straight run; the retained suffix, including every
  // cubic command and the target approach, stays authored exactly as before.
  const source = route.from.kind === 'node' ? layout.nodes.get(route.from.id) : undefined;
  if (!source || Math.hypot(at(0).x - berth.x, at(0).y - berth.y) > PORT_BERTH) return;
  const ports = [{x:source.x + source.width / 2, y:source.y + source.height, axis:'y'},
    {x:source.x + source.width, y:source.y + source.height / 2, axis:'x'}] as const;
  if (!ports.some(p => Math.hypot(p.x - at(0).x, p.y - at(0).y) < .01)) return;
  for (const start of ports) {
    if (Math.hypot(start.x - at(0).x, start.y - at(0).y) < .01) continue;
    for (const distance of [9, 12, 18]) {
      const exit = {x:start.x + (start.axis === 'x' ? distance : 0), y:start.y + (start.axis === 'y' ? distance : 0)};
      for (let i = 1; i < Math.min(commands.length, 5); i++) {
        if (commands[i].kind !== 'L') break;
        const a = at(i - 1), b = at(i);
        const join = a.x === b.x ? {x:a.x, y:exit.y} : a.y === b.y ? {x:exit.x, y:a.y} : null;
        if (!join || join.x < Math.min(a.x, b.x) || join.x > Math.max(a.x, b.x)
          || join.y < Math.min(a.y, b.y) || join.y > Math.max(a.y, b.y)
          || join.x === b.x && join.y === b.y) continue;
        yield [`M${start.x} ${start.y}`, line(exit), line(join), ...raw.slice(i)].join(' ');
      }
    }
  }
}
