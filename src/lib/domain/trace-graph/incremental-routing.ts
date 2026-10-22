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
import { IntervalIndex } from './interval-index';
import { LANE_SEPARATION, PORT_BERTH } from './metrics';
import { chargeRoutingSnapshot, importCommittedRouting, retainedRoutingConflict, type CommittedRoutingProblem } from './routing-problem';
import { solveRoutingComponents } from './routing-components';
import { chargedNativeTileClearance, chargedNativeClearance } from './native-route-clearance';
import { prepayIndependentAdmission } from './routing-admission-work';
import { prepayRoutingGateSerialization } from './routing-serialization-work';
import { searchCorridors, type CorridorSearch } from './corridor-search';
import type { CoordinateVariable, Separation } from './separation';
import { captureRoutingFragments, bindRoutingFragmentTopology, fragmentCoordinateKey,
  type RetainedRoutingFragments, type ConstructionFragments, type FragmentTopologyBindings, type FragmentCaptureOptions } from './routing-fragments';
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
  choose: CorridorSearch['choose'], reserve: CorridorSearch['reserve'], fragments?: ConstructionFragments) => GraphLayout | IncrementalRoutingConflict;
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
/** Broad-phase cell of the affected solve's reach index (one lane row of tiles). */
const REACH_CELL = 64;
const lazy = <T>(make: () => T): (() => T) => { let made: { value: T } | undefined; return () => (made ??= { value: make() }).value; };
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

/** The part of a request an insertion attempt reads, which its snapshot
 * charges cover. An attempt reads the committed history only through the
 * attachment placement (stem room and cover frame); the earlier published
 * scenes it also carries (layout, placed, observations) are never read, so
 * charging their traversal would bill a request by its past, not its work. */
export function attemptRequestView(request: LayoutRequest): unknown {
  if (!request || typeof request !== 'object') return request;
  const placement = request.history && typeof request.history === 'object' ? request.history.attachment?.placement : undefined;
  return { ...request, history: placement === undefined ? undefined : { attachment: { placement } } };
}

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
  chargeRoutingSnapshot([attemptRequestView(request), previous], charge);
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
  frames: readonly RoutingFrameEquality[] = [], charge: (work: number, reason?: string) => void = () => {},
  options: FragmentCaptureOptions = {}):
  IncrementalRoutingSeed | IncrementalRoutingConflict {
  chargeRoutingSnapshot([attemptRequestView(request), previous, preferred, frames], charge);
  if (!validRequest(request) || !isLayoutShape(previous) || !isLayoutShape(preferred))
    return { reason: 'unsupported-input', constraints: ['framed request/drawing shape'] };
  const projected = projectCommittedRouting(previous, request, charge);
  if (request.items.some(item => { const old = preferred.nodes.get(item.key); return old && (old.width !== item.width || old.height !== item.height); }))
    return { reason: 'unsupported-input', constraints: ['declared framed request sizes'] };
  const captured = captureRoutingFragments({ id: 'before', space: 'attached', drawing: projected },
    { id: 'derived', space: 'attached', drawing: preferred }, frames, charge, options);
  if (!captured.ok) return { reason: 'unsupported-input', constraints: captured.conflict.constraints };
  // The fragment capture already imported the projected source once; its
  // problem is that import, so it is reused rather than imported again.
  return { drawing: structuredClone(preferred), problem: captured.problem, fragments: captured.retained };
}

/** Construction's own copy of a fragment authority: only what construction
 * reads (`ConstructionFragments`) is snapshotted and cloned, so a constructor
 * can neither mutate the metric's captured authority nor be billed for the
 * metric tables and frame equations it never reads. Pins are read through a
 * lookup, never a mutable reference. */
function constructionView(retained: RetainedRoutingFragments): { readonly copied: Omit<ConstructionFragments, 'pins'>; readonly pins: ConstructionFragments['pins'] } {
  const { paths, ports, stubs } = retained.source.plan, { nodes, junctions } = retained.preferred.drawing;
  return { copied: { source: { plan: { paths, ports, stubs } }, preferred: { id: retained.preferred.id, drawing: { nodes, junctions } },
    fragments: retained.fragments, intervals: retained.intervals }, pins: { get: id => retained.pins.get(id) } };
}

/** The first constraint of a budget decline the capture predicted before construction. */
export const PREDICTED_DECLINE = 'predicted decline';

