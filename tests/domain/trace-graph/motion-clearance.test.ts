import { describe, expect, it } from 'vitest';
import { constantCoordinate as c, movingCoordinate as m, curveClearsBox, type MotionPoint } from '$lib/domain/trace-graph/motion-clearance';
const point = (x: number, y: number): MotionPoint => ({ x: c(x), y: c(y) });
const bounds = (_clock: string, from: number, to: number): readonly [number, number] => [from / 160, to / 160];
const box = { left: c(4), right: c(6), top: c(4), bottom: c(6) };

describe('motion corridor certificate', () => {
  it('rejects a moving curve whose clear endpoints straddle a tile', () => {
    const line = [0, 1, 9, 10].map(y => ({ x: m(0, 10, 'route'), y: c(y) }));
    expect(curveClearsBox(line, box, 160, bounds)).toBe(false);
  });
  it('rejects a moving tile crossing a stationary route', () => {
    const line = [point(0, 5), point(3, 5), point(7, 5), point(10, 5)];
    expect(curveClearsBox(line, { ...box, top: m(0, 10, 'tile'), bottom: m(2, 12, 'tile') }, 160, bounds)).toBe(false);
  });
  it('certifies every painted frame after an exactly transparent arrival window', () => {
    const line = [0, 3, 7, 10].map(x => ({ x: c(x), y: m(5, 15, 'route') }));
    expect(curveClearsBox(line, box, 160, bounds)).toBe(false);
    expect(curveClearsBox(line, box, 160, bounds, 40)).toBe(true);
    // Visibility begins before clearance: even a brief overlap must reject the motion.
    expect(curveClearsBox(line, box, 160, bounds, 8)).toBe(false);
  });
  it('preserves shared-clock clearance while translating across a large distance', () => {
    const line = [0, 3, 7, 10].map(y => ({ x: m(0, 10000, 'shared'), y: c(y) }));
    expect(curveClearsBox(line, { ...box, left: m(4, 10004, 'shared'), right: m(6, 10006, 'shared') }, 160, bounds)).toBe(true);
  });
  it('subdivides exact cubic control hulls to certify a clear curved arch', () => {
    const arch = [point(0, 0), point(0, 10), point(10, 10), point(10, 0)];
    expect(curveClearsBox(arch, { left: c(4), right: c(6), top: c(1), bottom: c(3) }, 160, bounds)).toBe(true);
  });
});
