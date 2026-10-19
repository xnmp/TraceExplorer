/** Committed incremental routing. Topology construction supplies free rectangles
 * and paths; retained native paint is captured before construction and never
 * reconstructed by the metric solver. Unsupported topology returns a witness. */
import type { GraphLayout, LayoutRequest, PlacedRoute } from './layout';
import { geometryGate } from './geometry-gate';
import { isLayoutShape } from './history-boundary';
import { filterRouteConsumers } from './route-consumers';
import { pathCommands, type Point } from './path-sampling';
import { segments, type Segment } from './layout-quality';
import { berthsOf, routeEnds, TILE_GRAZE, type Berth } from './route-contacts';
import { LANE_SEPARATION } from './metrics';
import { chargeRoutingSnapshot, importCommittedRouting, retainedRoutingConflict, type CommittedRoutingProblem } from './routing-problem';
import { solveRoutingComponents } from './routing-components';
import { chargedNativeTileClearance, chargedNativeClearance } from './native-route-clearance';
import { prepayIndependentAdmission } from './routing-admission-work';
import { prepayRoutingGateSerialization } from './routing-serialization-work';
import { searchCorridors, type CorridorSearch } from './corridor-search';
import type { CoordinateVariable, Separation } from './separation';
import { captureRoutingFragments, bindRoutingFragmentTopology, fragmentCoordinateKey,
  type RetainedRoutingFragments, type FragmentTopologyBindings } from './routing-fragments';
import type { RoutingFrameEquality } from './routing-problem';

export type IncrementalConflictReason = 'topology-conflict' | 'metric-conflict' | 'unsupported-input' | 'budget-exhaustion';
export interface IncrementalRoutingConflict {
  readonly reason: IncrementalConflictReason;
  readonly constraints: readonly string[];
}
export type IncrementalRoutingResult = { readonly ok: true; readonly drawing: GraphLayout; readonly solved: number; readonly work: number }
  | { readonly ok: false; readonly conflict: IncrementalRoutingConflict; readonly work: number };
export interface IncrementalRoutingSeed {
  readonly drawing: GraphLayout;
  readonly problem: CommittedRoutingProblem;
  readonly fragments?: RetainedRoutingFragments;
}
export type IncrementalTopologyConstructor = (drawing: GraphLayout, charge: (work: number, reason?: string) => void,
  choose: CorridorSearch['choose'], reserve: CorridorSearch['reserve'], fragments?: RetainedRoutingFragments) => GraphLayout | IncrementalRoutingConflict;
export type IncrementalFrameFactory = (source: GraphLayout, charge: CorridorSearch['charge'], choose: CorridorSearch['choose']) =>
  { readonly preferred: GraphLayout; readonly frames: readonly RoutingFrameEquality[] } | IncrementalRoutingConflict;
/** Additional actual-publication checks share capture/construction's ledger.
 * They may withhold a candidate, never replace its captured authority or result. */
export type IncrementalAdmission = (drawing: GraphLayout, charge: CorridorSearch['charge']) => IncrementalRoutingConflict | null;
const scene = (drawing: GraphLayout) => ({ id: 'committed', space: 'attached' as const, drawing });
const sameSource = (a: PlacedRoute, b: PlacedRoute, charge: CorridorSearch['charge']): boolean => {
  charge(a.from.id.length + b.from.id.length + 4, 'metric source identity');
  return a.from.kind === b.from.kind && a.from.id === b.from.id;
};
const failure = (reason: IncrementalConflictReason, constraints: readonly string[], work = 0): IncrementalRoutingResult =>
  ({ ok: false, conflict: { reason, constraints }, work });
const validConflict = (value: unknown): value is IncrementalRoutingConflict => {
  if (!value || typeof value !== 'object') return false;
  const conflict = value as IncrementalRoutingConflict;
  return ['budget-exhaustion', 'unsupported-input', 'metric-conflict', 'topology-conflict'].includes(conflict.reason)
    && Array.isArray(conflict.constraints) && Array.from(conflict.constraints).every(value => typeof value === 'string');
};
const validItem = (item: LayoutRequest['items'][number]): boolean => !!item && typeof item.key === 'string'
    && Number.isFinite(item.width) && item.width > 0 && Number.isFinite(item.height) && item.height > 0
    && Array.isArray(item.parents) && Array.from(item.parents).every(parent => typeof parent === 'string');
