/** Selective retained paint. Raw source coordinates and semantic identities are
 * immutable; straight cores between declared spans remain metric preferences.
 * The strict whole-route importer remains the default incremental contract. */
import type { GraphLayout, PlacedRoute } from './layout';
import { isLayoutShape } from './history-boundary';
import { eachConsumer } from './route-consumers';
import { sameRoutingOwnership, chargeRoutingConsumers } from './routing-consumer-work';
import { importRoutingPlan, RoutingImportError, type NativeInk, type RoutingPlan } from './routing-plan';
import { chargeRoutingSnapshot, importCommittedRouting, committedRoutingCoordinates, bindRoutingFrameConstants,
  routingCoordinate, type CommittedRoutingProblem, type CommittedRoutingScene, type RoutingFrameEquality } from './routing-problem';
import type { RoutingMetricConflict, RoutingMetricProblem } from './routing-components';
import type { Point } from './path-sampling';
import { ARROW } from './metrics';
import { convergenceBounds } from './routing-convergence';

interface NativeFragment {
  readonly id: string;
  readonly route: string;
  /** Source identity. Emitted command ordinals are resolved separately. */
  readonly primitive: number;
  readonly native: NativeInk;
  readonly raw: string;
  readonly sourcePrefix: boolean;
  readonly convergenceSuffix: boolean;
  readonly terminalSuffix: boolean;
  /** A meeting-bound convergence entry: a straight run that enters its dot's
   * berth from outside. Its end, its line and the meeting (entry point, side,
   * primitive) are bound; its start may slide along the run, staying at least
   * `boundary` beyond the berth face, so the free core before it can move. */
  readonly entry?: MeetingEntry;
}
interface MeetingEntry { readonly axis: 'x' | 'y'; readonly forward: boolean; readonly boundary: number }
/** How far outside the dot berth a meeting-bound entry run must start, so the
 * run still crosses the same face and the corner before it stays outside. */
const ENTRY_LEAD = 1;
/** Capture options. `meetingEntries` binds a convergence entry by its meeting,
 * not by the parameter where the entry run crosses the berth face. */
export interface FragmentCaptureOptions { readonly meetingEntries?: boolean }
interface SourceInterval {
  readonly route: string;
  readonly primitive: number;
  readonly start: Point;
  readonly boundary: Point;
  readonly axis: 'x' | 'y';
  readonly forward: boolean;
}
export interface RetainedRoutingFragments {
  readonly source: CommittedRoutingScene & { readonly plan: RoutingPlan };
  readonly preferred: CommittedRoutingScene;
  readonly metric: RoutingMetricProblem;
  readonly frames: readonly RoutingFrameEquality[];
  readonly fragments: readonly NativeFragment[];
  readonly intervals: readonly SourceInterval[];
  readonly pins: ReadonlyMap<string, number>;
  /** The selected pins every binding re-verifies: all but native path and
   * meeting scalars, which bind as spans and convergence entries instead.
   * Classified once at capture, so a binding does not re-read every address. */
  readonly scalars: readonly (readonly [string, number])[];
  readonly heads: ReadonlyMap<string, string>;
}
/** What topology construction reads from a fragment authority: the source
 * plan's paths, ports and stubs, the retained-only pose's tiles and dots, the
 * protected spans and source intervals, and read access to selected pins. The
 * metric tables, frame equations and raw source drawing stay with the metric. */
