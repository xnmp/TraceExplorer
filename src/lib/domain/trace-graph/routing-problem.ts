/** Lossless committed geometry -> exact metric constants. Frame names are
 * declared by the caller; neither component ids nor numerical convergence charts
 * imply a coordinate transform. Publication remains the independent gates' job. */
import type { GraphLayout } from './layout';
import { isLayoutShape } from './history-boundary';
import { eachConsumer } from './route-consumers';
import { importRoutingPlan, type RoutingPlan } from './routing-plan';
import type { CoordinateVariable } from './separation';
import { type RoutingMetricConflict, type RoutingMetricProblem } from './routing-components';

export interface CommittedRoutingScene {
  /** Stable within the retained problem; use tile identity to map merged scenes. */
  readonly id: string;
  readonly space: 'band' | 'attached' | 'folder';
  readonly drawing: GraphLayout;
}
/** Each scalar gets its actual piecewise frame recipe. Do not combine offsets:
 * (x + a) + b need not equal x + (a + b). Every intermediate result is pinned. */
export interface RoutingFrameEquality {
  readonly id: string;
  readonly input: string;
  readonly output: string;
  readonly steps: readonly { readonly operation: 'add' | 'subtract'; readonly operand: number; readonly result: number }[];
}
export interface CommittedRoutingProblem {
  readonly scenes: readonly (CommittedRoutingScene & { readonly plan: RoutingPlan })[];
  readonly frames: readonly RoutingFrameEquality[];
  readonly metric: RoutingMetricProblem;
}
export type RoutingProblemResult = { readonly ok: true; readonly problem: CommittedRoutingProblem }
  | { readonly ok: false; readonly conflict: RoutingMetricConflict };

/** Identities never contain component ids or ordinal positions of tiles/routes. */
export const routingCoordinate = (scene: string, ...address: readonly (string | number)[]): string => JSON.stringify(['scene', scene, ...address]);

/** Charge snapshot/shape traversal before cloning, including shared consumer
 * tables and metadata the shape validator otherwise traverses without a ledger. */
export function chargeRoutingSnapshot(value: unknown, charge: (work: number, reason?: string) => void): void {
  const pending = [value], seen = new Set<object>();
  while (pending.length) {
    charge(1, 'committed snapshot traversal');
    const current = pending.pop();
    if (typeof current === 'string') charge(current.length, 'committed snapshot bytes');
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Map) {
      charge(2 * current.size, 'committed snapshot map');
      for (const [key, child] of current) pending.push(key, child);
    } else if (current instanceof Set) {
      charge(current.size, 'committed snapshot set');
      for (const child of current) pending.push(child);
    } else if (Array.isArray(current)) {
      charge(current.length, 'committed snapshot array');
      for (const child of current) pending.push(child);
    } else {
      const keys = Object.keys(current);
      charge(keys.length, 'committed snapshot fields');
      for (const key of keys) {
        charge(key.length, 'committed snapshot property names');
        pending.push((current as Record<string, unknown>)[key]);
      }
    }
  }
}

/** One element of a JSON array, exactly as `JSON.stringify` writes it inside one. */
const jsonElement = (value: string | number): string => value === undefined ? 'null' : JSON.stringify(value);

/** All numbers in a validated native binding are constants, including cut
 * parameters, suffix controls, turn bounds and reversible chart intermediates.
 * `prefix` is the coordinate's identity without its closing bracket, extended one
 * element per level, so each id equals `routingCoordinate(scene, ...address)`. */
function numericPins(value: unknown, prefix: string, variables: CoordinateVariable[],
  charge: (work: number, reason?: string) => void): void {
  charge(1, 'committed pin import');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Nonfinite committed pin');
    const id = prefix + ']';
    variables.push({ id, preferred: value, pin: { value, reason: 'committed:' + id } });
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) numericPins(value[i], prefix + ',' + i, variables, charge);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) numericPins((value as Record<string, unknown>)[key], prefix + ',' + JSON.stringify(key), variables, charge);
  }
}