const validRequest = (request: LayoutRequest): boolean => !!request && Number.isFinite(request.maxWidth) && request.maxWidth > 0
  && !!request.band && typeof request.band.key === 'string' && Array.isArray(request.band.items)
  && Array.from(request.band.items).every(validItem)
  && Array.isArray(request.items) && Array.from(request.items).every(validItem);

/** Membership projection is a request policy, applied before declaring pins.
 * A hidden/departed consumer cannot keep an obsolete meeting or wire alive. */
export function projectCommittedRouting(previous: GraphLayout, request: LayoutRequest,
  charge: (work: number, reason?: string) => void = () => {}): GraphLayout {
  charge(request.items.length + previous.nodes.size + previous.routes.length + previous.junctions.size,
    'committed membership projection');
  const wanted = new Set(request.items.map(n => n.key));
  const tables = new Set<readonly unknown[]>();
  for (const route of previous.routes) {
    const entries = Array.isArray(route.consumers) ? route.consumers
      : (route.consumers as { readonly entries: readonly unknown[] }).entries;
    if (!tables.has(entries)) {
      charge(entries.length + 1, 'committed consumer projection');
      tables.add(entries);
    }
  }
  const routes = filterRouteConsumers(previous.routes, c => wanted.has(c.parent) && wanted.has(c.child));
  const referenced = new Set(routes.flatMap(r => [r.from, r.to].filter(e => e.kind === 'junction').map(e => e.id)));
  return { ...previous, nodes: new Map([...previous.nodes].filter(([key]) => wanted.has(key))), routes,
    junctions: new Map([...previous.junctions].filter(([key]) => referenced.has(key))) };
}

/** The caller must derive permitted resized rectangles before capture. This
 * boundary never silently changes a retained size or pin to fit an insertion. */
export function captureIncrementalRouting(request: LayoutRequest, previous: GraphLayout,
  charge: (work: number, reason?: string) => void = () => {}): IncrementalRoutingSeed | IncrementalRoutingConflict {
  chargeRoutingSnapshot([request, previous], charge);
  if (!validRequest(request) || !isLayoutShape(previous)) return { reason: 'unsupported-input', constraints: ['committed request/drawing shape'] };
  const drawing = projectCommittedRouting(previous, request, charge);
  if (request.items.some(item => {
    const old = drawing.nodes.get(item.key);
    return old && (old.width !== item.width || old.height !== item.height);
  })) return { reason: 'unsupported-input', constraints: ['derive hint rectangles before capture'] };
  const captured = importCommittedRouting([scene(drawing)], [], charge);
  return captured.ok ? { drawing, problem: captured.problem }
    : { reason: 'unsupported-input', constraints: captured.conflict.constraints };
}

/** Selective retention is explicit and opt-in. The raw projected source and
 * allowed frame equations precede construction; preferred core runs stay free. */
export function captureFramedIncrementalRouting(request: LayoutRequest, previous: GraphLayout, preferred: GraphLayout,
  frames: readonly RoutingFrameEquality[] = [], charge: (work: number, reason?: string) => void = () => {}):
  IncrementalRoutingSeed | IncrementalRoutingConflict {
  chargeRoutingSnapshot([request, previous, preferred, frames], charge);
  if (!validRequest(request) || !isLayoutShape(previous) || !isLayoutShape(preferred))
    return { reason: 'unsupported-input', constraints: ['framed request/drawing shape'] };
  const projected = projectCommittedRouting(previous, request, charge);
  if (request.items.some(item => { const old = preferred.nodes.get(item.key); return old && (old.width !== item.width || old.height !== item.height); }))
    return { reason: 'unsupported-input', constraints: ['declared framed request sizes'] };
  const captured = captureRoutingFragments({ id: 'before', space: 'attached', drawing: projected },
    { id: 'derived', space: 'attached', drawing: preferred }, frames, charge);
  if (!captured.ok) return { reason: 'unsupported-input', constraints: captured.conflict.constraints };
  const source = importCommittedRouting([captured.retained.source], [], charge);
  return source.ok ? { drawing: structuredClone(preferred), problem: source.problem, fragments: captured.retained }
    : { reason: 'unsupported-input', constraints: source.conflict.constraints };
}

