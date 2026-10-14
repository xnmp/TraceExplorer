/** Exact path slicing for the absolute M/L/C paths emitted by the layout engine. */
import { numberEnd } from "./path-data";
export interface PathPoint { readonly x: number; readonly y: number }
const mix = (a: PathPoint, b: PathPoint, t: number): PathPoint => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const pair = (point: PathPoint) => `${point.x} ${point.y}`;

/**
 * The tokens of `/[MLC]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi`, in order and as written:
 * command letters M, L, C (either case) and unsigned or minus-signed numbers; every other
 * character is skipped. A scan instead of the regular expression, which dominated attachment.
 */
function pathTokenText(path: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < path.length;) {
    const code = path.charCodeAt(i);
    if (code === 77 || code === 76 || code === 67 || code === 109 || code === 108 || code === 99) { tokens.push(path[i]); i++; continue; }
    const end = numberEnd(path, i);
    if (end > i) { tokens.push(path.slice(i, end)); i = end; } else i++;
  }
  return tokens;
}

/** Keep the tail from the first crossing of y, including an exact de Casteljau split of a cubic.
 * Cover routes start above the first child channel and their initial segments run monotonically down. */
export function pathTailAtY(path: string, y: number): { readonly point: PathPoint; readonly tail: string } {
  const tokens = pathTokenText(path);
  let index = 1;
  const point = (): PathPoint => ({ x: Number(tokens[index++]), y: Number(tokens[index++]) });
  let from = point();
  if (from.y >= y) return { point: from, tail: tokens.slice(index).join(" ") };
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "L") {
      const end = point();
      if (end.y >= y) {
        const cut = mix(from, end, end.y === from.y ? 0 : (y - from.y) / (end.y - from.y));
        return { point: cut, tail: `L${pair(end)} ${tokens.slice(index).join(" ")}` };
      }
      from = end;
    } else if (command === "C") {
      const a = point(), b = point(), end = point();
      if (end.y >= y) {
        const split = (t: number) => {
          const p = mix(from, a, t), q = mix(a, b, t), r = mix(b, end, t);
          const u = mix(p, q, t), v = mix(q, r, t);
          return { cut: mix(u, v, t), v, r };
        };
        let low = 0, high = 1;
        for (let step = 0; step < 40; step++) { const mid = (low + high) / 2; if (split(mid).cut.y < y) low = mid; else high = mid; }
        const { cut, v, r } = split((low + high) / 2);
        return { point: cut, tail: `C${pair(v)} ${pair(r)} ${pair(end)} ${tokens.slice(index).join(" ")}` };
      }
      from = end;
    } else throw new Error(`unsupported layout path command: ${command}`);
  }
  return { point: from, tail: "" };
}
