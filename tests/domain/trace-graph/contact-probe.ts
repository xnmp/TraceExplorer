import type { GraphLayout } from "../../../src/lib/domain/trace-graph/layout";
export type Point = { x: number; y: number };
// Independent M/L/C reader. Corners are exact L/L turns; cubics are sampled only for distances.
export function read(path: string, steps = 120) {
  const tokens = path.match(/[MLC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  const points: Point[] = [], corners: Point[] = [];
  let previousCommand = '';
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++];
    const point = () => ({ x: +tokens[i++], y: +tokens[i++] });
    if (command === 'M') points.push(point());
    else if (command === 'L') {
      const next = point(), current = points.at(-1)!;
      if (previousCommand === 'L' && points.length > 1) {
        const prior = points.at(-2)!;
        const cross = (current.x - prior.x) * (next.y - current.y) - (current.y - prior.y) * (next.x - current.x);
        if (Math.abs(cross) > 1e-8) corners.push(current);
      }
      points.push(next);
    } else if (command === 'C') {
      const a = points.at(-1)!, b = point(), c = point(), d = point();
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        points.push({ x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
          y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y });
      }
    } else throw new Error(`unsupported command ${command}`);
    previousCommand = command;
  }
  return { points, corners };
}
export function distance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
  const t = d ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function contacts(layout: GraphLayout) {
  const routes = layout.routes.map(r => ({ ...r, ...read(r.path, 40) }));
  const found: unknown[] = [];
  for (const r of routes) for (const t of routes) {
    if (r === t || r.from.kind === t.from.kind && r.from.id === t.from.id) continue;
    // Actual shared junction endpoints are intentional connections, not false joins.
    if ([r.from, r.to].some(a => a.kind === 'junction' && [t.from, t.to].some(b => a.kind === b.kind && a.id === b.id))) continue;
    const probes = [...r.corners.map(p => ({ p, kind: 'corner', limit: 2.9 })),
      ...(r.from.kind === 'node' ? [{ p: r.points[0], kind: 'start', limit: 2.9 }] : []),
      ...(r.to.kind === 'node' && !r.terminal ? [{ p: r.points.at(-1)!, kind: 'fork', limit: 2.9 }] : [])];
    for (const { p, kind, limit } of probes) {
      let best = Infinity, segment: Point[] = [];
      for (let i = 1; i < t.points.length; i++) {
        const d = distance(p, t.points[i - 1], t.points[i]);
        if (d < best) { best = d; segment = [t.points[i - 1], t.points[i]]; }
      }
      if (best < limit) found.push({ route: r.id, other: t.id, kind, p, distance: best, segment, path: r.path, otherPath: t.path });
    }
  }
  return found;
}

