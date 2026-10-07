/**
 * Pure geometry for connector motion: SVG paths made of absolute M, L and C
 * commands (what the layout emits, and how browsers serialize an animated
 * `d`) resampled to a fixed number of points spaced evenly along the path, so
 * any two connectors can be morphed point for point without layout queries.
 */
export interface Point { readonly x: number; readonly y: number }

const CURVE_STEPS = 12;

/** Parses `M x y L x y C x1 y1 x2 y2 x y` (optionally wrapped in `path("…")`) into a polyline; null if unsupported. */
export function flattenPath(d: string): Point[] | null {
  const body = d.trim().replace(/^path\(\s*["']?|["']?\s*\)$/g, "");
  const tokens = body.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi);
  if (!tokens?.length) return null;
  const points: Point[] = [];
  let index = 0;
  let command = "";
  const number = () => {
    const value = Number(tokens[index++]);
    if (!Number.isFinite(value)) throw new Error("not a number");
    return value;
  };
  try {
    while (index < tokens.length) {
      if (/[A-Za-z]/.test(tokens[index])) command = tokens[index++];
      if (command === "M" || command === "L") {
        points.push({ x: number(), y: number() });
        if (command === "M") command = "L";
      } else if (command === "C") {
        const start = points.at(-1);
        if (!start) return null;
        const c1 = { x: number(), y: number() }, c2 = { x: number(), y: number() }, end = { x: number(), y: number() };
        for (let step = 1; step <= CURVE_STEPS; step++) {
          const t = step / CURVE_STEPS, u = 1 - t;
          points.push({
            x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
            y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
          });
        }
      } else return null;
    }
  } catch {
    return null;
  }
  return points.length ? points : null;
}

/** `count + 1` points evenly spaced along a polyline (first and last included). */
export function resample(points: readonly Point[], count: number): Point[] {
  if (!points.length) return [];
  const lengths = [0];
  for (let index = 1; index < points.length; index++) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  const total = lengths.at(-1)!;
  const result: Point[] = [];
  let segment = 1;
  for (let step = 0; step <= count; step++) {
    const distance = count ? (total * step) / count : 0;
    while (segment < points.length - 1 && lengths[segment] < distance) segment++;
    const a = points[Math.max(0, segment - 1)], b = points[Math.min(points.length - 1, segment)];
    const span = lengths[Math.min(points.length - 1, segment)] - lengths[Math.max(0, segment - 1)];
    const t = span > 0 ? (distance - lengths[segment - 1]) / span : 0;
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return result;
}

/** Resamples a path string; null when it cannot be parsed. */
export function samplePathString(d: string, count: number): Point[] | null {
  const points = flattenPath(d);
  return points ? resample(points, count) : null;
}

/** Shifts a polyline so its start moves by `from` and its end by `to`, blending in between. */
export function displace(points: readonly Point[], from: Point, to: Point): Point[] {
  const last = Math.max(1, points.length - 1);
  return points.map((point, index) => {
    const t = index / last;
    return { x: point.x + from.x * (1 - t) + to.x * t, y: point.y + from.y * (1 - t) + to.y * t };
  });
}

export function polyline(points: readonly Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}
