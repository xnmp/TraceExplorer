/**
 * Feasibility for a fixed acyclic segment order. Bound propagation on a
 * difference-constraint DAG, followed by deterministic preferred-coordinate
 * clamping. No projection optimality is claimed for free coordinates.
 * Difference-constraint reference: https://courses.csail.mit.edu/6.006/spring11/lectures/lec17.pdf
 * Backward upper bounds are essential: an interior pin can move earlier free
 * variables. Jointly feasible preferred drawings return bit-for-bit unchanged.
 * Reverse floating subtraction may conservatively bound a free coordinate;
 * pins always retain their original values and forward residuals admit output.
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

/** The adjacent smaller representable number, used only when subtraction rounded
 * an upper bound in the unsafe direction. This never reduces a separation. */
function nextDown(value: number): number {
  if (value === -Infinity) return value;
  if (value === 0) return -Number.MIN_VALUE;
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  bytes.setBigUint64(0, bytes.getBigUint64(0) + (value > 0 ? -1n : 1n));
  return bytes.getFloat64(0);
}

export function solveSeparation(problem: SeparationProblem): SeparationResult {
  const fail = (kind: SeparationConflict['kind'], variable: string, constraints: readonly string[]): SeparationResult =>
    ({ ok: false, conflict: { kind, variable, constraints } });
  const byId = new Map(problem.variables.map(v => [v.id, v]));
  const rank = new Map(problem.order.map((id, i) => [id, i]));
  if (byId.size !== problem.variables.length || rank.size !== problem.order.length || rank.size !== byId.size
    || problem.order.some(id => !byId.has(id))) return fail('invalid', '', ['order']);
  const variables = problem.order.map(id => byId.get(id)!);
  const lower: number[] = [], upper: number[] = [], originalUpper: number[] = [], lowerReason: string[] = [], upperReason: string[] = [];
  const lowerVia: (Separation | undefined)[] = [], upperVia: (Separation | undefined)[] = [];
  for (const [i, v] of variables.entries()) {
    const lo = v.bounds?.lower ?? -Infinity, hi = v.bounds?.upper ?? Infinity;
    if (!Number.isFinite(v.preferred) || (lo !== -Infinity && !Number.isFinite(lo)) || (hi !== Infinity && !Number.isFinite(hi))
      || v.pin && !Number.isFinite(v.pin.value)) return fail('invalid', v.id, [v.id]);
    lower[i] = lo; upper[i] = hi; originalUpper[i] = v.pin?.value ?? hi;
    lowerReason[i] = v.id + ':lower'; upperReason[i] = v.id + ':upper';
    if (v.pin) {
      if (v.pin.value < lo) return fail('bounds', v.id, [v.id + ':lower', v.id + ':pin']);
      if (v.pin.value > hi) return fail('bounds', v.id, [v.id + ':pin', v.id + ':upper']);
      lower[i] = upper[i] = v.pin.value;
      lowerReason[i] = upperReason[i] = v.id + ':pin';
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
  const preferred = new Map(variables.map(v => [v.id, v.pin?.value ?? v.preferred]));
  if (variables.every((v, i) => preferred.get(v.id)! >= lower[i] && preferred.get(v.id)! <= upper[i])
    && problem.separations.every(e => preferred.get(e.after)! >= preferred.get(e.before)! + e.gap)) return { ok: true, positions: preferred };
  for (let i = 0; i < variables.length; i++) for (const { to, edge } of outgoing[i]) {
    const bound = lower[i] + edge.gap;
    if (bound > lower[to]) { lower[to] = bound; lowerVia[to] = edge; }
  }
  const witness = (index: number) => {
    const before: string[] = [], after: string[] = [];
    let at = index;
    while (lowerVia[at]) { const edge = lowerVia[at]!; before.push(edge.id); at = rank.get(edge.before)!; }
    before.push(lowerReason[at]); before.reverse();
    at = index;
    while (upperVia[at]) { const edge = upperVia[at]!; after.push(edge.id); at = rank.get(edge.after)!; }
    return [...before, ...after, upperReason[at]];
  };
  for (let i = variables.length - 1; i >= 0; i--) {
    for (const { to, edge } of outgoing[i]) {
      if (upper[i] + edge.gap <= upper[to]) continue;
      let bound = upper[to] - edge.gap;
      while (bound + edge.gap > upper[to]) bound = nextDown(bound);
      if (bound < upper[i]) { upper[i] = bound; upperVia[i] = edge; }
    }
    // Carry a feasible preferred successor ceiling backward as well: an
    // unrelated conflict must not perturb a feasible decimal chain.
    const desired = variables[i].pin?.value ?? variables[i].preferred;
    if (desired > upper[i] && desired <= originalUpper[i]
      && outgoing[i].every(({ to, edge }) => desired + edge.gap <= upper[to])) upper[i] = desired;
    // Reverse subtraction can round below an exact decimal pin. Test the
    // forward residual before declaring a conflict; no epsilon changes the gap.
    if (lower[i] > upper[i] && lower[i] <= originalUpper[i]
      && outgoing[i].every(({ to, edge }) => lower[i] + edge.gap <= upper[to])) upper[i] = lower[i];
    if (lower[i] > upper[i]) return fail('bounds', variables[i].id, witness(i));
  }
  const positions = new Map<string, number>();
  for (const [i, v] of variables.entries()) {
    const preferredFits = v.preferred >= lower[i] && v.preferred <= originalUpper[i]
      && outgoing[i].every(({ to, edge }) => v.preferred + edge.gap <= upper[to]);
    const value = v.pin?.value ?? (preferredFits ? v.preferred : Math.max(lower[i], Math.min(upper[i], v.preferred)));
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
  if (!Number.isFinite(problem.gap) || problem.gap < 0) return { ok: false, conflict: { kind: 'invalid', variable: '', constraints: ['gap'] } };
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