export function committedRoutingCoordinates(scene: CommittedRoutingScene, plan: RoutingPlan,
  charge: (work: number, reason?: string) => void): CoordinateVariable[] {
  const variables: CoordinateVariable[] = [];
  const root = '["scene",' + JSON.stringify(scene.id);
  const pin = (value: unknown, ...address: readonly (string | number)[]) =>
    numericPins(value, root + address.map(part => ',' + jsonElement(part)).join(''), variables, charge);
  const drawing = scene.drawing;
  for (const [key, n] of drawing.nodes) pin({ x: n.x, y: n.y, width: n.width, height: n.height }, 'tile', key);
  for (const [key, j] of drawing.junctions) pin({ x: j.x, y: j.y }, 'dot', key);
  pin({ width: drawing.width, height: drawing.height, bounds: drawing.bandBounds }, 'allocation');
  for (const row of drawing.rows) pin({ top: row.top, bottom: row.bottom }, 'row', row.band, row.index);
  for (const port of plan.ports) pin(port, 'port', port.id);
  for (const stub of plan.stubs) pin(stub, 'stub', stub.id);
  for (const corridor of plan.corridors) pin(corridor, 'corridor', corridor.id);
  for (const turn of plan.turns) pin(turn, 'turn', turn.id);
  // Native primitive order is part of the retained route's identity. Original
  // bytes live beside these scalar equalities, never reconstructed from them.
  for (const path of plan.paths) pin({ points: path.points, native: path.native }, 'path', path.id);
  for (const meeting of plan.meetings ?? []) {
    pin({ dot: meeting.dot, convergence: meeting.convergence }, 'meeting', meeting.id);
    for (const input of meeting.inputs) pin(input.entry, 'meeting', meeting.id, 'input', input.path, input.source);
    if (meeting.chart) {
      pin({ offsets: meeting.chart.offsets, dot: meeting.chart.dot }, 'meeting', meeting.id, 'chart');
      for (const input of meeting.chart.inputs) pin({ native: input.native, entry: input.entry }, 'meeting', meeting.id, 'chart', 'input', input.path);
    }
  }
  return variables;
}

/** Bind ordered frame operations to explicitly selected constants. Callers may
 * select retained fragments before this boundary; unselected path coordinates
 * do not become constants merely because their native geometry was imported. */
export function bindRoutingFrameConstants(constants: readonly CoordinateVariable[], frames: readonly RoutingFrameEquality[],
  charge: (work: number, reason?: string) => void = () => {}):
  { readonly ok: true; readonly metric: RoutingMetricProblem } | { readonly ok: false; readonly conflict: RoutingMetricConflict } {
  const invalid = (variable: string, constraints: readonly string[]) =>
    ({ ok: false as const, conflict: { kind: 'invalid' as const, variable, constraints } });
  charge(constants.length + frames.length + 1, 'retained frame constants');
  const variables = [...constants], values = new Map(variables.map(v => [v.id, v.pin?.value]));
  if (values.size !== variables.length) return invalid('', ['duplicate committed coordinate']);
  const frameIds = new Set<string>();
  for (const frame of frames) {
    if (!frame || typeof frame.id !== 'string' || frameIds.has(frame.id)
      || !Number.isFinite(values.get(frame.input)) || !Number.isFinite(values.get(frame.output))
      || !Array.isArray(frame.steps)) return invalid('', ['frame']);
    frameIds.add(frame.id);
    let value = values.get(frame.input)!;
    for (const [index, step] of frame.steps.entries()) {
      charge(8, 'ordered frame equality');
      if (!step || !['add', 'subtract'].includes(step.operation) || !Number.isFinite(step.operand) || !Number.isFinite(step.result))
        return invalid(frame.output, [frame.id]);
      value = step.operation === 'add' ? value + step.operand : value - step.operand;
      if (!Object.is(value, step.result)) return { ok: false, conflict: { kind: 'equality', variable: frame.output, constraints: [frame.id, 'step:' + index] } };
      for (const [field, coordinate] of [['operand', step.operand], ['result', step.result]] as const) {
        const id = JSON.stringify(['frame', frame.id, index, field]);
        if (values.has(id)) return invalid(id, ['duplicate frame coordinate']);
        values.set(id, coordinate);
        variables.push({ id, preferred: coordinate, pin: { value: coordinate, reason: frame.id } });
      }
    }
    if (!Object.is(value, values.get(frame.output)))
      return { ok: false, conflict: { kind: 'equality', variable: frame.output, constraints: [frame.id, frame.output + ':pin'] } };
  }
  return { ok: true, metric: { variables, order: variables.map(v => v.id), separations: [] } };
}