/** One ledger owns capture, topology construction and the affected metric solve.
 * Construction must charge its bounded work before executing it. No failed
 * attempt can turn a constant into a preferred coordinate on the next attempt.
 * A candidate whose capture costs more than `captureLimit` declines as budget
 * exhaustion before construction (early decline prediction). */
export function routeCommittedIncremental(request: LayoutRequest, previous: GraphLayout,
  construct: IncrementalTopologyConstructor, budget = 64_000_000, pane?: { readonly left: number; readonly right: number },
  prepare?: IncrementalFrameFactory, admit?: IncrementalAdmission, captureLimit = Infinity): IncrementalRoutingResult {
  // Capture and the retained port repair depend on no search choice unless a
  // frame policy chooses. They then run once, on the first candidate, and
  // every later candidate (another embedding family or corridor choice)
  // builds on that same captured authority instead of capturing and repairing
  // the whole retained drawing again. Their work is charged once.
  let captured: IncrementalRoutingSeed | undefined;
  const result = searchCorridors(search => {
    let seed = captured;
    if (!seed) {
      let chose = false;
      const choose: CorridorSearch['choose'] = (id, choices) => { chose = true; return search.choose(id, choices); };
      seed = captureSeed(search, choose);
      if (!chose) captured = seed;
    }
    return constructAndSolve(search, seed, seed === captured);
  }, budget);
  function captureSeed(search: CorridorSearch, choose: CorridorSearch['choose']): IncrementalRoutingSeed {
    const start = search.remaining;
    let seed: IncrementalRoutingSeed | IncrementalRoutingConflict;
    if (prepare) {
      chargeRoutingSnapshot([attemptRequestView(request), previous], search.charge);
      if (!validRequest(request) || !isLayoutShape(previous)) return search.reject(['framed request/drawing shape'], 'invalid');
      const projected = projectCommittedRouting(previous, request, search.charge);
      let snapshot: GraphLayout;
      try { snapshot = structuredClone(projected); }
      catch (error) {
        if (error instanceof Error && error.name === 'DataCloneError') return search.reject(['framed source is not cloneable'], 'invalid');
        throw error;
      }
      const frame = prepare(snapshot, search.charge, choose);
      if (!frame || typeof frame !== 'object') return search.reject(['framed policy result'], 'invalid');
      chargeRoutingSnapshot(frame, search.charge);
      if ('reason' in frame && !validConflict(frame)) return search.reject(['framed policy conflict shape'], 'invalid');
      // Band insertion binds convergence entries by their meeting, so a free
      // retained core may move with the start of the entry run it feeds.
      seed = 'reason' in frame ? frame : captureFramedIncrementalRouting(request, previous, frame.preferred, frame.frames, search.charge,
        { meetingEntries: true });
    } else seed = captureIncrementalRouting(request, previous, search.charge);
    if (!('problem' in seed)) return search.reject(seed.constraints, seed.reason === 'unsupported-input' ? 'invalid'
      : seed.reason === 'budget-exhaustion' ? 'search-exhausted' : seed.reason === 'metric-conflict' ? 'metric' : 'topology');
    // Early decline prediction: capture cost grows with the retained drawing, and
    // so do construction and admission. A capture this large measurably leaves too
    // little of the allowance to finish, so stop before construction spends it.
    if (start - search.remaining > captureLimit) return search.reject([PREDICTED_DECLINE, 'capture share'], 'search-exhausted');
    // Free retained cores give way to newly active source ports before
    // construction, inside the same affected metric (retained-track port repair).
    if (seed.fragments) seed = clearRetainedPorts(request, seed, search, pane);
    return seed;
  }
  function constructAndSolve(search: CorridorSearch, seed: IncrementalRoutingSeed, shared: boolean): { readonly drawing: GraphLayout; readonly solved: number } {
    // Construction may defer free old cores while treating the selected native
    // fragments as hard obstacles. Give it a separate, prepaid snapshot so a
    // constructor cannot mutate the metric's captured authority.
    let fragments: ConstructionFragments | undefined;
    if (seed.fragments) {
      const view = constructionView(seed.fragments);
      chargeRoutingSnapshot(view.copied, search.charge);
      fragments = { ...structuredClone(view.copied), pins: view.pins };
    }
    // A seed shared across candidates hands each one its own prepaid drawing,
    // so a rejected candidate's edits never reach the next candidate.
    let drawing = seed.drawing;
    if (shared) {
      chargeRoutingSnapshot(drawing, search.charge);
      drawing = structuredClone(drawing);
    }
    const topology = construct(drawing, search.charge, search.choose, search.reserve, fragments);
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
  }
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
    const { drawing, solved } = solveAffectedTracks(search, request, seed, topology, pane, []);
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
    return { drawing, solved };
  }, budget);
  return result.ok ? { ok: true, ...result.value, work: result.work } : searchFailure(result.conflict, result.work);
}