export interface ConstructionFragments {
  readonly source: { readonly plan: Pick<RoutingPlan, 'paths' | 'ports' | 'stubs'> };
  readonly preferred: { readonly id: string; readonly drawing: Pick<GraphLayout, 'nodes' | 'junctions'> };
  readonly fragments: readonly NativeFragment[];
  readonly intervals: readonly SourceInterval[];
  readonly pins: { readonly get: (id: string) => number | undefined };
}
export interface FragmentTopologyBindings {
  /** Keys address actual emitted route command endpoints, never source ordinals. */
  readonly coordinates: ReadonlyMap<string, string>;
  readonly fixed: ReadonlySet<string>;
  readonly intervals: readonly { readonly route: string; readonly command: number; readonly axis: 'x' | 'y';
    readonly forward: boolean; readonly boundary: number }[];
}
const rawCommands = (route: PlacedRoute) => [...route.path.matchAll(/[MLC][^MLC]*/g)].map(match => match[0]);
const coordinateKey = (route: string, command: number, axis: 'x' | 'y') => JSON.stringify([route, command, axis]);
export const fragmentCoordinateKey = coordinateKey;
const samePoint = (a: Point, b: Point) => Object.is(a.x, b.x) && Object.is(a.y, b.y);
const invalid = (variable: string, ...constraints: readonly string[]): RoutingMetricConflict =>
  ({ kind: 'invalid', variable, constraints });
const equality = (variable: string, ...constraints: readonly string[]): RoutingMetricConflict =>
  ({ kind: 'equality', variable, constraints });
const indexPlan = (plan: RoutingPlan, charge: (work: number, reason?: string) => void) => {
  charge(8 * (plan.paths.length + plan.ports.length + (plan.meetings?.length ?? 0) + 1), 'fragment plan indexes');
  const paths = new Map(plan.paths.map(path => [path.id, path])), ports = new Map(plan.ports.map(port => [port.id, port]));
  for (const path of plan.paths) charge(8 * (path.native.length + 1) * (path.id.length + 1), 'fragment native identity addresses');
  const inputs = new Map<string, { readonly meeting: NonNullable<RoutingPlan['meetings']>[number];
    readonly input: NonNullable<RoutingPlan['meetings']>[number]['inputs'][number] }[]>();
  const meetings = new Map<string, NonNullable<RoutingPlan['meetings']>[number]['inputs'][number]>();
  for (const meeting of plan.meetings ?? []) {
    charge(4 * meeting.inputs.length + 1, 'fragment convergence input index');
    for (const input of meeting.inputs) {
      charge(8 * (meeting.id.length + input.path.length + input.source.length + 1), 'fragment convergence address');
      const entries = inputs.get(input.path) ?? [];
      entries.push({ meeting, input }); inputs.set(input.path, entries);
      meetings.set(JSON.stringify([meeting.id, input.path, input.source]), input);
    }
  }
  return { paths, ports, inputs, meetings };
};
const fragmentPlan = (drawing: GraphLayout, charge: (work: number, reason?: string) => void):
  { readonly ok: true; readonly plan: RoutingPlan } | { readonly ok: false; readonly conflict: RoutingMetricConflict } => {
  let chargeFailed = false;
  const checkedCharge = (work: number, reason?: string) => {
    try { charge(work, reason); } catch (error) { chargeFailed = true; throw error; }
  };
  try {
    chargeRoutingConsumers(drawing, checkedCharge);
    return { ok: true, plan: importRoutingPlan(drawing, checkedCharge) };
  } catch (error) {
    if (chargeFailed) throw error;
    if (error instanceof RoutingImportError || error instanceof RangeError)
      return { ok: false, conflict: invalid('', 'fragment native import', String(error)) };
    throw error;
  }
};

/** `preferred` is the retained-only pose derived before topology construction.
 * Every changed protected scalar needs an explicit raw-source frame equation.
 * Importing its geometry does not pin its unselected straight-core coordinates. */
