/**
 * Pure geometry of connector paths: SVG paths made of absolute M, L and C
 * commands (what the layout emits). Layout quality flattens them
 * (`flattenPath`, `flattenInto`); presentation recognises and applies rigid
 * translations (`pathTranslation`, `translatePath`). `resample` and
 * `samplePathString` space points evenly along a path: the layout geometry
 * tests sample routes with them. Presentation also keeps exact cubic route shapes for continuous deformation.
 */
import { isLetter, isSpace, scanNumber, scanned } from "./path-data";

export interface Point { readonly x: number; readonly y: number }

const CURVE_STEPS = 12;

/** Parses `M x y L x y C x1 y1 x2 y2 x y` (optionally wrapped in `path("…")`) into a polyline; null if unsupported. */
export function flattenPath(d: string): Point[] | null {
  return flattenBody(plainBody(d) ? d : d.trim().replace(/^path\(\s*["']?|["']?\s*\)$/g, ""), false);
}

/** Whether trimming and unwrapping `path(…)` would leave `d` unchanged, decided from its ends alone. */
function plainBody(d: string): boolean {
  const last = d.charCodeAt(d.length - 1);
  return d.length > 0 && !isSpace(d.charCodeAt(0)) && !isSpace(last) && last !== 41 && !d.startsWith("path(");
}

const M = 77, L = 76, C = 67;

/** Polyline coordinates of the last {@link flattenInto}: x, y per point. Grows as needed; never shrinks. */
let flat = new Float64Array(256);

/** The scratch coordinates {@link flattenInto} last wrote (valid until the next call). */
export const flattened = (): Float64Array => flat;

/**
 * One pass over an unwrapped path body, equal to tokenising it with `pathTokens` and
 * running the command machine below: a command letter reads one full group of finite
 * numbers (M and L two, C six), further numbers repeat the command (M continues as L),
 * any other letter or an incomplete group rejects the path, other characters are skipped.
 * `strict` additionally rejects what the layout evaluator's plain-data rule does: a body
 * not led by its only `M`, or any character other than M/L/C (either case), commas,
 * white space and (optionally `+`-signed) numbers. Lowercase commands are rejected either way.
 *
 * Writes the polyline to the shared scratch ({@link flattened}: x, y per point) and returns its
 * point count, or -1 where {@link flattenBody} returns null. Coordinates are stored as the same
 * doubles a point object would hold, so callers can read them without allocating points.
 * @internal shared with the layout evaluator; use {@link flattenPath}.
 */
export function flattenInto(body: string, strict: boolean): number {
  if (strict && body.charCodeAt(0) !== M) return -1;
  let out = flat, n = 0;
  let command = 0, open = false, need = 0, count = 0;
  let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0;
  for (let i = 0; i < body.length;) {
    const code = body.charCodeAt(i);
    let end = (code >= 48 && code <= 57) || code === 45 || code === 46 ? scanNumber(body, i) : -1;
    if (end < 0 && strict && code === 43) {
      // A `+`-signed number is plain; the tokeniser skips the sign and reads the same digits.
      if (body.charCodeAt(i + 1) === 45 || (end = scanNumber(body, i + 1)) < 0) return -1;
    }
    if (end < 0) {
      i++;
      if (isLetter(code)) {
        // The pending group would read this letter as a number.
        if (open || (code !== M && code !== L && code !== C) || (strict && code === M && i !== 1)) return -1;
        command = code; open = true; count = 0; need = code === C ? 6 : 2;
        if (code === C && !n) return -1;
      } else if (strict && code !== 44 && !isSpace(code)) return -1;
      continue;
    }
    i = end;
    const value = scanned[0];
    if (!open) {
      // A number after a complete group repeats the current command.
      if (command === L) need = 2;
      else if (command === C) { if (!n) return -1; need = 6; }
      else return -1;
      open = true; count = 0;
    }
    if (!Number.isFinite(value)) return -1;
    switch (count++) {
      case 0: a0 = value; break;
      case 1: a1 = value; break;
      case 2: a2 = value; break;
      case 3: a3 = value; break;
      case 4: a4 = value; break;
    }
    if (count < need) continue;
    open = false;
    const room = command !== C ? 2 : 2 * CURVE_STEPS;
    if (2 * n + room > out.length) { const grown = new Float64Array(Math.max(2 * out.length, 2 * n + room)); grown.set(out); flat = out = grown; }
    if (command !== C) {
      out[2 * n] = a0; out[2 * n + 1] = a1; n++;
      command = L;
      continue;
    }
    const startX = out[2 * n - 2], startY = out[2 * n - 1], a5 = value;
    for (let step = 1; step <= CURVE_STEPS; step++, n++) {
      const t = step / CURVE_STEPS, u = 1 - t;
      out[2 * n] = u * u * u * startX + 3 * u * u * t * a0 + 3 * u * t * t * a2 + t * t * t * a4;
      out[2 * n + 1] = u * u * u * startY + 3 * u * u * t * a1 + 3 * u * t * t * a3 + t * t * t * a5;
    }
  }
  return open || !n ? -1 : n;
}

/** {@link flattenInto} as point objects; null where it rejects the body. */
export function flattenBody(body: string, strict: boolean): Point[] | null {
  const n = flattenInto(body, strict);
  if (n < 0) return null;
  const xy = flat, points: Point[] = [];
  for (let k = 0; k < n; k++) points.push({ x: xy[2 * k], y: xy[2 * k + 1] });
  return points;
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

export function polyline(points: readonly Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

/** Absolute layout commands, with exact control points (no resampling). */
export function pathCommands(path: string): { kind: string; values: number[] }[] | null {
  const commands = [...path.matchAll(/([MLC])\s*((?:[-+\d.eE,\s])+)/g)].map(match => ({
    kind: match[1], values: match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [],
  }));
  return !commands.length || commands[0].kind !== "M"
    || commands.some(c => c.values.length !== (c.kind === "C" ? 6 : 2) || c.values.some(n => !Number.isFinite(n)))
    || path.replace(/([MLC])\s*((?:[-+\d.eE,\s])+)/g, "").trim() ? null : commands;
}

/** Exact pure translation, including every cubic control point; null for rerouting. */
export function pathTranslation(before: string, after: string): Point | null {
  const a = pathCommands(before), b = pathCommands(after);
  if (!a || !b || a.length !== b.length) return null;
  const shift = { x: b[0].values[0] - a[0].values[0], y: b[0].values[1] - a[0].values[1] };
  return a.every((c, i) => c.kind === b[i].kind && c.values.every((n, j) =>
    Math.abs(b[i].values[j] - n - (j % 2 ? shift.y : shift.x)) < .001)) ? shift : null;
}

export function translatePath(path: string, shift: Point): string | null {
  if (![shift.x, shift.y].every(Number.isFinite)) return null;
  const commands = pathCommands(path)?.map(c => ({ ...c, values: c.values.map((n, i) => n + (i % 2 ? shift.y : shift.x)) }));
  return commands && commands.every(c => c.values.every(Number.isFinite))
    ? commands.map(c => `${c.kind}${c.values.join(" ")}`).join(" ") : null;
}

/** Cubic segments in record-local coordinates. Lines are exact degenerate cubics. */
export type RouteShape = readonly (readonly number[])[];

export function routeShape(path: string, origin: Point): RouteShape | null {
  const commands = pathCommands(path);
  if (!commands || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;
  let x = commands[0].values[0], y = commands[0].values[1];
  const shape: number[][] = [[x - origin.x, y - origin.y]];
  for (const command of commands.slice(1)) {
    if (command.kind === 'M') return null;
    const v = command.values;
    const cubic = command.kind === 'C' ? v : [x + (v[0] - x) / 3, y + (v[1] - y) / 3,
      x + 2 * (v[0] - x) / 3, y + 2 * (v[1] - y) / 3, v[0], v[1]];
    shape.push(cubic.map((n, i) => n - (i % 2 ? origin.y : origin.x)));
    x = cubic[4]; y = cubic[5];
  }
  return shape.every(segment => segment.every(Number.isFinite)) ? shape : null;
}

/** Pad at the endpoint: every original curve is exact at either end, even when topology changes. */
export function mixRouteShape(a: RouteShape, b: RouteShape, progress: number): RouteShape {
  if (progress <= 0) return a;
  if (progress >= 1) return b;
  const segment = (shape: RouteShape, index: number) => {
    if (index < shape.length) return shape[index];
    const end = shape.at(-1)!.slice(-2);
    return [...end, ...end, ...end];
  };
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
    const from = segment(a, i), to = segment(b, i);
    return from.map((n, j) => n * (1 - progress) + to[j] * progress);
  });
}

export const sameRouteShape = (a: RouteShape | undefined, b: RouteShape | undefined): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((segment, i) => segment.length === b[i].length
    && segment.every((n, j) => Math.abs(n - b[i][j]) < .001)));

export const routeShapePath = (shape: RouteShape, origin: Point): string => shape.map((segment, i) =>
  `${i ? 'C' : 'M'}${segment.map((n, j) => n + (j % 2 ? origin.y : origin.x)).join(' ')}`).join(' ');
