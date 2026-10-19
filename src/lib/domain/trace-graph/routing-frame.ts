/** Ordered frame arithmetic for retained native scenes. Recipes retain the
 * actual binary64 operations; regrouping two translations is not an identity. */
import type { GraphLayout } from './layout';
import { mapPathNumbers } from './path-data';
import { chargeRoutingSnapshot, importCommittedRouting, retainedRoutingConflict, routingCoordinate, type CommittedRoutingProblem, type RoutingFrameEquality, type RoutingProblemResult } from './routing-problem';
import type { RoutingMetricConflict } from './routing-components';
import type { Point } from './path-sampling';

export interface FrameOperation { readonly operation: 'add' | 'subtract'; readonly operand: number }
export interface RoutingTranslation {
  readonly nodes: { readonly x: readonly FrameOperation[]; readonly y: readonly FrameOperation[] };
  readonly paths: { readonly x: readonly FrameOperation[]; readonly y: readonly FrameOperation[] };
}
const apply = (value: number, operations: readonly FrameOperation[]): number => operations.reduce((v, op) =>
  op.operation === 'add' ? v + op.operand : v - op.operand, value);
const validTranslation = (value: RoutingTranslation): boolean => !!value && (['nodes', 'paths'] as const).every(kind =>
  !!value[kind] && (['x', 'y'] as const).every(axis => Array.isArray(value[kind][axis])
    && Array.from(value[kind][axis]).every(op => op && ['add', 'subtract'].includes(op.operation) && Number.isFinite(op.operand))));
function chargeTranslation(drawing: GraphLayout, transform: RoutingTranslation, charge: (work: number, reason?: string) => void): void {
  charge(drawing.routes.length + 1, 'routing translation path scan');
  const bytes = drawing.routes.reduce((sum, route) => sum + route.path.length, 0);
  // Every recipe is applied per coordinate, then repeated when its exact frame
  // steps are authored. Path bytes conservatively bound native scalar count.
  charge(4 * (drawing.nodes.size + drawing.junctions.size + drawing.rows.length + 1)
    * (transform.nodes.x.length + transform.nodes.y.length + 1)
    + 4 * bytes * (transform.paths.x.length + transform.paths.y.length + 1), 'ordered routing translation work');
}

/** The world adapter's node and path operations can differ: nodes use
 * (x + origin) + margin while native paths use x + (origin + margin). */
export function translatedRoutingDrawing(drawing: GraphLayout, transform: RoutingTranslation): GraphLayout {
  const point = <T extends { readonly x: number; readonly y: number }>(p: T): T => ({ ...p,
    x: apply(p.x, transform.nodes.x), y: apply(p.y, transform.nodes.y) });
  return { ...drawing, nodes: new Map([...drawing.nodes].map(([key, n]) => [key, point(n)])),
    junctions: new Map([...drawing.junctions].map(([key, j]) => [key, point(j)])),
    routes: drawing.routes.map(r => ({ ...r, path: mapPathNumbers(r.path, (v, i) => apply(v, i % 2 ? transform.paths.y : transform.paths.x)) })),
    rows: drawing.rows.map(r => ({ ...r, top: apply(r.top, transform.nodes.y), bottom: apply(r.bottom, transform.nodes.y) })) };
}

/** Capture both ends of the actual production recipe and every intermediate
 * native coordinate as equalities. No inferred historical transform or chart
 * offset is used. A mismatch declines this frame, preserving both inputs. */
export function captureTranslatedRouting(drawing: GraphLayout, transform: RoutingTranslation,
  charge: (work: number, reason?: string) => void = () => {}): RoutingProblemResult {
  chargeRoutingSnapshot(transform, charge);
  if (!validTranslation(transform)) return { ok: false, conflict: { kind: 'invalid', variable: '', constraints: ['routing translation shape'] } };
  const captured = importCommittedRouting([{ id: 'local', space: 'attached', drawing }], [], charge);
  if (!captured.ok) return captured;
  drawing = captured.problem.scenes[0].drawing;
  transform = structuredClone(transform);
  chargeTranslation(drawing, transform, charge);
  charge(8 * (drawing.nodes.size + drawing.junctions.size + drawing.rows.length + drawing.routes.length + 1)
    + drawing.routes.reduce((sum, route) => sum + 4 * route.path.length, 0), 'routing frame construction');
  const translated = translatedRoutingDrawing(drawing, transform);
  const frames: RoutingFrameEquality[] = [];
  const equation = (address: readonly (string | number)[], value: number, operations: readonly FrameOperation[]) => {
    let current = value;
    const steps = operations.map(op => {
      current = apply(current, [op]); return { ...op, result: current };
    });
    const id = JSON.stringify(address);
    frames.push({ id, input: routingCoordinate('local', ...address), output: routingCoordinate('world', ...address), steps });
  };
  for (const [key, n] of drawing.nodes) for (const axis of ['x', 'y'] as const) equation(['tile', key, axis], n[axis], transform.nodes[axis]);
  for (const [key, j] of drawing.junctions) for (const axis of ['x', 'y'] as const) equation(['dot', key, axis], j[axis], transform.nodes[axis]);
  const imported = captured.problem.scenes[0].plan;
  for (const path of imported.paths) for (const [i, native] of path.native.entries()) for (const [j, p] of native.entries())
    for (const axis of ['x', 'y'] as const) equation(['path', path.id, 'native', i, j, axis], p[axis], transform.paths[axis]);
  return importCommittedRouting([{ id: 'local', space: 'attached', drawing }, { id: 'world', space: 'folder', drawing: translated }], frames, charge);
}

/** Move native bindings between graph origins while retaining their actual
 * displayed world values. The router's extra translation is checked first;
 * it cannot authorize edits to a committed primitive. */