export function captureRoutingFragments(before: CommittedRoutingScene, preferred: CommittedRoutingScene,
  declared: readonly RoutingFrameEquality[] = [], charge: (work: number, reason?: string) => void = () => {},
  options: FragmentCaptureOptions = {}):
  { readonly ok: true; readonly retained: RetainedRoutingFragments; readonly problem: CommittedRoutingProblem }
  | { readonly ok: false; readonly conflict: RoutingMetricConflict } {
  chargeRoutingSnapshot([before, preferred, declared], charge);
  if (!before || !preferred || typeof before.id !== 'string' || typeof preferred.id !== 'string'
    || before.id === preferred.id || before.space !== preferred.space
    || !isLayoutShape(before.drawing) || !isLayoutShape(preferred.drawing) || !Array.isArray(declared))
    return { ok: false, conflict: invalid('', 'fragment scenes') };
  if (Array.from(declared).some(frame => !frame || typeof frame.id !== 'string' || typeof frame.input !== 'string'
    || typeof frame.output !== 'string' || !Array.isArray(frame.steps))) return { ok: false, conflict: invalid('', 'fragment frame shape') };
  if (before.drawing.nodes.size !== preferred.drawing.nodes.size || before.drawing.routes.length !== preferred.drawing.routes.length
    || before.drawing.junctions.size !== preferred.drawing.junctions.size
    || [...before.drawing.nodes.keys()].some(key => !preferred.drawing.nodes.has(key)))
    return { ok: false, conflict: invalid('', 'retained-only fragment pose') };
  chargeRoutingConsumers(before.drawing, charge);
  const source = importCommittedRouting([before], [], charge);
  if (!source.ok) return source;
  const raw = source.problem.scenes[0];
  let target: CommittedRoutingScene, frames: RoutingFrameEquality[];
  try { target = structuredClone(preferred); frames = [...structuredClone(declared)]; }
  catch (error) {
    if (error instanceof Error && error.name === 'DataCloneError') return { ok: false, conflict: invalid('', 'fragment snapshot is not cloneable') };
    throw error;
  }
  const imported = fragmentPlan(target.drawing, charge);
  if (!imported.ok) return imported;
  const plan = imported.plan;
  const sourceIndex = indexPlan(raw.plan, charge), targetIndex = indexPlan(plan, charge);
  const sourceValues = new Map(source.problem.metric.variables.map(variable => [variable.id, variable.pin!.value]));
  const targetCoordinates = committedRoutingCoordinates(target, plan, charge);
  const targetValues = new Map(targetCoordinates.map(variable => [variable.id, variable.pin!.value]));
  const outputs = new Set(frames.map(frame => frame.output));
  if (frames.some(frame => !sourceValues.has(frame.input) || !targetValues.has(frame.output)))
    return { ok: false, conflict: invalid('', 'fragment frame endpoints') };
  for (const frame of frames) charge(frame.input.length + frame.output.length + frame.id.length + 1, 'fragment frame address parsing');
  if (frames.some(frame => {
    const address = JSON.parse(frame.output) as (string | number)[];
    return address[2] === 'path' && frame.input !== routingCoordinate(raw.id, ...address.slice(2));
  })) return { ok: false, conflict: invalid('', 'native frame must start at its own raw source scalar') };
  const required = new Set<string>();
  const require = (...address: readonly (string | number)[]) => required.add(routingCoordinate(target.id, ...address));
  const point = (...address: readonly (string | number)[]) => { require(...address, 'x'); require(...address, 'y'); };
  for (const [key] of raw.drawing.nodes) for (const axis of ['x', 'y', 'width', 'height']) require('tile', key, axis);
  for (const [id] of raw.drawing.junctions) point('dot', id);
  for (const port of raw.plan.ports) { point('port', port.id, 'point'); require('port', port.id, 'offset'); }
  for (const stub of raw.plan.stubs) {
    point('stub', stub.id, 'base'); point('stub', stub.id, 'tip');
    for (let i = 0; i < 2; i++) point('stub', stub.id, 'shaft', i);
  }
  const whole = new Map<string, Set<number>>(), prefixes = new Map<string, Set<number>>(), suffixes = new Map<string, Set<number>>();
  const terminals = new Map<string, Set<number>>(), entries = new Map<string, MeetingEntry & { readonly primitive: number }>();
  const partial: { readonly route: string; readonly primitive: number;
    readonly boundary: Point; readonly axis: 'x' | 'y'; readonly forward: boolean }[] = [];
  for (const path of raw.plan.paths) {
    const indices = new Set<number>(); whole.set(path.id, indices);
    const prefix = new Set<number>(), suffix = new Set<number>(); prefixes.set(path.id, prefix); suffixes.set(path.id, suffix);
    const terminal = new Set<number>(); terminals.set(path.id, terminal);
    point('path', path.id, 'native', 0, 0);
    path.native.forEach((native, i) => { if (native.length === 4) indices.add(i); });
    const head = path.native[0][0], inside = (p: Point) => Math.abs(p.x - head.x) <= 6 && Math.abs(p.y - head.y) <= 6;
    const start = sourceIndex.ports.get(path.start)!;
    if (start.owner.kind === 'tile') for (let i = 0; i < path.native.length; i++) {
      const native = path.native[i], end = native.at(-1)!;
      if (native.length === 4 || inside(end)) { indices.add(i); prefix.add(i); if (!inside(end)) break; continue; }
      const first = native[0], axis = first.x === end.x ? 'y' : first.y === end.y ? 'x' : null;
      if (!axis) return { ok: false, conflict: invalid(path.id, 'nonorthogonal departure interval') };
      const forward = end[axis] > first[axis];
      partial.push({ route: path.id, primitive: i, axis, forward,
        boundary: { ...first, [axis]: head[axis] + (forward ? 6 : -6) } });
      point('path', path.id, 'native', i, 0);
      break;
    }
    const meetingInputs = sourceIndex.inputs.get(path.id) ?? [];
    for (const { meeting, input } of meetingInputs) {
      // The protected relation is who meets whom, where and in what order.
      // A straight entry run that starts outside the berth is bound by its
      // line, its end and that meeting, so its start may slide along the run.
      const run = path.native[input.entry.primitive];
      const [first, last] = run?.length === 2 ? run : [undefined, undefined];
      const face = convergenceBounds(meeting.dot), axis = !first || !last ? null
        : first.y === last.y && first.x !== last.x ? 'x' : first.x === last.x && first.y !== last.y ? 'y' : null;
      if (options.meetingEntries && first && last && axis && meetingInputs.length === 1 && input.entry.parameter > 0
        && !prefix.has(input.entry.primitive) && !partial.some(p => p.route === path.id && p.primitive === input.entry.primitive)) {
        const forward = first[axis] > last[axis];
        const boundary = forward ? (axis === 'x' ? face.right : face.bottom) + ENTRY_LEAD : (axis === 'x' ? face.left : face.top) - ENTRY_LEAD;
        if (forward ? first[axis] >= boundary : first[axis] <= boundary)
          entries.set(path.id, { primitive: input.entry.primitive, axis, forward, boundary });
      }
      for (let i = input.entry.primitive; i < path.native.length; i++) { indices.add(i); suffix.add(i); }
      point('meeting', meeting.id, 'input', path.id, input.source, 'point');
      // A meeting-bound entry's parameter follows its start along the run.
      if (entries.get(path.id)?.primitive !== input.entry.primitive) require('meeting', meeting.id, 'input', path.id, input.source, 'parameter');
    }
    // Keep complete authored pieces of the terminal interval, including a
    // zero-length endpoint alias. A longer L contributes only its end interval.
    if (path.stub) {
      let length = 0;
      for (let i = path.native.length - 1; i >= 0; i--) {
        const run = path.native[i];
        if (run.length !== 2) break;
        length += Math.hypot(run[1].x - run[0].x, run[1].y - run[0].y);
        if (length > ARROW.length) break;
        indices.add(i); terminal.add(i);
      }
    }
    const entry = entries.get(path.id);
    for (const i of indices) for (let j = 0; j < path.native[i].length; j++) {
      if (entry?.primitive === i && j === 0) require('path', path.id, 'native', i, j, entry.axis === 'x' ? 'y' : 'x');
      else point('path', path.id, 'native', i, j);
    }
  }
  // A declaration may add a stricter constant, but can never silently leave a
  // mandatory native span or semantic boundary unconstrained.
  if (frames.some(frame => {
    const address = JSON.parse(frame.output) as (string | number)[];
    return address[2] === 'path' && !required.has(frame.output);
  })) return { ok: false, conflict: invalid('', 'undeclared native span identity') };
  for (const output of required) if (!outputs.has(output)) {
    charge(output.length + 1, 'required fragment address');
    const address = JSON.parse(output) as (string | number)[];
    const input = routingCoordinate(raw.id, ...address.slice(2));
    if (!sourceValues.has(input) || !targetValues.has(output)) return { ok: false, conflict: invalid(output, 'missing fragment coordinate') };
    frames.push({ id: JSON.stringify(['retained-fragment-identity', output]), input, output, steps: [] });
    outputs.add(output);
  }
  if (frames.some(frame => !sourceValues.has(frame.input) || !targetValues.has(frame.output)))
    return { ok: false, conflict: invalid('', 'fragment frame endpoints') };
  charge(8 * (targetCoordinates.length + required.size + frames.length + 1), 'selected fragment coordinate tables');
  const selected = targetCoordinates.filter(variable => outputs.has(variable.id));
  const bound = bindRoutingFrameConstants([...source.problem.metric.variables, ...selected], frames, charge);
  if (!bound.ok) return bound;
  const pins = new Map(selected.map(variable => [variable.id, variable.pin!.value]));
  const value = (...address: readonly (string | number)[]) => pins.get(routingCoordinate(target.id, ...address))!;
  const nativePoint = (route: string, i: number, j: number): Point =>
    ({ x: value('path', route, 'native', i, j, 'x'), y: value('path', route, 'native', i, j, 'y') });
  const fragments: NativeFragment[] = [], heads = new Map<string, string>();
  for (const path of raw.plan.paths) {
    const next = targetIndex.paths.get(path.id);
    if (!next || !path.route || !next.route || !sameRoutingOwnership(path.route, next.route, charge))
      return { ok: false, conflict: equality(path.id, 'retained route ownership') };
    charge(8 * (path.route.path.length + next.route.path.length + 1), 'fragment raw command spans');
    const sourceRaw = rawCommands(path.route), targetRaw = rawCommands(next.route);
    const oldHead = path.native[0][0], nextHead = next.native[0]?.[0];
    if (!nextHead || samePoint(oldHead, nextHead) && sourceRaw[0] !== targetRaw[0])
      return { ok: false, conflict: equality(path.id, 'retained raw source command') };
    heads.set(path.id, targetRaw[0]);
    const entry = entries.get(path.id);
    for (const i of [...whole.get(path.id)!].sort((a, b) => a - b)) {
      const actual = next.native[i];
      // A meeting-bound entry's start along the run is not selected: it is
      // whatever the derived pose has, checked against its bound instead.
      const open = entry?.primitive === i ? entry : undefined;
      if (open && (!actual || actual.length !== 2 || (open.forward ? actual[0][open.axis] < open.boundary : actual[0][open.axis] > open.boundary)))
        return { ok: false, conflict: equality(path.id, 'retained frame primitive') };
      const expected = path.native[i].map((_, j) => open && j === 0
        ? { ...nativePoint(path.id, i, 1), [open.axis === 'x' ? 'y' : 'x']: value('path', path.id, 'native', i, 0, open.axis === 'x' ? 'y' : 'x'), [open.axis]: actual![0][open.axis] }
        : nativePoint(path.id, i, j)) as unknown as NativeInk;
      if (!actual || actual.length !== expected.length || actual.some((p, j) => !samePoint(p, expected[j])))
        return { ok: false, conflict: equality(path.id, 'retained frame primitive') };
      if (expected.every((p, j) => samePoint(p, path.native[i][j])) && sourceRaw[i + 1] !== targetRaw[i + 1])
        return { ok: false, conflict: equality(path.id, 'retained raw native span') };
      fragments.push({ id: JSON.stringify(['retained-span', path.id, i]), route: path.id, primitive: i,
        native: expected, raw: targetRaw[i + 1], sourcePrefix: prefixes.get(path.id)!.has(i),
        convergenceSuffix: suffixes.get(path.id)!.has(i), terminalSuffix: terminals.get(path.id)!.has(i),
        ...(open ? { entry: { axis: open.axis, forward: open.forward, boundary: open.boundary } } : {}) });
    }
  }
  const intervals: SourceInterval[] = partial.map(interval => ({ ...interval,
    start: nativePoint(interval.route, interval.primitive, 0),
    // The mandatory semantic berth is measured from the declared native head.
    // Adding another equality cannot shorten it through an unrelated recipe.
    boundary: { ...nativePoint(interval.route, interval.primitive, 0),
      [interval.axis]: nativePoint(interval.route, 0, 0)[interval.axis] + (interval.forward ? 6 : -6) } }));
  // Native command positions and convergence ordinals are emitter bindings.
  const scalars: (readonly [string, number])[] = [];
  for (const [id, value] of pins) {
    charge(id.length + 1, 'retained fragment address classification');
    const address = JSON.parse(id) as (string | number)[];
    if (address[2] !== 'path' && address[2] !== 'meeting') scalars.push([id, value]);
  }
  const retained = { source: raw, preferred: target, metric: bound.metric, frames, fragments, intervals, pins, scalars, heads };
  const checked = bindRoutingFragmentTopology(retained, target.drawing, charge, true);
  return checked.ok ? { ok: true, retained, problem: source.problem } : checked;
}

