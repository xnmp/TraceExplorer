/**
 * Pure geometry for connector motion: SVG paths made of absolute M, L and C
 * commands (what the layout emits, and how browsers serialize an animated
 * `d`) resampled to a fixed number of points spaced evenly along the path, so
 * any two connectors can be morphed point for point without layout queries.
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

/** Absolute layout commands, with exact control points (no resampling). */
function pathCommands(path: string): { kind: string; values: number[] }[] | null {
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
