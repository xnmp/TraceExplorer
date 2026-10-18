/** A convergence is a native path suffix inside the existing square dot berth.
 * Its input is where the path last enters that square, not the final SVG
 * primitive (which can be a tiny fillet or a horizontal arrival from either side).
 * Splits are metadata only: the authored primitives and path bytes stay pinned. */
import type { NativeInk, InkBounds, PortSide } from './routing-plan';
import type { Point } from './path-sampling';
import { PORT_BERTH } from './metrics';

export interface ConvergenceInput {
  readonly primitive: number;
  readonly parameter: number;
  readonly side: PortSide;
  readonly point: Point;
  readonly suffix: readonly NativeInk[];
}
export const convergenceBounds = (dot: Point): InkBounds => ({
  left: dot.x - PORT_BERTH, right: dot.x + PORT_BERTH,
  top: dot.y - PORT_BERTH, bottom: dot.y + PORT_BERTH,
});
const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function tail(run: NativeInk, t: number): NativeInk {
  if (t === 0) return run;
  if (run.length === 2) return [mix(run[0], run[1], t), run[1]];
  const a = mix(run[0], run[1], t), b = mix(run[1], run[2], t), c = mix(run[2], run[3], t);
  const d = mix(a, b, t), e = mix(b, c, t);
  return [mix(d, e, t), e, c, run[3]];
}
const at = (run: NativeInk, t: number): Point => tail(run, t)[0];
const inside = (p: Point, b: InkBounds) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** Roots on monotone polynomial intervals. Derivative roots partition a cubic;
 * testing every interval also handles a curve that exits and re-enters a berth. */
function roots(run: NativeInk, axis: 'x' | 'y', value: number, charge: (work:number,reason?:string)=>void): number[] {
  charge(1, 'convergence roots');
  if (run.length === 2) {
    const delta = run[1][axis] - run[0][axis];
    const t = (value - run[0][axis]) / delta;
    return delta && t >= 0 && t <= 1 ? [t] : [];
  }
  const [p, q, r, s] = run.map(p => p[axis]);
  const a = -p + 3 * q - 3 * r + s, b = 3 * p - 6 * q + 3 * r, c = -3 * p + 3 * q;
  const derivative: number[] = [];
  if (a === 0) { if (b !== 0) derivative.push(-c / (2 * b)); }
  else {
    const discriminant = 4 * b * b - 12 * a * c;
    if (discriminant >= 0) {
      const d = Math.sqrt(discriminant);
      derivative.push((-2 * b - d) / (6 * a), (-2 * b + d) / (6 * a));
    }
  }
  const cuts = [0, ...derivative.filter(t => t > 0 && t < 1).sort((a, b) => a - b), 1];
  const result: number[] = [];
  for (let i = 1; i < cuts.length; i++) {
    let low = cuts[i - 1], high = cuts[i];
    const lo = at(run, low)[axis] - value, hi = at(run, high)[axis] - value;
    if (lo === 0) result.push(low);
    if (hi === 0) result.push(high);
    if (lo * hi >= 0) continue;
    for (let step = 0; step < 52; step++) {
      charge(1, 'convergence root isolation');
      const mid = (low + high) / 2, v = at(run, mid)[axis] - value;
      if ((v < 0) === (lo < 0)) low = mid; else high = mid;
    }
    result.push((low + high) / 2);
  }
  return result;
}

export function convergenceInput(native: readonly NativeInk[], dot: Point, charge: (work:number,reason?:string)=>void = ()=>{}): ConvergenceInput {
  if (!Array.isArray(native) || !native.length) throw new RangeError('Junction approach has no native path');
  if (!Number.isFinite(dot.x) || !Number.isFinite(dot.y)) throw new RangeError('Junction dot must be finite');
  charge(native.length,'convergence path validation');
  for(const run of native) {
    if(!Array.isArray(run) || run.length!==2 && run.length!==4) throw new RangeError('Junction native primitive must have 2 or 4 points');
    charge(run.length,'convergence primitive validation');
    if(run.some(point=>!point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new RangeError('Junction native points must be finite');
  }
  const bounds = convergenceBounds(dot);
  const faces: readonly [PortSide, 'x' | 'y', number][] = [
    ['left', 'x', bounds.left], ['right', 'x', bounds.right], ['top', 'y', bounds.top], ['bottom', 'y', bounds.bottom],
  ];
  for (let primitive = native.length - 1; primitive >= 0; primitive--) {
    charge(1, 'convergence suffix');
    const run = native[primitive];
    const crossings = faces.flatMap(([side, axis, value]) => roots(run, axis, value, charge).map(parameter => ({ side, parameter })))
      .sort((a, b) => a.parameter - b.parameter);
    const cuts = [...new Set([0, ...crossings.map(c => c.parameter), 1])].sort((a, b) => a - b);
    for (let i = cuts.length - 2; i >= 0; i--) {
      if (inside(at(run, (cuts[i] + cuts[i + 1]) / 2), bounds)) continue;
      const parameter = cuts[i + 1], crossing = crossings.find(c => c.parameter === parameter);
      if (!crossing) throw new RangeError('Junction approach does not enter convergence');
      charge(native.length - primitive, 'convergence native suffix');
      const suffix = [tail(run, parameter), ...native.slice(primitive + 1)];
      return { primitive, parameter, side: crossing.side, point: suffix[0][0], suffix };
    }
  }
  // A complete short connector may already start within the berth. Its native
  // departure is still an independent directed input, with no fabricated lead-in.
  const point = native[0][0], next = native.flatMap(run => [...run]).find(p => p.x !== point.x || p.y !== point.y);
  if (!next) throw new RangeError('Junction approach has no tangent');
  const dx = next.x - point.x, dy = next.y - point.y;
  const side: PortSide = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'left' : 'right' : dy > 0 ? 'top' : 'bottom';
  return { primitive: 0, parameter: 0, side, point, suffix: native };
}