/** Resolve stable source spans in an emitted topology. Extra free L commands do
 * not rename an authored C, convergence entry or source interval. */
export function bindRoutingFragmentTopology(retained: RetainedRoutingFragments, drawing: GraphLayout,
  charge: (work: number, reason?: string) => void = () => {}, final = false):
  { readonly ok: true; readonly bindings: FragmentTopologyBindings } | { readonly ok: false; readonly conflict: RoutingMetricConflict } {
  chargeRoutingSnapshot(drawing, charge);
  if (!isLayoutShape(drawing)) return { ok: false, conflict: invalid('', 'fragment topology shape') };
  const imported = fragmentPlan(drawing, charge);
  if (!imported.ok) return imported;
  const plan = imported.plan, coordinates = new Map<string, string>(), fixed = new Set<string>();
  const planIndex = indexPlan(plan, charge);
  charge(8 * (drawing.routes.length + retained.fragments.length + retained.intervals.length + retained.pins.size + 1), 'fragment binding tables');
  const routes = new Map(drawing.routes.map(route => [route.id, route]));
  const byRoute = new Map<string, NativeFragment[]>();
  for (const fragment of retained.fragments) {
    const entries = byRoute.get(fragment.route) ?? []; entries.push(fragment); byRoute.set(fragment.route, entries);
  }
  const indices = new Map<string, number>(), bound: FragmentTopologyBindings['intervals'][number][] = [];
  const open = new Set<string>();
  for (const fragment of retained.fragments) if (fragment.entry) open.add(fragment.id);
  for (const route of retained.source.drawing.routes) {
    const next = routes.get(route.id);
    if (!next || !sameRoutingOwnership(route, next, charge)) return { ok: false, conflict: equality(route.id, 'retained route ownership') };
    charge(8 * next.path.length + 1, 'fragment emitted command spans');
    const path = planIndex.paths.get(route.id)!, raw = rawCommands(next);
    if (raw[0] !== retained.heads.get(route.id)) return { ok: false, conflict: equality(route.id, 'retained raw source command') };
    for (const axis of ['x', 'y'] as const) {
      const key = coordinateKey(route.id, 0, axis);
      fixed.add(key); coordinates.set(key, routingCoordinate(retained.preferred.id, 'path', route.id, 'native', 0, 0, axis));
    }
    let cursor = 0, suffixStarted = false;
    for (const fragment of byRoute.get(route.id) ?? []) {
      let found = -1;
      const start = fragment.sourcePrefix ? fragment.primitive : cursor;
      const end = fragment.sourcePrefix || suffixStarted ? start + 1 : path.native.length;
      for (let i = start; i < end; i++) {
        if (!path.native[i]) break;
        charge(path.native[i].length + raw[i + 1].length + 1, 'retained native span binding');
        const native = path.native[i], open = fragment.entry;
        if (raw[i + 1] === fragment.raw && native.length === fragment.native.length && (open
          ? samePoint(native[1], fragment.native[1]) && Object.is(native[0][open.axis === 'x' ? 'y' : 'x'], fragment.native[0][open.axis === 'x' ? 'y' : 'x'])
            && (open.forward ? native[0][open.axis] >= open.boundary : native[0][open.axis] <= open.boundary)
          : native.every((p, j) => samePoint(p, fragment.native[j])))) { found = i; break; }
      }
      if (found < 0) return { ok: false, conflict: equality(fragment.id, 'retained native span') };
      suffixStarted ||= fragment.convergenceSuffix || fragment.terminalSuffix;
      cursor = found + 1; indices.set(fragment.id, found);
      // A meeting-bound entry keeps its start's line; its position along the
      // run is the neighbouring core's track, bounded outside the berth.
      if (fragment.entry) bound.push({ route: route.id, command: found, axis: fragment.entry.axis,
        forward: fragment.entry.forward, boundary: fragment.entry.boundary });
      for (const [command, j] of [[found, 0], [found + 1, fragment.native.length - 1]]) for (const axis of ['x', 'y'] as const) {
        if (fragment.entry && command === found && axis === fragment.entry.axis) continue;
        const key = coordinateKey(route.id, command, axis);
        fixed.add(key); coordinates.set(key, routingCoordinate(retained.preferred.id, 'path', route.id, 'native', fragment.primitive, j, axis));
      }
    }
    if (suffixStarted && cursor !== path.native.length) return { ok: false, conflict: equality(route.id, 'retained complete convergence suffix') };
  }
  // Native path and meeting scalars are emitter bindings, verified above as
  // spans and below as convergence entries; only the other kinds are compared.
  const actual = new Map(committedRoutingCoordinates({ ...retained.preferred, drawing }, plan, charge, false).map(variable => [variable.id, variable.pin!.value]));
  for (const [id, value] of retained.scalars) {
    charge(id.length + 1, 'retained fragment address verification');
    if (!Object.is(actual.get(id), value)) return { ok: false, conflict: equality(id, 'retained fragment scalar') };
  }
  for (const port of retained.source.plan.ports) {
    const next = planIndex.ports.get(port.id);
    if (!next || next.owner.kind !== port.owner.kind || next.owner.id !== port.owner.id || next.side !== port.side)
      return { ok: false, conflict: equality(port.id, 'retained port identity') };
  }
  for (const [id, dot] of retained.source.drawing.junctions) if (JSON.stringify(drawing.junctions.get(id)?.parents) !== JSON.stringify(dot.parents))
    return { ok: false, conflict: equality(id, 'retained painted dot ownership') };
  for (const meeting of retained.source.plan.meetings ?? []) for (const input of meeting.inputs) {
    const next = planIndex.meetings.get(JSON.stringify([meeting.id, input.path, input.source]));
    const primitive = indices.get(JSON.stringify(['retained-span', input.path, input.entry.primitive]));
    const prefix = ['meeting', meeting.id, 'input', input.path, input.source] as const;
    // The meeting is bound: entry run, side and point. A meeting-bound entry's
    // parameter follows its start along the run and is not compared.
    const meetingBound = open.has(JSON.stringify(['retained-span', input.path, input.entry.primitive]));
    if (!next || next.entry.primitive !== primitive || next.entry.side !== input.entry.side
      || !meetingBound && !Object.is(next.entry.parameter, input.entry.parameter)
      || !(['x', 'y'] as const).every(axis => Object.is(next.entry.point[axis], retained.pins.get(routingCoordinate(retained.preferred.id, ...prefix, 'point', axis)))))
      return { ok: false, conflict: equality(input.path, 'retained convergence entry') };
  }
  const intervals: FragmentTopologyBindings['intervals'][number][] = [...bound];
  // The arrow's retained shaft is native ink, not just an independently pinned
  // semantic object. Bind its endpoint aliases and keep the complete interval
  // behind the base, while leaving any longer straight core free to move.
  for (const source of retained.source.plan.paths) if (source.stub) {
    const path = planIndex.paths.get(source.id)!;
    charge(16 * (source.id.length + source.stub.length + retained.preferred.id.length + 48)
      * (path.native.length + 1), 'retained terminal native bindings');
    const scalar = (point: 'base' | 'shaft', axis: 'x' | 'y') => routingCoordinate(retained.preferred.id,
      'stub', source.stub!, point, ...(point === 'shaft' ? [0] : []), axis);
    const base = { x: retained.pins.get(scalar('base', 'x'))!, y: retained.pins.get(scalar('base', 'y'))! };
    const boundary = { x: retained.pins.get(scalar('shaft', 'x'))!, y: retained.pins.get(scalar('shaft', 'y'))! };
    const alias = (command: number, point: 'base' | 'shaft', axis: 'x' | 'y') => {
      const key = coordinateKey(source.id, command, axis);
      fixed.add(key); coordinates.set(key, scalar(point, axis));
    };
    for (const axis of ['x', 'y'] as const) alias(path.native.length, 'base', axis);
    const axis = base.x === boundary.x && base.y !== boundary.y ? 'y'
      : base.y === boundary.y && base.x !== boundary.x ? 'x' : null;
    // A diagonal terminal tangent has no orthogonal free track in the metric
    // model; its native coordinates already remain unchanged.
    if (!axis) continue;
    const other = axis === 'x' ? 'y' : 'x', forward = base[axis] > boundary[axis];
    let covered = false, visited = false, tailFixed = true;
    for (let i = path.native.length - 1; i >= 0; i--) {
      const run = path.native[i];
      if (covered && !(samePoint(run[0], boundary) && samePoint(run.at(-1)!, boundary))) break;
      if (run.length !== 2 || run.some(point => point[other] !== base[other])
        || (forward ? run[1][axis] < run[0][axis] : run[1][axis] > run[0][axis])) break;
      visited = true;
      tailFixed &&= [i, i + 1].every(command => (['x', 'y'] as const).every(axis => fixed.has(coordinateKey(source.id, command, axis))));
      for (const [command, point] of [[i, run[0]], [i + 1, run[1]]] as const) {
        alias(command, 'base', other);
        if (samePoint(point, boundary)) alias(command, 'shaft', axis);
      }
      if (forward ? run[0][axis] <= boundary[axis] : run[0][axis] >= boundary[axis]) {
        if (!covered) intervals.push({ route: source.id, command: i, axis, forward: !forward, boundary: boundary[axis] });
        covered = true;
      }
    }
    // The unchanged native importer also admits a small shortfall at a corner.
    // In that case preserve all actual native tail ink exactly; do not invent an
    // extra interval or introduce a second tolerance in the metric adapter.
    if (!covered && !(visited && tailFixed)) return { ok: false, conflict: equality(source.id, 'retained terminal interval') };
  }
  for (const interval of retained.intervals) {
    const path = planIndex.paths.get(interval.route)!;
    const index = interval.primitive === 0 ? 0
      : (indices.get(JSON.stringify(['retained-span', interval.route, interval.primitive - 1])) ?? -2) + 1;
    const native = path.native[index], other = interval.axis === 'x' ? 'y' : 'x';
    if (!native || native.length !== 2 || !samePoint(native[0], interval.start) || native[0][other] !== native[1][other]
      || final && (interval.forward ? path.native[index][1][interval.axis] < interval.boundary[interval.axis]
      : path.native[index][1][interval.axis] > interval.boundary[interval.axis]))
      return { ok: false, conflict: equality(interval.route, 'retained source interval') };
    for (const axis of ['x', 'y'] as const) {
      const key = coordinateKey(interval.route, index, axis); fixed.add(key);
      coordinates.set(key, routingCoordinate(retained.preferred.id, 'path', interval.route, 'native', interval.primitive, 0, axis));
    }
    intervals.push({ route: interval.route, command: index + 1, axis: interval.axis, forward: interval.forward, boundary: interval.boundary[interval.axis] });
  }
  return { ok: true, bindings: { coordinates, fixed, intervals } };
}