/** One ledger owns capture, topology construction and the affected metric solve.
 * Construction must charge its bounded work before executing it. No failed
 * attempt can turn a constant into a preferred coordinate on the next attempt. */
export function routeCommittedIncremental(request: LayoutRequest, previous: GraphLayout,
  construct: IncrementalTopologyConstructor, budget = 64_000_000, pane?: { readonly left: number; readonly right: number },
  prepare?: IncrementalFrameFactory, admit?: IncrementalAdmission): IncrementalRoutingResult {
  const result = searchCorridors(search => {
    let seed: IncrementalRoutingSeed | IncrementalRoutingConflict;
    if (prepare) {
      chargeRoutingSnapshot([request, previous], search.charge);
      if (!validRequest(request) || !isLayoutShape(previous)) return search.reject(['framed request/drawing shape'], 'invalid');
      const projected = projectCommittedRouting(previous, request, search.charge);
      let snapshot: GraphLayout;
      try { snapshot = structuredClone(projected); }
      catch (error) {
        if (error instanceof Error && error.name === 'DataCloneError') return search.reject(['framed source is not cloneable'], 'invalid');
        throw error;
      }
      const frame = prepare(snapshot, search.charge, search.choose);
      if (!frame || typeof frame !== 'object') return search.reject(['framed policy result'], 'invalid');
      chargeRoutingSnapshot(frame, search.charge);
      if ('reason' in frame && !validConflict(frame)) return search.reject(['framed policy conflict shape'], 'invalid');
      seed = 'reason' in frame ? frame : captureFramedIncrementalRouting(request, previous, frame.preferred, frame.frames, search.charge);
    } else seed = captureIncrementalRouting(request, previous, search.charge);
    if (!('problem' in seed)) return search.reject(seed.constraints, seed.reason === 'unsupported-input' ? 'invalid'
      : seed.reason === 'budget-exhaustion' ? 'search-exhausted' : seed.reason === 'metric-conflict' ? 'metric' : 'topology');
    // Construction may defer free old cores while treating the selected native
    // fragments as hard obstacles. Give it a separate, prepaid snapshot so a
    // constructor cannot mutate the metric's captured authority.
    let fragments: RetainedRoutingFragments | undefined;
    if (seed.fragments) {
      chargeRoutingSnapshot(seed.fragments, search.charge);
      fragments = structuredClone(seed.fragments);
    }
    const topology = construct(seed.drawing, search.charge, search.choose, search.reserve, fragments);
    if (!topology || typeof topology !== 'object') return search.reject(['topology constructor result'], 'invalid');
    if ('reason' in topology) {
      chargeRoutingSnapshot(topology, search.charge);
      if (!validConflict(topology)) return search.reject(['topology constructor conflict shape'], 'invalid');
    }
    if ('reason' in topology) return search.reject([topology.reason, ...topology.constraints],
      topology.reason === 'unsupported-input' ? 'invalid' : topology.reason === 'metric-conflict' ? 'metric' : 'topology');
    const solved = solveIncrementalTopology(request, seed, topology, search.remaining, pane);
    search.charge(solved.work, 'affected incremental solve');
    if (!solved.ok) return search.reject(solved.conflict.constraints,
      solved.conflict.reason === 'budget-exhaustion' ? 'search-exhausted'
        : solved.conflict.reason === 'unsupported-input' ? 'invalid'
        : solved.conflict.reason === 'metric-conflict' ? 'metric' : 'topology');
    if (admit) {
      chargeRoutingSnapshot(solved.drawing, search.charge);
      const admitted = admit(structuredClone(solved.drawing), search.charge);
      if (admitted !== null) {
        chargeRoutingSnapshot(admitted, search.charge);
        if (!validConflict(admitted))
          return search.reject(['publication admission result'], 'invalid');
        return search.reject(admitted.constraints, admitted.reason === 'budget-exhaustion' ? 'search-exhausted'
          : admitted.reason === 'unsupported-input' ? 'invalid' : admitted.reason === 'metric-conflict' ? 'metric' : 'topology');
      }
    }
    return { drawing: solved.drawing, solved: solved.solved };
  }, budget);
  return result.ok ? { ok: true, ...result.value, work: result.work }
    : failure(result.conflict.kind === 'search-exhausted' || result.conflict.constraints[0] === 'budget-exhaustion' ? 'budget-exhaustion'
      : result.conflict.kind === 'metric' ? 'metric-conflict'
      : result.conflict.kind === 'invalid' ? 'unsupported-input' : 'topology-conflict', result.conflict.constraints, result.work);
}