const searchFailure = (conflict: { readonly kind: string; readonly constraints: readonly string[] }, work: number) =>
  failure(conflict.kind === 'search-exhausted' ? 'budget-exhaustion' : conflict.kind === 'metric' ? 'metric-conflict'
    : conflict.kind === 'invalid' ? 'unsupported-input' : 'topology-conflict', conflict.constraints, work) as
    { readonly ok: false; readonly conflict: IncrementalRoutingConflict; readonly work: number };

/** A source port that a request newly activates: the bottom or right port of a
 * retained parent of a new item (the band cover departs only through its bottom). */
export interface ReservedPort { readonly owner: string; readonly side: 'bottom' | 'right'; readonly x: number; readonly y: number }

/** Newly activated source ports that a retained route of another source passes
 * within the port berth. Only these can need a retained track to give way. */
export function blockedSourcePorts(request: LayoutRequest, drawing: GraphLayout,
  charge: (work: number, reason?: string) => void = () => {}): readonly ReservedPort[] {
  charge(request.items.length + 1, 'newly active port scan');
  const ports: ReservedPort[] = [], seen = new Set<string>();
  for (const item of request.items) {
    if (drawing.nodes.has(item.key)) continue;
    charge(item.parents.length + 1, 'newly active port parents');
    for (const key of item.parents) {
      const p = drawing.nodes.get(key);
      if (!p || seen.has(key)) continue;
      seen.add(key);
      ports.push({ owner: key, side: 'bottom', x: p.x + p.width / 2, y: p.y + p.height });
      if (key !== request.band?.key) ports.push({ owner: key, side: 'right', x: p.x + p.width, y: p.y + p.height / 2 });
    }
  }
  if (!ports.length) return ports;
  const blocked = new Set<ReservedPort>();
  for (const route of drawing.routes) {
    charge(8 * route.path.length + 1, 'port blocker parsing');
    const ss = segments(route.path);
    charge(ss.length * ports.length + 1, 'port blocker scan');
    for (const port of ports) {
      if (blocked.has(port) || route.from.kind === 'node' && route.from.id === port.owner) continue;
      if (ss.some(([a, b]) => distanceToSegment(port, a, b) < PORT_BERTH)) blocked.add(port);
    }
  }
  return ports.filter(port => blocked.has(port));
}

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const reservedCenter = (port: ReservedPort, axis: 'x' | 'y') => JSON.stringify(['reserved-port', port.owner, port.side, axis]);

/** Retained-track port repair (the metric counterpart of the deleted legacy T24). Each free
 * retained core within a newly active source port's berth gets one more hard
 * separation from that port, its side a corridor choice; the same affected
 * solve moves it and anything it pushes, in the drawn order. Native spans,
 * source prefixes, suffixes, ports, tiles and dots stay constants. The result
 * is a preferred retained pose for construction, not an admitted drawing: the
 * final solve and the independent gate still certify the completed topology. */
export function clearIncrementalPorts(request: LayoutRequest, seed: IncrementalRoutingSeed,
  ports: readonly ReservedPort[], budget = 64_000_000, pane?: { readonly left: number; readonly right: number }):
  { readonly ok: true; readonly drawing: GraphLayout; readonly work: number }
  | { readonly ok: false; readonly conflict: IncrementalRoutingConflict; readonly work: number } {
  if (!seed.fragments) return { ok: false, conflict: { reason: 'unsupported-input', constraints: ['port repair needs a fragment authority'] }, work: 0 };
  const result = searchCorridors(search => solveAffectedTracks(search, request, seed, seed.drawing, pane, ports).drawing, budget);
  return result.ok ? { ok: true, drawing: result.value, work: result.work } : searchFailure(result.conflict, result.work);
}

/** Clear every blocked port that the constants allow, within a capped share of
 * the remaining ledger so a repair can never starve construction. A port whose
 * separation conflicts with constants is named by the metric witness and stays
 * blocked; a witness naming no port pin drops the last port instead. Either
 * way each retry clears at least one fewer port, so the loop is bounded. On
 * exhausting its share the drawn pose is kept and construction proceeds. */
