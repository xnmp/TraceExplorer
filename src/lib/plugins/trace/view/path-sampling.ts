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

/** Corresponding sampled points interpolate on the same eased progress as their tiles. */
export function interpolatePath(from: readonly Point[], to: readonly Point[], progress: number): Point[] {
  return to.map((point, index) => ({
    x: from[index].x + (point.x - from[index].x) * progress,
    y: from[index].y + (point.y - from[index].y) * progress,
  }));
}

/**
 * Move the two sides of an orthogonal route without morphing its topology.
 * Each axis changes displacement on a straight run of that same axis, so
 * horizontal/vertical segments stay horizontal/vertical and cubic corners
 * retain their exact shape. Fixed-cover channels are bounded above the first
 * child row: extend the longest vertical run and the last horizontal run in
 * that corridor. Equal offsets are pure translation.
 */
export function prepareOrthogonalRoute(path: string, channelBottom = Infinity): ((from: Point, to: Point) => string | null) | null {
  const commands = [...path.matchAll(/([MLC])\s*((?:[-+\d.eE,\s])+)/g)].map(match => ({
    kind: match[1], values: match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [],
  }));
  if (!commands.length || commands[0].kind !== 'M' || commands.some(c => c.values.length !== (c.kind === 'C' ? 6 : 2) || c.values.some(n => !Number.isFinite(n)))
    || path.replace(/([MLC])\s*((?:[-+\d.eE,\s])+)/g, '').trim()) return null;
  const split = (axis: number): number => {
    let best = 0, length = -1;
    for (let i = 1; i < commands.length; i++) {
      const before = commands[i - 1].values.slice(-2), c = commands[i];
      if (c.kind !== 'L' || Math.max(c.values[1], before[1]) >= channelBottom || Math.abs(c.values[1 - axis] - before[1 - axis]) > .001) continue;
      const span = Math.abs(c.values[axis] - before[axis]);
      if (span > .001 && (axis === 0 || span > length)) { best = i; length = span; }
    }
    return best;
  };
  const x = split(0), y = split(1);
  return (from, to) => {
    // A route without an appropriate straight channel cannot deform safely.
    if ((!x && Math.abs(from.x - to.x) > .001) || (!y && Math.abs(from.y - to.y) > .001)) return null;
    return commands.map((command, i) => `${command.kind}${command.values.map((n, coordinate) => {
      const axis = coordinate % 2;
      const shift = i < (axis ? y : x) ? from : to;
      return n + (axis ? shift.y : shift.x);
    }).join(' ')}`).join(' ');
  };
}

export function moveOrthogonalRoute(path: string, from: Point, to: Point): string | null {
  return prepareOrthogonalRoute(path)?.(from, to) ?? null;
}

/**
 * Retain the route with the deeper child-side channel while a band moves,
 * then let the caller restore the settled route. SVG endpoints are used:
 * a shared trunk's logical `to` is its source, and junctions are not tiles.
 * Commands and stretch channels are parsed once, outside the frame loop.
 */
export function orthogonalRouteTravel(before: string, after: string, childTop?: { before: number; after: number }): ((progress: number) => string | null) | null {
  const old = flattenPath(before), target = flattenPath(after);
  if (!old?.length || !target?.length) return null;
  const useOld = old.at(-1)!.y >= target.at(-1)!.y;
  const reference = useOld ? old : target;
  const move = prepareOrthogonalRoute(useOld ? before : after, childTop ? useOld ? childTop.before : childTop.after : Infinity);
  if (!move) return null;
  const shift = (from: Point, to: Point, base: Point, progress: number): Point => ({
    x: from.x + (to.x - from.x) * progress - base.x,
    y: from.y + (to.y - from.y) * progress - base.y,
  });
  // Unsupported deformations have an explicit failure contract: callers
  // hide that route for the move and restore the settled layout at completion.
  if (move(shift(old[0], target[0], reference[0], 0), shift(old.at(-1)!, target.at(-1)!, reference.at(-1)!, 0)) === null
    || move(shift(old[0], target[0], reference[0], 1), shift(old.at(-1)!, target.at(-1)!, reference.at(-1)!, 1)) === null) return null;
  return progress => move(shift(old[0], target[0], reference[0], progress),
    shift(old.at(-1)!, target.at(-1)!, reference.at(-1)!, progress));
}