interface Track {
  readonly id: string;
  readonly route: PlacedRoute;
  readonly command: number;
  readonly axis: 'x' | 'y';
  readonly value: number;
  readonly a: Point;
  readonly b: Point;
}
interface RouteModel {
  readonly route: PlacedRoute;
  readonly raw: readonly string[];
  readonly points: readonly Point[];
  readonly tracks: readonly Track[];
}

/** Internal straight runs can move with both perpendicular neighbours. Endpoints,
 * native curves, source ports and terminal suffixes stay authored exactly. */
function model(route: PlacedRoute, retained?: FragmentTopologyBindings): RouteModel {
  const commands = pathCommands(route.path) ?? [];
  const raw = [...route.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
  const points = commands.map(c => ({ x: c.values.at(-2)!, y: c.values.at(-1)! }));
  const tracks: Track[] = [];
  if (commands.length === raw.length) for (let i = 2; i + 1 < commands.length; i++) {
    if ([commands[i - 1], commands[i], commands[i + 1]].some(c => c.kind !== 'L')) continue;
    const before = points[i - 2], a = points[i - 1], b = points[i], after = points[i + 1];
    const axis = a.x === b.x && a.y !== b.y && before.y === a.y && after.y === b.y ? 'x'
      : a.y === b.y && a.x !== b.x && before.x === a.x && after.x === b.x ? 'y' : null;
    if (axis && !retained?.fixed.has(fragmentCoordinateKey(route.id, i - 1, axis))
      && !retained?.fixed.has(fragmentCoordinateKey(route.id, i, axis)))
      tracks.push({ id: JSON.stringify(['free-track', route.id, i, axis]), route, command: i, axis, value: a[axis], a, b });
  }
  return { route, raw, points, tracks };
}

/** Re-solve only free track components in an already chosen corridor topology.
 * Corridor sides are discrete choices. A failed fixed order is never interpreted
 * as global infeasibility; the caller can construct another corridor. */
export function solveIncrementalTopology(request: LayoutRequest, seed: IncrementalRoutingSeed, topology: GraphLayout,
  budget = 64_000_000, pane?: { readonly left: number; readonly right: number }): IncrementalRoutingResult {
  const result = searchCorridors(search => {
    chargeRoutingSnapshot(request, search.charge);
    chargeRoutingSnapshot(topology, search.charge);
    if (!validRequest(request) || !isLayoutShape(topology)) return search.reject(['incremental request/topology shape'], 'invalid');
    const metric = seed.fragments?.metric ?? seed.problem.metric;
    search.charge(metric.variables.length + 1, 'committed metric table');
    search.charge(seed.drawing.routes.length * (topology.routes.length + 1), 'retained native bindings');
    let fragmentBindings: FragmentTopologyBindings | undefined;
    if (seed.fragments) {
      const bound = bindRoutingFragmentTopology(seed.fragments, topology, search.charge);
      if (!bound.ok) return search.reject(bound.conflict.constraints, 'metric');
      fragmentBindings = bound.bindings;
    }
    for (const old of seed.fragments ? [] : seed.drawing.routes) {
      const next = topology.routes.find(r => r.id === old.id);
      if (!next || next.path !== old.path) search.reject(['retained native route', old.id], 'metric');
    }
    const retained = new Set(seed.drawing.routes.map(r => r.id));
    const freeRoutes = topology.routes.filter(r => seed.fragments || !retained.has(r.id));
    for (const route of freeRoutes) search.charge(8 * route.path.length + 1, 'free native model parsing');
    const models = freeRoutes.map(route => model(route, fragmentBindings));
    const tracks = models.flatMap(m => m.tracks);
    search.charge(topology.nodes.size + topology.routes.length + tracks.length + 1, 'incremental topology');
    const variables = new Map<string, CoordinateVariable>(metric.variables.map(v => [v.id, v]));
    const edges: Separation[] = [];
    const decisions = new Map<string, string>();
    const constant = (name: string, value: number): string => {
      const id = JSON.stringify(['topology-constant', name]);
      if (!variables.has(id)) variables.set(id, { id, preferred: value, pin: { value, reason: name } });
      return id;
    };
    const constraints = (before: string, after: string, gap: number, name: string, decision?: string) => {
      if (before === after) { if (gap > 0) search.reject([name], 'metric', decision ? [decision] : []); return; }
      const id = JSON.stringify([name, edges.length]);
      edges.push({ id, before, after, gap });
      if (decision) decisions.set(id, decision);
    };
    for (const t of tracks) variables.set(t.id, { id: t.id, preferred: t.value, bounds: {
      lower: t.axis === 'x' ? pane?.left ?? 0 : 0,
      upper: t.axis === 'x' ? pane?.right ?? Math.max(request.maxWidth, topology.width) : topology.height,
    } });
    const coordinate = (m: RouteModel, index: number, axis: 'x' | 'y'): string => {
      search.charge(m.tracks.length + 1, 'free track coordinate lookup');
      return fragmentBindings?.coordinates.get(fragmentCoordinateKey(m.route.id, index, axis))
        ?? m.tracks.find(t => t.axis === axis && (t.command === index || t.command - 1 === index))?.id
        ?? constant(JSON.stringify([m.route.id, index, axis]), m.points[index][axis]);
    };
    for (const m of models) for (let i = 0; i < m.points.length; i++) {
      coordinate(m, i, 'x'); coordinate(m, i, 'y');
    }
    for (const interval of fragmentBindings?.intervals ?? []) {
      const owner = models.find(model => model.route.id === interval.route)!;
      const end = coordinate(owner, interval.command, interval.axis);
      const boundary = constant(JSON.stringify(['retained-interval', interval.route, interval.command,
        interval.axis, interval.forward, interval.boundary]), interval.boundary);
      constraints(interval.forward ? boundary : end, interval.forward ? end : boundary, 0, 'retained-native-interval');
    }
    // Preserve the directions of all edited neighbouring runs. An endpoint cannot
    // pass its neighbour and silently change the selected topology.
    for (const m of models) for (const t of m.tracks) {
      const axis = t.axis;
      for (const [a, b] of [[t.command - 2, t.command - 1], [t.command, t.command + 1]]) {
        const left = coordinate(m, a, axis), right = coordinate(m, b, axis);
        const forward = m.points[b][axis] >= m.points[a][axis];
        constraints(forward ? left : right, forward ? right : left, 0, 'run-direction');
      }
    }
    // Each foreign route's segments, ends and berths depend only on the topology,
    // never on the track being separated: parse each once, on first need.
    const parsed = new Map<PlacedRoute, { readonly ss: readonly Segment[]; readonly berths: readonly Berth[] }>();
    const foreign = (r: PlacedRoute) => {
      let known = parsed.get(r);
      if (!known) {
        search.charge(8 * r.path.length + 1, 'foreign native parsing');
        const ss = segments(r.path);
        known = { ss, berths: berthsOf(ss, routeEnds(r, ss, topology.nodes, topology.junctions)) };
        parsed.set(r, known);
      }
      return known;
    };
    search.charge(models.length + 1, 'free route model index');
    const modelOf = new Map(models.map(m => [m.route.id, m]));
    // Choose an empty tile corridor for each free segment. Its longitudinal span
    // remains part of the topology; the final independent gate checks all paint.
    for (const t of tracks) {
      const along = t.axis === 'x' ? 'y' : 'x';
      const lo = Math.min(t.a[along], t.b[along]), hi = Math.max(t.a[along], t.b[along]);
      for (const n of topology.nodes.values()) {
        search.charge(1, 'tile corridor');
        const near = along === 'y' ? n.y : n.x, far = near + (along === 'y' ? n.height : n.width);
        if (hi <= near - TILE_GRAZE || lo >= far + TILE_GRAZE) continue;
        const lower = n[t.axis] - TILE_GRAZE, upper = n[t.axis] + (t.axis === 'x' ? n.width : n.height) + TILE_GRAZE;
        const sides = t.value <= lower ? ['before'] : t.value >= upper ? ['after']
          : t.value - lower <= upper - t.value ? ['before', 'after'] : ['after', 'before'];
        const decision = JSON.stringify(['tile-corridor', t.id, n.key]);
        const side = search.choose(decision, sides);
        if (side === 'before') constraints(t.id, constant(n.key + ':' + t.axis + ':near', lower), 0, 'tile-corridor', decision);
        else constraints(constant(n.key + ':' + t.axis + ':far', upper), t.id, 0, 'tile-corridor', decision);
      }
      for (const r of topology.routes) {
        if (sameSource(r, t.route, search.charge)) continue;
        const { ss, berths } = foreign(r);
        search.charge(ss.length + 1, 'foreign corridor');
        for (const [i, [a, b]] of ss.entries()) {
          if (a[t.axis] !== b[t.axis] || Math.min(a[along], b[along]) >= hi || Math.max(a[along], b[along]) <= lo) continue;
          search.charge(1, 'foreign route model lookup');
          const foreignModel = modelOf.get(r.id);
          search.charge((foreignModel?.tracks.length ?? 0) + 1, 'foreign route track lookup');
          const other = foreignModel?.tracks.find(u => u.axis === t.axis && u.value === a[t.axis]
            && Math.min(u.a[along], u.b[along]) <= Math.min(a[along], b[along]) && Math.max(u.a[along], u.b[along]) >= Math.max(a[along], b[along]));
          const id = other?.id ?? constant(JSON.stringify(['foreign-track', r.id, i, t.axis]), a[t.axis]);
          if (other && t.id > other.id) continue;
          const forward = t.value < a[t.axis] || t.value === a[t.axis] && t.id < id;
          constraints(forward ? t.id : id, forward ? id : t.id, LANE_SEPARATION, 'parallel-tracks');
        }
        search.charge(berths.length + 1, 'foreign berths');
        for (const [i, berth] of berths.entries()) {
          if (berth[along] < lo || berth[along] > hi) continue;
          // Intentional convergence belongs to the native meeting model; moving
          // an internal track cannot invent another junction input.
          if ([r.from, r.to].some(e => e.kind === 'junction' && [t.route.from, t.route.to].some(f => f.kind === e.kind && f.id === e.id))) continue;
          if (Math.abs(berth[t.axis] - t.value) >= berth.radius) continue;
          search.charge(1, 'foreign berth model lookup');
          const owner = modelOf.get(r.id);
          search.charge((owner?.points.length ?? 0) + 1, 'foreign berth point lookup');
          const at = owner?.points.findIndex(p => p.x === berth.x && p.y === berth.y) ?? -1;
          const center = owner && at >= 0 ? coordinate(owner, at, t.axis)
            : constant(JSON.stringify(['berth', r.id, i, t.axis]), berth[t.axis]);
          const decision = JSON.stringify(['berth-corridor', t.id, r.id, i]);
          const side = search.choose(decision,
            t.value <= berth[t.axis] ? ['before', 'after'] : ['after', 'before']);
          if (side === 'before') constraints(t.id, center, berth.radius, 'port-corner', decision);
          else constraints(center, t.id, berth.radius, 'port-corner', decision);
        }
      }
    }
    // The selected inequality graph needs a topological order. Dependency cycles
    // request a new corridor, rather than discarding a hard separation.
    search.charge(8 * (variables.size + edges.length + 1), 'incremental order graph');
    const outgoing = new Map([...variables.keys()].map(id => [id, [] as string[]]));
    const degree = new Map([...variables.keys()].map(id => [id, 0]));
    for (const e of edges) { outgoing.get(e.before)!.push(e.after); degree.set(e.after, degree.get(e.after)! + 1); }
    const order = [...variables.keys()].filter(id => !degree.get(id));
    for (let i = 0; i < order.length; i++) for (const after of outgoing.get(order[i])!) {
      degree.set(after, degree.get(after)! - 1); if (!degree.get(after)) order.push(after);
    }
    if (order.length !== variables.size) {
      // Backtrack only a witnessed cycle's choices. A residual graph also
      // contains outgoing tails whose alternatives cannot remove that cycle.
      search.charge(variables.size + edges.length + 1, 'incremental order conflict witness');
      const unresolved = new Set([...degree].filter(([, count]) => count > 0).map(([id]) => id));
      const graph = new Map([...unresolved].map(id => [id, [] as Separation[]]));
      for (const edge of edges) if (unresolved.has(edge.before) && unresolved.has(edge.after)) graph.get(edge.before)!.push(edge);
      const color = new Map<string, number>(), parents = new Map<string, Separation>();
      for (const root of unresolved) {
        if (color.has(root)) continue;
        const stack = [{ id: root, next: 0 }]; color.set(root, 1);
        while (stack.length) {
          search.charge(1, 'incremental cycle traversal');
          const at = stack.at(-1)!, edge = graph.get(at.id)![at.next++];
          if (!edge) { color.set(at.id, 2); stack.pop(); continue; }
          if (!color.has(edge.after)) {
            parents.set(edge.after, edge); color.set(edge.after, 1); stack.push({ id: edge.after, next: 0 });
          } else if (color.get(edge.after) === 1) {
            const cycle = [edge];
            for (let id = edge.before; id !== edge.after;) {
              search.charge(1, 'incremental cycle witness');
              const prior = parents.get(id)!; cycle.push(prior); id = prior.before;
            }
            const relevant = cycle.flatMap(link => decisions.has(link.id) ? [decisions.get(link.id)!] : []);
            search.reject(['incremental segment order cycle', ...cycle.map(link => link.id)], 'topology', relevant);
          }
        }
      }
      search.reject(['incremental segment order cycle']);
    }
    // A newly imported track whose preferred coordinate already satisfies every
    // hard residual needs no projection. The kernel closes only the conflicting
    // free components after eliminating the committed constants.
    const solved = solveRoutingComponents({ variables: [...variables.values()], order, separations: edges }, [], search.charge);
    if (!solved.ok) {
      search.charge(solved.conflict.constraints.length + 1, 'incremental metric decision witness');
      return search.reject(solved.conflict.constraints, 'metric',
        solved.conflict.constraints.flatMap(id => decisions.has(id) ? [decisions.get(id)!] : []));
    }
    const paths = new Map(models.map(m => [m.route.id, m.points.every((p, i) =>
      solved.positions.get(coordinate(m, i, 'x')) === p.x && solved.positions.get(coordinate(m, i, 'y')) === p.y) ? m.route.path : m.raw.map((raw, i) => {
      const x = solved.positions.get(coordinate(m, i, 'x'))!, y = solved.positions.get(coordinate(m, i, 'y'))!;
      return x === m.points[i].x && y === m.points[i].y ? raw : `${i ? 'L' : 'M'}${x} ${y}${seed.fragments ? ' ' : ''}`;
    }).join(seed.fragments ? '' : ' ')]));
    const drawing = { ...topology, routes: topology.routes.map(r => !paths.has(r.id) || paths.get(r.id) === r.path ? r : { ...r, path: paths.get(r.id)! }) };
    if (seed.fragments) {
      const retained = bindRoutingFragmentTopology(seed.fragments, drawing, search.charge, true);
      if (!retained.ok) search.reject(retained.conflict.constraints, 'metric');
    } else {
      const conflict = retainedRoutingConflict(seed.problem, [scene(drawing)], search.charge);
      if (conflict) search.reject(conflict.constraints, 'metric');
    }
    const tiles = chargedNativeTileClearance(drawing, search.charge);
    if (!tiles.ok) return search.reject(['native tile admission', tiles.failure]);
    const native = chargedNativeClearance(drawing, (work, reason) => search.charge(2 * work, reason));
    if (native) return search.reject(['native admission', native]);
    if (!prepayIndependentAdmission(drawing, request.items, tiles.samples, search.charge))
      return search.reject(['independent admission spatial reach'], 'invalid');
    if (!prepayRoutingGateSerialization(drawing, request.items, request.band!.key, request.maxWidth, search.charge))
      return search.reject(['unsupported independent gate serialization'], 'invalid');
    const gate = geometryGate(drawing, request.items, request.band!.key, request.maxWidth);
    if (gate) search.reject(['independent geometry gate', gate]);
    return { drawing, solved: solved.solved.length };
  }, budget);
  return result.ok ? { ok: true, ...result.value, work: result.work }
    : failure(result.conflict.kind === 'search-exhausted' ? 'budget-exhaustion'
      : result.conflict.kind === 'metric' ? 'metric-conflict'
      : result.conflict.kind === 'invalid' ? 'unsupported-input' : 'topology-conflict', result.conflict.constraints, result.work);
}