export function rebaseRetainedRoutingFrame(problem: CommittedRoutingProblem, routedWorld: GraphLayout,
  local: GraphLayout, origins: { readonly source: Point; readonly target: Point; readonly targetTransform?: RoutingTranslation },
  charge: (work: number, reason?: string) => void = () => {}): { readonly ok: true; readonly drawing: GraphLayout }
    | { readonly ok: false; readonly conflict: RoutingMetricConflict } {
  const invalid = (variable: string, detail: string): { readonly ok: false; readonly conflict: RoutingMetricConflict } =>
    ({ ok: false, conflict: { kind: 'equality', variable, constraints: [detail] } });
  charge(4 + 2 * problem.scenes.length, 'retained frame origins');
  if (![origins.source.x, origins.source.y, origins.target.x, origins.target.y].every(Number.isFinite))
    return invalid('', 'nonfinite retained frame origin');
  const original = problem.scenes.find(s => s.id === 'local'), placed = problem.scenes.find(s => s.id === 'world');
  if (!original || !placed) return invalid('', 'local/world frame');
  const conflict = retainedRoutingConflict(problem, [original, { ...placed, drawing: routedWorld }], charge);
  if (conflict) return { ok: false, conflict };
  const same = origins.source.x === origins.target.x && origins.source.y === origins.target.y;
  if (!same && !origins.targetTransform) return invalid('', 'changed origin requires target display recipe');
  if (origins.targetTransform) {
    chargeRoutingSnapshot(origins.targetTransform, charge);
    if (!validTranslation(origins.targetTransform)) return invalid('', 'target display recipe shape');
  }
  const coordinate = (value: number, axis: 'x' | 'y') => same ? value : (value + origins.source[axis]) - origins.target[axis];
  const point = <T extends Point>(value: T): T => ({ ...value, x: coordinate(value.x, 'x'), y: coordinate(value.y, 'y') });
  const restored = <T extends Point>(entries: ReadonlyMap<string, T>, retained: ReadonlyMap<string, T>): ReadonlyMap<string, T> | null => {
    charge(entries.size + retained.size + 1, 'retained frame points');
    const result = new Map(entries);
    for (const [key, old] of retained) {
      if (!result.has(key)) return null;
      const next = point(old);
      for (const axis of ['x', 'y'] as const) if (!Object.is(next[axis] + origins.target[axis], old[axis] + origins.source[axis])) return null;
      result.set(key, next);
    }
    return result;
  };
  const nodes = restored(local.nodes, original.drawing.nodes), junctions = restored(local.junctions, original.drawing.junctions);
  if (!nodes || !junctions) return invalid('', 'unrepresentable retained frame point');
  const paths = new Map<string, string>();
  for (const route of original.drawing.routes) {
    charge(4 * route.path.length + 1, 'retained native frame');
    const path = same ? route.path : mapPathNumbers(route.path, (value, i) => coordinate(value, i % 2 ? 'y' : 'x'));
    const expected = mapPathNumbers(route.path, (value, i) => value + origins.source[i % 2 ? 'y' : 'x']);
    const actual = mapPathNumbers(path, (value, i) => value + origins.target[i % 2 ? 'y' : 'x']);
    if (actual !== expected) return invalid(route.id, 'unrepresentable retained native frame');
    paths.set(route.id, path);
  }
  charge(local.routes.length + paths.size + 1, 'retained frame route identities');
  const ids = new Set(local.routes.map(route => route.id));
  for (const id of paths.keys()) if (!ids.has(id)) return invalid('', 'missing retained frame route');
  const drawing = { ...local, nodes, junctions,
    routes: local.routes.map(route => paths.has(route.id) ? { ...route, path: paths.get(route.id)! } : route) };
  if (origins.targetTransform) {
    chargeRoutingSnapshot(drawing, charge);
    chargeTranslation(drawing, origins.targetTransform, charge);
    const displayed = translatedRoutingDrawing(drawing, origins.targetTransform);
    const targetConflict = retainedRoutingConflict(problem, [original, { ...placed, drawing: displayed }], charge);
    if (targetConflict) return { ok: false, conflict: targetConflict };
  }
  return { ok: true, drawing };
}

/** Restore authored retained coordinates from the captured local scene, rather
 * than numerically inverting a lossy binary64 translation. New geometry comes
 * from the caller's reverse recipe. A changed world pin cannot authorize reuse. */
export function restoreRetainedRoutingFrame(problem: CommittedRoutingProblem, world: GraphLayout,
  local: GraphLayout, charge: (work: number, reason?: string) => void = () => {}): { readonly ok: true; readonly drawing: GraphLayout }
    | { readonly ok: false; readonly conflict: RoutingMetricConflict } {
  const original = problem.scenes.find(s => s.id === 'local'), placed = problem.scenes.find(s => s.id === 'world');
  if (!original || !placed) return { ok: false, conflict: { kind: 'invalid', variable: '', constraints: ['local/world frame'] } };
  const conflict = retainedRoutingConflict(problem, [{ ...original }, { ...placed, drawing: world }], charge);
  if (conflict) return { ok: false, conflict };
  const paths = new Map(original.drawing.routes.map(r => [r.id, r.path]));
  const drawing = { ...local,
    nodes: new Map([...local.nodes].map(([key, n]) => [key, original.drawing.nodes.get(key) ?? n])),
    junctions: new Map([...local.junctions].map(([key, j]) => [key, original.drawing.junctions.get(key) ?? j])),
    routes: local.routes.map(r => paths.has(r.id) ? { ...r, path: paths.get(r.id)! } : r),
  };
  const localConflict = retainedRoutingConflict(problem, [{ ...original, drawing }, { ...placed, drawing: world }], charge);
  return localConflict ? { ok: false, conflict: localConflict } : { ok: true, drawing };
}
