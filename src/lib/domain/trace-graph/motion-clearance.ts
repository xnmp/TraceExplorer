/**
 * A conservative clearance certificate for cubic curves and axis-aligned moving boxes.
 * Coordinates are affine combinations of monotone motion clocks in [0, 1]. Equal clock keys
 * mean the exact same timing/easing; different clocks are allowed to progress independently.
 * Every cubic lies in its control hull. A common separating box edge for all four controls
 * therefore proves clearance for every frame, including between sampled/keyframe times.
 */
export interface MotionCoordinate {
  readonly offset: number;
  readonly clocks: ReadonlyMap<string, number>;
}
export interface MotionPoint { readonly x: MotionCoordinate; readonly y: MotionCoordinate }
export interface MotionBox {
  readonly left: MotionCoordinate; readonly right: MotionCoordinate;
  readonly top: MotionCoordinate; readonly bottom: MotionCoordinate;
}
export const constantCoordinate = (offset: number): MotionCoordinate => ({ offset, clocks: new Map() });
export const movingCoordinate = (from: number, to: number, clock: string): MotionCoordinate =>
  ({ offset: from, clocks: new Map([[clock, to - from]]) });
export function addCoordinates(a: MotionCoordinate, b: MotionCoordinate, weight = 1): MotionCoordinate {
  const clocks = new Map(a.clocks);
  for (const [key, value] of b.clocks) clocks.set(key, (clocks.get(key) ?? 0) + weight * value);
  return { offset: a.offset + weight * b.offset, clocks };
}
export type ClockBounds = (clock: string, from: number, to: number) => readonly [number, number];
const minimum = (value: MotionCoordinate, from: number, to: number, bounds: ClockBounds): number =>
  value.offset + [...value.clocks].reduce((sum, [clock, by]) => {
    const [lo, hi] = bounds(clock, from, to);
    return sum + by * (by >= 0 ? lo : hi);
  }, 0);
/**
 * Failure means unproven (not necessarily intersecting): never interpolate an unproven corridor.
 * Subdivide time to tighten the independent clock bounds; all accepted intervals are certified,
 * never merely sampled. The depth limit can only cause a conservative atomic replacement.
 */
export function curveClearsBox(controls: readonly MotionPoint[], box: MotionBox, duration: number, bounds: ClockBounds, visibleFrom = 0): boolean {
  const separates = (curve: readonly MotionPoint[], from: number, to: number): boolean => {
    const differences = [curve.map(p => addCoordinates(box.left, p.x, -1)),
      curve.map(p => addCoordinates(p.x, box.right, -1)),
      curve.map(p => addCoordinates(box.top, p.y, -1)), curve.map(p => addCoordinates(p.y, box.bottom, -1))];
    return differences.some(side => side.every(value => minimum(value, from, to, bounds) >= -1e-7));
  };
  const midpoint = (a: MotionPoint, b: MotionPoint): MotionPoint => {
    const mean = (a: MotionCoordinate, b: MotionCoordinate) => addCoordinates(constantCoordinate(0), addCoordinates(a, b), .5);
    return { x: mean(a.x, b.x), y: mean(a.y, b.y) };
  };
  // De Casteljau subdivision tightens a curved corner's control hull without flattening it.
  const clearSpace = (curve: readonly MotionPoint[], from: number, to: number, depth: number): boolean => {
    if (separates(curve, from, to)) return true;
    if (depth === 10) return false;
    const [a, b, c, d] = curve, ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    return clearSpace([a, ab, abc, middle], from, to, depth + 1) && clearSpace([middle, bcd, cd, d], from, to, depth + 1);
  };
  const clear = (from: number, to: number, depth: number): boolean => {
    if (separates(controls, from, to)) return true;
    if ((depth === 0 || depth === 12) && clearSpace(controls, from, to, 0)) return true;
    if (depth === 12) return false;
    const middle = (from + to) / 2;
    return clear(from, middle, depth + 1) && clear(middle, to, depth + 1);
  };
  return visibleFrom > duration || clear(visibleFrom, duration, 0);
}