export function importCommittedRouting(scenes: readonly CommittedRoutingScene[], frames: readonly RoutingFrameEquality[] = [],
  charge: (work: number, reason?: string) => void = () => {}): RoutingProblemResult {
  const invalid = (variable: string, constraints: readonly string[]): RoutingProblemResult => ({ ok: false, conflict: { kind: 'invalid', variable, constraints } });
  let chargeFailed = false;
  const checkedCharge = (work: number, reason?: string) => {
    try { charge(work, reason); } catch (error) { chargeFailed = true; throw error; }
  };
  try {
    if (!Array.isArray(scenes) || !Array.isArray(frames)) return invalid('', ['scenes/frames']);
    checkedCharge(scenes.length + 1, 'committed scenes');
    chargeRoutingSnapshot(frames, checkedCharge);
    for (const scene of scenes) {
      // Shape validation visits shared tables once PER scene. Charging with a
      // fresh seen set mirrors that scope even when two scenes alias a table.
      chargeRoutingSnapshot(scene, checkedCharge);
      if (!scene || !isLayoutShape(scene.drawing)) return invalid('', ['drawing']);
    }
    // No mutable caller-owned geometry can change a captured equality later.
    const snapshots = structuredClone(scenes);
    const ids = new Set<string>(), variables: CoordinateVariable[] = [];
    const imported: (CommittedRoutingScene & { readonly plan: RoutingPlan })[] = [];
    for (const scene of snapshots) {
      if (!scene || typeof scene.id !== 'string' || ids.has(scene.id) || !['band', 'attached', 'folder'].includes(scene.space)) return invalid('', ['scene']);
      ids.add(scene.id);
      const plan = importRoutingPlan(scene.drawing, checkedCharge);
      variables.push(...committedRoutingCoordinates(scene, plan, checkedCharge)); imported.push({ ...scene, plan });
    }
    // Binding is the whole consistency check: every variable it returns is a
    // finite, unbounded, uniquely named pin and there are no separations or
    // equalities, so a metric solve here could only reproduce the pins.
    const bound = bindRoutingFrameConstants(variables, frames, checkedCharge);
    if (!bound.ok) return bound;
    return { ok: true, problem: { scenes: imported, frames: structuredClone(frames), metric: bound.metric } };
  } catch (error) {
    // A caller's work-ledger exception must retain its original control flow.
    if (chargeFailed) throw error;
    if (!(error instanceof RangeError) && !(error instanceof Error && ['RoutingImportError', 'DataCloneError'].includes(error.name))) throw error;
    return invalid('', [String(error)]);
  }
}

/** Verify declared retained pins against an extension. New routes and tiles may
 * be added. An old track, port, suffix byte or semantic connection may not vanish.
 * Projection/departure policy runs BEFORE import; it cannot unpin a failed solve. */
export function retainedRoutingConflict(problem: CommittedRoutingProblem, candidates: readonly CommittedRoutingScene[],
  charge: (work: number, reason?: string) => void = () => {}): RoutingMetricConflict | null {
  const next = importCommittedRouting(candidates, problem.frames, charge);
  if (!next.ok) return next.conflict;
  const scenes = new Map(next.problem.scenes.map(s => [s.id, s]));
  const pins = new Map(next.problem.metric.variables.map(v => [v.id, v.pin!.value]));
  for (const before of problem.scenes) {
    const after = scenes.get(before.id);
    if (!after || before.space !== after.space) return { kind: 'equality', variable: before.id, constraints: ['declared frame'] };
    const routes = new Map(after.drawing.routes.map(r => [r.id, r]));
    for (const r of before.drawing.routes) {
      const candidate = routes.get(r.id);
      if (!candidate || candidate.path !== r.path || candidate.terminal !== r.terminal
        || candidate.from.kind !== r.from.kind || candidate.from.id !== r.from.id || candidate.to.kind !== r.to.kind || candidate.to.id !== r.to.id)
        return { kind: 'equality', variable: r.id, constraints: ['retained native route'] };
      const consumers = new Set([...eachConsumer(candidate)].map(c => JSON.stringify([c.parent, c.child])));
      for (const c of eachConsumer(r)) if (!consumers.has(JSON.stringify([c.parent, c.child])))
        return { kind: 'equality', variable: r.id, constraints: ['retained consumer'] };
    }
    for (const [id, dot] of before.drawing.junctions) if (JSON.stringify(dot.parents) !== JSON.stringify(after.drawing.junctions.get(id)?.parents))
      return { kind: 'equality', variable: id, constraints: ['retained painted dot'] };
  }
  // Allocation may grow on extension, but retained physical coordinates cannot.
  // Meeting projection and allocation certificates can change with new consumers;
  // the original native coordinates/bytes above remain independently fixed.
  // A committed coordinate's id is JSON ['scene', scene, kind, ...]; frame
  // coordinates start with 'frame'. Match the kind by its exact JSON prefix.
  const prefixes = problem.scenes.flatMap(scene => ['tile', 'dot', 'path', 'port']
    .map(kind => '["scene",' + JSON.stringify(scene.id) + ',' + JSON.stringify(kind) + ','));
  const physical = (id: string) => prefixes.some(prefix => id.startsWith(prefix));
  for (const variable of problem.metric.variables) if (physical(variable.id) && !Object.is(pins.get(variable.id), variable.pin!.value))
    return { kind: 'equality', variable: variable.id, constraints: ['committed pin', 'candidate coordinate'] };
  return null;
}