export const PORT_REPAIR_SHARE = 4;
function clearRetainedPorts(request: LayoutRequest, seed: IncrementalRoutingSeed, search: CorridorSearch,
  pane?: { readonly left: number; readonly right: number }): IncrementalRoutingSeed {
  let ports = blockedSourcePorts(request, seed.drawing, search.charge);
  while (ports.length) {
    const cleared = clearIncrementalPorts(request, seed, ports, Math.floor(search.remaining / PORT_REPAIR_SHARE), pane);
    search.charge(cleared.work, 'retained port repair');
    if (cleared.ok) return { ...seed, drawing: cleared.drawing };
    if (cleared.conflict.reason === 'budget-exhaustion') return seed;
    const ids = ports.map(port => (['x', 'y'] as const).map(axis => JSON.stringify(['topology-constant', reservedCenter(port, axis)])));
    search.charge(cleared.conflict.constraints.reduce((sum, c) => sum + c.length + 1, 0) * ports.length
      + ids.flat().reduce((sum, id) => sum + id.length + 1, 0) + 1, 'retained port repair witness');
    const witnessed = new Set(ports.filter((_, i) => ids[i].some(id =>
      cleared.conflict.constraints.some(c => c === id || c.startsWith(id + ':')))));
    ports = witnessed.size ? ports.filter(port => !witnessed.has(port)) : ports.slice(0, -1);
  }
  return seed;
}

/** The affected metric over one chosen topology: free tracks, their corridor
 * sides and every hard separation, then the retained-constant check. */
