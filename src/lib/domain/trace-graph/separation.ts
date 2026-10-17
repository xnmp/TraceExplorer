/**
 * Exact placement for a fixed acyclic segment order. This is bound propagation on
 * a difference-constraint DAG, followed by lexicographic closest-preference
 * placement in the declared order. It is not a VPSC least-squares projection.
 * Backward upper bounds are essential: an interior pin can move earlier free
 * variables. Feasible preferred drawings are returned bit-for-bit unchanged.
 */
export interface CoordinateBounds { readonly lower?: number; readonly upper?: number }
export interface CoordinatePin { readonly value: number; readonly reason: string }
export interface CoordinateVariable {
  readonly id: string;
  readonly preferred: number;
  readonly bounds?: CoordinateBounds;
  readonly pin?: CoordinatePin;
}
export interface SegmentOrder { readonly before: string; readonly after: string }
export interface Separation extends SegmentOrder { readonly id: string; readonly gap: number }
export interface RoutingSegment extends CoordinateVariable {
  /** Swept longitudinal interval; touching endpoints may reuse a track. */
  readonly span: readonly [number, number];
  /** Identical semantic trunks may share ink. Omit for incompatible segments. */
  readonly net?: string;
}
export interface SeparationProblem {
  readonly variables: readonly CoordinateVariable[];
  /** A total, topological order, independent of variable/constraint storage. */
  readonly order: readonly string[];
  readonly separations: readonly Separation[];
}
export interface SeparationConflict {
  readonly kind: 'invalid' | 'bounds';
  readonly variable: string;
  /** Ordered lower bound/pin → separating path → upper bound/pin witness. */
  readonly constraints: readonly string[];
}
export type SeparationResult = { readonly ok: true; readonly positions: ReadonlyMap<string, number> }
  | { readonly ok: false; readonly conflict: SeparationConflict };

export function solveSeparation(problem: SeparationProblem): SeparationResult {
  const fail = (kind: SeparationConflict['kind'], variable: string, constraints: readonly string[]): SeparationResult =>
    ({ ok: false, conflict: { kind, variable, constraints } });
  const byId = new Map(problem.variables.map(v => [v.id, v]));
  const rank = new Map(problem.order.map((id, i) => [id, i]));
  if (byId.size !== problem.variables.length || rank.size !== problem.order.length || rank.size !== byId.size
    || problem.order.some(id => !byId.has(id))) return fail('invalid', '', ['order']);
  const variables = problem.order.map(id => byId.get(id)!);
  const lower: number[] = [], upper: number[] = [], lowerReason: string[][] = [], upperReason: string[][] = [];
  for (const [i, v] of variables.entries()) {
    const lo = v.bounds?.lower ?? -Infinity, hi = v.bounds?.upper ?? Infinity;
    if (!Number.isFinite(v.preferred) || (lo !== -Infinity && !Number.isFinite(lo)) || (hi !== Infinity && !Number.isFinite(hi))
      || v.pin && !Number.isFinite(v.pin.value)) return fail('invalid', v.id, [v.id]);
    lower[i] = lo; upper[i] = hi;
    lowerReason[i] = [v.id + ':lower']; upperReason[i] = [v.id + ':upper'];
    if (v.pin) {
      if (v.pin.value < lo) return fail('bounds', v.id, [v.id + ':lower', v.id + ':pin']);
      if (v.pin.value > hi) return fail('bounds', v.id, [v.id + ':pin', v.id + ':upper']);
      lower[i] = upper[i] = v.pin.value;
      lowerReason[i] = upperReason[i] = [v.id + ':pin'];
    }
  }
  const outgoing: { readonly to: number; readonly edge: Separation }[][] = variables.map(() => []);
  const edgeIds = new Set<string>();
  for (const edge of problem.separations) {
    const from = rank.get(edge.before), to = rank.get(edge.after);
    if (from === undefined || to === undefined || from >= to || !Number.isFinite(edge.gap) || edge.gap < 0 || edgeIds.has(edge.id))
      return fail('invalid', edge.after, [edge.id]);
    edgeIds.add(edge.id); outgoing[from].push({ to, edge });
  }
  outgoing.forEach(edges => edges.sort((a, b) => a.to - b.to || a.edge.id.localeCompare(b.edge.id)));
  for (let i = 0; i < variables.length; i++) for (const { to, edge } of outgoing[i]) {
    const bound = lower[i] + edge.gap;
    if (bound > lower[to]) { lower[to] = bound; lowerReason[to] = [...lowerReason[i], edge.id]; }
  }
  for (let i = variables.length - 1; i >= 0; i--) {
    for (const { to, edge } of outgoing[i]) {
      const bound = upper[to] - edge.gap;
      if (bound < upper[i]) { upper[i] = bound; upperReason[i] = [edge.id, ...upperReason[to]]; }
    }
    if (lower[i] > upper[i]) return fail('bounds', variables[i].id, [...lowerReason[i], ...upperReason[i]]);
  }
  const positions = new Map<string, number>();
  for (const [i, v] of variables.entries()) {
    const value = v.pin?.value ?? Math.max(lower[i], Math.min(upper[i], v.preferred));
    if (!Number.isFinite(value)) return fail('invalid', v.id, ['overflow']);
    positions.set(v.id, value);
    for (const { to, edge } of outgoing[i]) lower[to] = Math.max(lower[to], value + edge.gap);
  }
  // No tolerance or post-solve rounding may weaken a hard separation or equality.
  for (const edge of problem.separations) if (positions.get(edge.after)! < positions.get(edge.before)! + edge.gap)
    return fail('bounds', edge.after, [edge.id]);
  for (const v of variables) if (positions.get(v.id)! < (v.bounds?.lower ?? -Infinity)
    || positions.get(v.id)! > (v.bounds?.upper ?? Infinity) || v.pin && positions.get(v.id) !== v.pin.value)
    return fail('bounds', v.id, [v.id + ':pin']);
  return { ok: true, positions };
}

/** Conflict edges only for overlapping incompatible swept intervals, not all neighbors. */
export function solveChannel(problem: { readonly segments: readonly RoutingSegment[]; readonly order: readonly string[]; readonly gap: number }): SeparationResult {
  const segments = new Map(problem.segments.map(s => [s.id, s]));
  const separations: Separation[] = [];
  for (const segment of problem.segments) if (!segment.span.every(Number.isFinite) || segment.span[0] > segment.span[1])
    return { ok: false, conflict: { kind: 'invalid', variable: segment.id, constraints: ['span'] } };
  for (let i = 0; i < problem.order.length; i++) for (let j = i + 1; j < problem.order.length; j++) {
    const a = segments.get(problem.order[i]), b = segments.get(problem.order[j]);
    if (!a || !b || a.net !== undefined && a.net === b.net) continue;
    if (a.span[0] < b.span[1] && b.span[0] < a.span[1]) separations.push({ id: `${a.id}→${b.id}`, before: a.id, after: b.id, gap: problem.gap });
  }
  return solveSeparation({ variables: problem.segments, order: problem.order, separations });
}
