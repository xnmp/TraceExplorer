/** Fixed topology metric re-solve. Substitute exact constants before finding
 * free dependency components: a shared fixed port must not join unrelated work.
 * Fixed ink still supplies every incident bound in each component solve. */
import { solveSeparation, type CoordinateVariable, type Separation, type SeparationProblem } from './separation';

export interface CoordinateEquality {
  readonly id: string;
  readonly variable: string;
  readonly value: number;
}
export interface RoutingMetricProblem extends SeparationProblem {
  readonly equalities?: readonly CoordinateEquality[];
  /** Coupled free tracks, e.g. the native controls of one turn or shared net. */
  readonly dependencies?: readonly (readonly string[])[];
}
export interface RoutingMetricConflict {
  readonly kind: 'invalid' | 'equality' | 'metric';
  readonly variable: string;
  readonly constraints: readonly string[];
}
export type RoutingMetricResult = {
  readonly ok: true;
  readonly positions: ReadonlyMap<string, number>;
  /** Only components that needed solving, in the original topological order. */
  readonly solved: readonly (readonly string[])[];
} | { readonly ok: false; readonly conflict: RoutingMetricConflict };

export function solveRoutingComponents(problem: RoutingMetricProblem, affected: readonly string[] = [],
  charge: (work: number, reason?: string) => void = () => {}): RoutingMetricResult {
  const fail = (kind: RoutingMetricConflict['kind'], variable: string, constraints: readonly string[]): RoutingMetricResult =>
    ({ ok: false, conflict: { kind, variable, constraints } });
  charge(8 * (problem.variables.length + problem.order.length + (problem.equalities?.length ?? 0) + problem.separations.length + affected.length + 1), 'metric import');
  const variables = new Map(problem.variables.map(v => [v.id, v]));
  const rank = new Map(problem.order.map((id, index) => [id, index]));
  if (variables.size !== problem.variables.length || rank.size !== variables.size || rank.size !== problem.order.length
    || problem.order.some(id => !variables.has(id))) return fail('invalid', '', ['order']);
  const constants = new Map<string, { value: number; reason: string }>();
  const positions = new Map<string, number>();
  for (const id of problem.order) {
    const v = variables.get(id)!;
    const lower = v.bounds?.lower ?? -Infinity, upper = v.bounds?.upper ?? Infinity;
    if (!Number.isFinite(v.preferred) || lower !== -Infinity && !Number.isFinite(lower) || upper !== Infinity && !Number.isFinite(upper)
      || lower > upper || v.pin && !Number.isFinite(v.pin.value)) return fail('invalid', id, ['variable:' + id]);
    if (v.pin) constants.set(id, { value: v.pin.value, reason: id + ':pin' });
    positions.set(id, v.pin?.value ?? v.preferred);
  }
  const equalityIds = new Set<string>();
  for (const equality of problem.equalities ?? []) {
    if (!variables.has(equality.variable) || !Number.isFinite(equality.value) || equalityIds.has(equality.id))
      return fail('invalid', equality.variable, [equality.id]);
    equalityIds.add(equality.id);
    const prior = constants.get(equality.variable);
    if (prior && !Object.is(prior.value, equality.value)) return fail('equality', equality.variable, [prior.reason, equality.id]);
    constants.set(equality.variable, prior ?? { value: equality.value, reason: equality.id });
    positions.set(equality.variable, prior?.value ?? equality.value);
  }
  for (const [id, pin] of constants) {
    const bounds = variables.get(id)!.bounds;
    if (pin.value < (bounds?.lower ?? -Infinity) || pin.value > (bounds?.upper ?? Infinity))
      return fail('metric', id, [pin.reason, id + ':bounds']);
  }
  const edgeIds = new Set<string>();
  for (const edge of problem.separations) {
    if (!rank.has(edge.before) || !rank.has(edge.after) || rank.get(edge.before)! >= rank.get(edge.after)!
      || !Number.isFinite(edge.gap) || edge.gap < 0 || edgeIds.has(edge.id)) return fail('invalid', edge.after, [edge.id]);
    edgeIds.add(edge.id);
  }
  if (affected.some(id => !variables.has(id))) return fail('invalid', '', ['affected']);

  const adjacency = new Map(problem.order.filter(id => !constants.has(id)).map(id => [id, new Set<string>()]));
  const connect = (ids: readonly string[]) => {
    // Constants are eliminated BEFORE this closure. They remain bounds, not
    // dependency bridges joining the free tracks on either side of an anchor.
    const free = ids.filter(id => !constants.has(id));
    for (const id of free.slice(1)) { adjacency.get(free[0])!.add(id); adjacency.get(id)!.add(free[0]); }
  };
  for (const edge of problem.separations) connect([edge.before, edge.after]);
  for (const dependency of problem.dependencies ?? []) {
    charge(8 * (dependency.length + 1), 'metric dependencies');
    if (dependency.some(id => !variables.has(id))) return fail('invalid', '', ['dependency']);
    connect(dependency);
  }
  const dirty = new Set(affected.filter(id => !constants.has(id)));
  const violates = (edge: Separation) => positions.get(edge.after)! < positions.get(edge.before)! + edge.gap;
  for (const edge of problem.separations) if (violates(edge)) {
    if (constants.has(edge.before) && constants.has(edge.after))
      return fail('metric', edge.after, [constants.get(edge.before)!.reason, edge.id, constants.get(edge.after)!.reason]);
    if (!constants.has(edge.before)) dirty.add(edge.before);
    if (!constants.has(edge.after)) dirty.add(edge.after);
  }
  for (const [id, v] of variables) if (positions.get(id)! < (v.bounds?.lower ?? -Infinity) || positions.get(id)! > (v.bounds?.upper ?? Infinity)) dirty.add(id);

  const seen = new Set<string>(), solved: string[][] = [];
  for (const id of problem.order) {
    if (constants.has(id) || seen.has(id)) continue;
    const component = new Set<string>(), pending = [id];
    while (pending.length) {
      charge(1, 'free component traversal');
      const at = pending.pop()!;
      if (component.has(at)) continue;
      component.add(at); seen.add(at);
      charge(adjacency.get(at)!.size, 'free component adjacency');
      for (const next of adjacency.get(at)!) if (!component.has(next)) pending.push(next);
    }
    charge(component.size, 'affected component membership');
    if (![...component].some(key => dirty.has(key))) continue;
    // These are full-array scans even for a tiny local component. Charge them
    // before scanning; a caller's ledger bounds work, not just local solve size.
    charge(problem.separations.length + problem.order.length + 1, 'component constraint selection');
    const edges = problem.separations.filter(e => component.has(e.before) || component.has(e.after));
    const ids = new Set([...component, ...edges.flatMap(e => [e.before, e.after])]);
    const order = problem.order.filter(key => ids.has(key));
    const local: CoordinateVariable[] = order.map(key => {
      const v = variables.get(key)!, pin = constants.get(key);
      return pin ? { ...v, pin: { value: pin.value, reason: pin.reason } } : v;
    });
    charge(8 * (local.length + edges.length + 1), 'affected metric component');
    const result = solveSeparation({ variables: local, order, separations: edges });
    if (!result.ok) return fail(result.conflict.kind === 'invalid' ? 'invalid' : 'metric', result.conflict.variable, result.conflict.constraints);
    for (const key of component) positions.set(key, result.positions.get(key)!);
    solved.push(order.filter(key => component.has(key)));
  }
  // Validate all hard residuals, including constant-only and untouched regions.
  charge(problem.separations.length + variables.size, 'metric residuals');
  for (const edge of problem.separations) if (violates(edge)) return fail('metric', edge.after, [edge.id]);
  for (const [id, v] of variables) {
    const value = positions.get(id)!;
    if (!Number.isFinite(value) || value < (v.bounds?.lower ?? -Infinity) || value > (v.bounds?.upper ?? Infinity)
      || constants.has(id) && !Object.is(value, constants.get(id)!.value)) return fail('metric', id, [id + ':residual']);
  }
  return { ok: true, positions, solved };
}