function solveAffectedTracks(search: CorridorSearch, request: LayoutRequest, seed: IncrementalRoutingSeed, topology: GraphLayout,
  pane: { readonly left: number; readonly right: number } | undefined, reserved: readonly ReservedPort[]):
  { readonly drawing: GraphLayout; readonly solved: number } {
  chargeRoutingSnapshot(attemptRequestView(request), search.charge);
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
  // Every coordinate a modelled route point resolves to; with the separations'
  // ends, these are the only variables the solve can read back.
  const referenced = new Set<string>();
  const coordinate = (m: RouteModel, index: number, axis: 'x' | 'y'): string => {
    search.charge(m.tracks.length + 1, 'free track coordinate lookup');
    const id = fragmentBindings?.coordinates.get(fragmentCoordinateKey(m.route.id, index, axis))
      ?? m.tracks.find(t => t.axis === axis && (t.command === index || t.command - 1 === index))?.id
      ?? constant(JSON.stringify([m.route.id, index, axis]), m.points[index][axis]);
    referenced.add(id);
    return id;
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
  // A free core inside a reserved port's berth (never the port owner's own route).
  const blocks = (t: Track, port: ReservedPort): boolean => {
    const along = t.axis === 'x' ? 'y' : 'x';
    return !(t.route.from.kind === 'node' && t.route.from.id === port.owner)
      && port[along] >= Math.min(t.a[along], t.b[along]) && port[along] <= Math.max(t.a[along], t.b[along])
      && Math.abs(port[t.axis] - t.value) < PORT_BERTH;
  };
  // Tiles, parallel segments and berths only constrain a track whose span they
  // reach along it. Index them by that extent once; candidates come back in
  // drawing order, so every constraint and choice is made exactly as a full scan.
  const tiles = [...topology.nodes.values()];
  search.charge(tiles.length + topology.routes.length + 1, 'affected reach index');
  const tileReach = (along: 'x' | 'y') => new IntervalIndex(tiles.map(n => along === 'y'
    ? [n.y - TILE_GRAZE, n.y + n.height + TILE_GRAZE] as const : [n.x - TILE_GRAZE, n.x + n.width + TILE_GRAZE] as const),
    REACH_CELL, search.charge);
  // Pieces of routes a track might meet: a parallel segment, or a berth, within
  // its span. Hits come back in drawing order: by route, segments then berths.
  const routeReach = (axis: 'x' | 'y') => {
    const along = axis === 'x' ? 'y' : 'x', pieces: { readonly owner: number; readonly berth: boolean; readonly at: number }[] = [];
    const spans: (readonly [number, number])[] = [];
    topology.routes.forEach((r, owner) => {
      const { ss, berths } = foreign(r);
      ss.forEach(([a, b], at) => {
        if (a[axis] === b[axis]) { pieces.push({ owner, berth: false, at }); spans.push([Math.min(a[along], b[along]), Math.max(a[along], b[along])]); }
      });
      berths.forEach((berth, at) => { pieces.push({ owner, berth: true, at }); spans.push([berth[along], berth[along]]); });
    });
    const index = new IntervalIndex(spans, REACH_CELL, search.charge);
    return (lo: number, hi: number) => index.query(lo, hi, search.charge).map(i => pieces[i]);
  };
  const reach = { x: { tiles: lazy(() => tileReach('y')), routes: lazy(() => routeReach('x')) },
    y: { tiles: lazy(() => tileReach('x')), routes: lazy(() => routeReach('y')) } };
  // Choose an empty tile corridor for each free segment. Its longitudinal span
  // remains part of the topology; the final independent gate checks all paint.
  for (const t of tracks) {
    const along = t.axis === 'x' ? 'y' : 'x';
    const lo = Math.min(t.a[along], t.b[along]), hi = Math.max(t.a[along], t.b[along]);
    for (const index of reach[t.axis].tiles().query(lo, hi, search.charge)) {
      const n = tiles[index];
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
    let owner = -1, own = false;
    for (const piece of reach[t.axis].routes()(lo, hi)) {
      const r = topology.routes[piece.owner];
      if (piece.owner !== owner) { owner = piece.owner; own = sameSource(r, t.route, search.charge); }
      if (own) continue;
      const { ss, berths } = foreign(r), i = piece.at;
      if (!piece.berth) {
        search.charge(1, 'foreign corridor');
        const [a, b] = ss[i];
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
        continue;
      }
      search.charge(1, 'foreign berths');
      const berth = berths[i];
      if (berth[along] < lo || berth[along] > hi) continue;
      // Intentional convergence belongs to the native meeting model; moving
      // an internal track cannot invent another junction input.
      if ([r.from, r.to].some(e => e.kind === 'junction' && [t.route.from, t.route.to].some(f => f.kind === e.kind && f.id === e.id))) continue;
      if (Math.abs(berth[t.axis] - t.value) >= berth.radius) continue;
      search.charge(1, 'foreign berth model lookup');
      const ownerModel = modelOf.get(r.id);
      search.charge((ownerModel?.points.length ?? 0) + 1, 'foreign berth point lookup');
      const at = ownerModel?.points.findIndex(p => p.x === berth.x && p.y === berth.y) ?? -1;
      const center = ownerModel && at >= 0 ? coordinate(ownerModel, at, t.axis)
        : constant(JSON.stringify(['berth', r.id, i, t.axis]), berth[t.axis]);
      const decision = JSON.stringify(['berth-corridor', t.id, r.id, i]);
      const side = search.choose(decision,
        t.value <= berth[t.axis] ? ['before', 'after'] : ['after', 'before']);
      if (side === 'before') constraints(t.id, center, berth.radius, 'port-corner', decision);
      else constraints(center, t.id, berth.radius, 'port-corner', decision);
    }
    search.charge(reserved.length + 1, 'reserved ports');
    for (const port of reserved) {
      if (!blocks(t, port)) continue;
      const decision = JSON.stringify(['reserved-port', t.id, port.owner, port.side]);
      const side = search.choose(decision, t.value <= port[t.axis] ? ['before', 'after'] : ['after', 'before']);
      const center = constant(reservedCenter(port, t.axis), port[t.axis]);
      if (side === 'before') constraints(t.id, center, PORT_BERTH, 'reserved-port', decision);
      else constraints(center, t.id, PORT_BERTH, 'reserved-port', decision);
    }
  }
  // The selected inequality graph needs a topological order. Dependency cycles
  // request a new corridor, rather than discarding a hard separation.
  // A pinned variable that no separation and no route point references is an
  // isolated constant: the captured pins were validated at capture, and the
  // kernel would return it unchanged. Only referenced variables enter the
  // order graph and the kernel, in the same relative order, so every free
  // component, choice and position is as with the whole table.
  search.charge(variables.size + edges.length + 1, 'referenced metric variables');
  for (const e of edges) { referenced.add(e.before); referenced.add(e.after); }
  for (const [id, variable] of variables) if (variable.pin && !referenced.has(id)) variables.delete(id);
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
  return { drawing, solved: solved.solved.length };
}
