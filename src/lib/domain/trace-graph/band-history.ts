/**
 * Which committed band history a new request may build on, and the committed geometry adjusted
 * to the request. Pure; no IO.
 *
 * A component's history only grows: an image's inputs never change, and an edit adds outputs.
 * History is therefore kept across *growth* (North 1995, "Incremental Layout in DynaDAG": new
 * nodes are inserted into the previous drawing rather than the drawing being recomputed), as it
 * already is across selection changes. It stays compatible when the pane width, tile size and
 * pinned cover are unchanged and every image both requests know keeps its order, its inputs and
 * its size, with one exception: the expansion hint (`TILE.hint`). An image's first output gives
 * it the hint, so its tile grows downward; losing its last output (a failed or dismissed
 * placeholder, a discard) takes the hint away, and the tile shrinks back. Images may also leave
 * (a discard); the retained subset survives. Anything else (a resize, another cover column,
 * changed relationships) is incompatible, and the band is laid out afresh.
 */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute, RowBox } from "./layout";
import { intersectsTile, overlapLength, segments } from "./layout-quality";
import { ARROW } from "./metrics";
import { mapPathNumbers, pathTokens } from "./path-data";

/** Identity of a band request's geometry: what its committed history must match. */
type Fact = readonly [key: string, width: number, height: number, order: number, parents: readonly string[]];
type Signature = readonly [maxWidth: number, tileWidth: number | undefined, pinned: unknown, facts: readonly Fact[]];

export function bandHistorySignature(request: LayoutRequest): string {
  return JSON.stringify([request.maxWidth, request.tileWidth, request.pinned,
    [...(request.band?.items ?? request.items)].sort((a, b) => a.key.localeCompare(b.key)).map(n => [n.key, n.width, n.height, n.order, [...new Set(n.parents)].sort()])]);
}

function parse(signature: string): Signature | null {
  try {
    const value: unknown = JSON.parse(signature);
    if (!Array.isArray(value) || value.length !== 4 || !Array.isArray(value[3])) return null;
    for (const fact of value[3]) if (!Array.isArray(fact) || fact.length !== 5 || typeof fact[0] !== "string" || !Array.isArray(fact[4])) return null;
    return value as unknown as Signature;
  } catch { return null; }
}

/**
 * How a committed history relates to a request: the same component, a grown one (images arrived
 * or left; `heights`: the tiles whose expansion hint appeared or left, at their new heights), or neither.
 */
export type HistoryFit = { readonly kind: "same" } | { readonly kind: "grown"; readonly heights: ReadonlyMap<string, number> } | null;

export function historyFit(signature: string, request: LayoutRequest): HistoryFit {
  const now = bandHistorySignature(request);
  if (signature === now) return { kind: "same" };
  const before = parse(signature), after = parse(now);
  if (!before || !after || JSON.stringify(before.slice(0, 3)) !== JSON.stringify(after.slice(0, 3))) return null;
  const known = new Map(after[3].map(f => [f[0], f]));
  const hadChildren = new Set(before[3].flatMap(f => f[4])), hasChildren = new Set(after[3].flatMap(f => f[4]));
  const heights = new Map<string, number>();
  let shared = 0;
  for (const old of before[3]) {
    const fact = known.get(old[0]);
    if (!fact) continue;
    shared++;
    if (fact[1] !== old[1] || fact[3] !== old[3] || JSON.stringify(fact[4]) !== JSON.stringify(old[4])) return null;
    if (fact[2] === old[2]) continue;
    // Only the expansion hint changes a tile: it comes with the first output (the tile grows
    // downward) and goes with the last (the tile shrinks back).
    const gained = fact[2] > old[2] && !hadChildren.has(old[0]);
    const lost = fact[2] < old[2] && hadChildren.has(old[0]) && !hasChildren.has(old[0]);
    if (!gained && !lost) return null;
    heights.set(old[0], fact[2]);
  }
  return shared ? { kind: "grown", heights } : null;
}

const EPS = 1e-6;

/**
 * `layout` with each listed tile resized to its new height in place (top-left fixed), by cut and
 * stretch (Papakostas and Tollis 1998, "Interactive Orthogonal Graph Drawing"): everything on or
 * below a horizontal cut that crosses no tile moves rigidly, so connectors crossing the cut
 * stretch or shorten along their vertical runs and nothing else changes shape.
 * - Growing, the cut is the first clear line under the tile, and everything below it moves down
 *   by what the tile needs (nothing, when its row already has the room). If a connector passes
 *   through that room, the cut is right under the tile instead, and neighbours it passes stay.
 * - Shrinking, everything below the cut moves back up as far as the space the tile frees allows.
 * - A connector that leaves an unmoved tile's bottom edge on the cut keeps its start and gains a
 *   vertical bridge to the rest. A connector arriving at the tile's left side (running right)
 *   follows its new centre, or steps across just before the tile where following it would run
 *   along another source's line.
 * Geometry the engine cannot use is caught by its hard gates like any candidate's. Growing a tile
 * and shrinking it back restores the drawing, unless the growth had to cut right under the tile.
 */
export function resizedLayout(layout: GraphLayout, heights: ReadonlyMap<string, number>): GraphLayout {
  let current = layout;
  for (const [key, height] of heights) {
    const tile = current.nodes.get(key);
    if (!tile || !(height > 0) || !Number.isFinite(height) || height === tile.height) continue;
    current = resizeTile(current, tile, height);
  }
  return current;
}

/** The first line at or under `y` that crosses none of `nodes` (other than `skip`). */
function settle(nodes: Iterable<PlacedNode>, y: number, skip?: string): number {
  const list = [...nodes].filter(n => n.key !== skip);
  let line = y;
  for (let moved = true; moved;) {
    moved = false;
    for (const n of list) if (n.y < line - EPS && n.y + n.height > line + EPS) { line = n.y + n.height; moved = true; }
  }
  return line;
}

function resizeTile(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout {
  const resized = { ...tile, height }, bottom = tile.y + tile.height;
  // The cut lies under the tile's current lower edge, below every tile that edge would cut through.
  const cut = settle(layout.nodes.values(), bottom);
  if (height > tile.height) {
    // Growing needs the space under the tile. Space the row already has (a taller neighbour) is
    // used as it is, unless a connector passes through it; then the cut is right under the tile,
    // and the neighbours it would cut through stay where they are.
    const settled = moved(layout, tile, resized, cut, Math.max(0, tile.y + height - cut));
    return cut > bottom + EPS && crossesTile(settled, resized) ? moved(layout, tile, resized, bottom, height - tile.height) : settled;
  }
  // Shrinking frees the space between the cut and the line under the tile's new edge, less
  // anything that stays above the cut but reaches into that space.
  let floor = settle([...layout.nodes.values()].map(n => n.key === tile.key ? resized : n), tile.y + height);
  const inside = (y: number) => y > floor + EPS && y < cut - EPS;
  for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < cut - EPS && n.y + n.height > floor + EPS) floor = Math.max(floor, n.y + n.height);
  for (const j of layout.junctions.values()) if (inside(j.y)) floor = Math.max(floor, j.y);
  for (const route of layout.routes) {
    const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number");
    for (let i = 1; i < numbers.length; i += 2) if (inside(numbers[i])) floor = Math.max(floor, numbers[i]);
  }
  return moved(layout, tile, resized, cut, -Math.max(0, cut - floor));
}

/** Whether a connector that neither starts nor ends at `tile` passes through it, or a junction lies in it. */
function crossesTile(layout: GraphLayout, tile: PlacedNode): boolean {
  for (const j of layout.junctions.values()) if (j.x > tile.x && j.x < tile.x + tile.width && j.y > tile.y && j.y < tile.y + tile.height) return true;
  return layout.routes.some(r => !(r.from.kind === "node" && r.from.id === tile.key) && !(r.to.kind === "node" && r.to.id === tile.key)
    && segments(r.path).some(s => intersectsTile(s, tile)));
}

/**
 * `layout` with `tile` replaced by `resized` and everything on or below the line `cut` moved down
 * by `delta` (up when negative): tiles whose top is on or below it, junctions, and connector points.
 */
function moved(layout: GraphLayout, tile: PlacedNode, resized: PlacedNode, cut: number, delta: number): GraphLayout {
  const height = resized.height;
  const moves = (y: number) => y >= cut - EPS;
  const nodes = new Map<string, PlacedNode>();
  layout.nodes.forEach((n, id) => nodes.set(id, id === tile.key ? resized : delta && moves(n.y) ? { ...n, y: n.y + delta } : n));
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, delta && moves(j.y) ? { ...j, y: j.y + delta } : j] as const));
  /** Whether (x, y) lies on the lower edge of a tile that stays where it is. */
  const onStayingBottom = (x: number, y: number) => {
    for (const n of nodes.values()) if (n.y < cut - EPS && Math.abs(n.y + n.height - y) < EPS && x >= n.x - EPS && x <= n.x + n.width + EPS) return true;
    return false;
  };
  const oldCentre = tile.y + tile.height / 2, newCentre = tile.y + height / 2, entry = tile.x - ARROW.length;
  /** Arrivals at the tile moved onto its new centre, with what they were before (shifted, not yet re-centred). */
  const arrivals = new Map<number, readonly Command[]>();
  const routes: PlacedRoute[] = layout.routes.map((route, i) => {
    const commands = parsePath(route.path);
    if (!commands) {
      const moved = delta ? mapPathNumbers(route.path, (v, k) => k % 2 === 1 && moves(v) ? v + delta : v) : route.path;
      return moved === route.path ? route : { ...route, path: moved };
    }
    const shifted = delta ? shiftedPath(commands, moves, delta, onStayingBottom) : commands;
    const followed = route.terminal && route.to.kind === "node" && route.to.id === tile.key ? followCentre(shifted, entry, oldCentre, newCentre) : null;
    if (followed) arrivals.set(i, shifted);
    return !followed && sameCommands(shifted, commands) ? route : { ...route, path: writePath(followed ?? shifted) };
  });
  // An arrival whose run, moved with the centre, now runs along another source's line steps
  // across one arrow length before the tile instead, keeping its run where it was.
  for (const [i, shifted] of arrivals) {
    const own = segments(routes[i].path), source = JSON.stringify(routes[i].from);
    const shares = routes.some(other => other !== routes[i] && JSON.stringify(other.from) !== source
      && segments(other.path).some(t => own.some(s => overlapLength(s, t) > EPS)));
    const stepped = shares ? followCentre(shifted, entry, oldCentre, newCentre, true) : null;
    if (stepped) routes[i] = { ...routes[i], path: writePath(stepped) };
  }
  // A row the cut passes through (the tile's, or one whose tiles stay) ends under its lowest tile.
  const rows: RowBox[] = layout.rows.map(r => r.keys.includes(tile.key) || (delta && !moves(r.top) && moves(r.bottom))
    ? { ...r, bottom: Math.max(...r.keys.map(k => { const n = nodes.get(k); return n ? n.y + n.height : -Infinity; }), r.top) }
    : delta && moves(r.top) ? { ...r, top: r.top + delta, bottom: r.bottom + delta } : r);
  return { ...layout, nodes, junctions, routes, rows, height: layout.height + delta };
}

/**
 * `commands` with every point on or below the cut (`moves`) moved by `delta`. A path that starts
 * on the lower edge of a tile that stays keeps its start. Growing, a piece that leaves the part
 * that stays for the part that moves other than by a vertical line (which simply stretches) is
 * moved whole, after a vertical bridge from where it left: a curve leaving vertically keeps its
 * shape and its tangent, rather than being stretched across the space the tile now takes.
 */
function shiftedPath(commands: readonly Command[], moves: (y: number) => boolean, delta: number, onStayingBottom: (x: number, y: number) => boolean): Command[] {
  const [sx, sy] = commands[0].xy;
  let px = sx, py = sy, moved = moves(sy) && !onStayingBottom(sx, sy);
  const out: Command[] = [{ cmd: "M", xy: [sx, moved ? sy + delta : sy] }];
  for (let i = 1; i < commands.length; i++) {
    const c = commands[i], [ex, ey] = endOf(c), ends = moves(ey);
    const vertical = c.cmd === "L" && Math.abs(c.xy[0] - px) < EPS, leavesDown = c.cmd !== "C" || Math.abs(c.xy[0] - px) < EPS;
    if (delta > 0 && !moved && ends && !vertical && leavesDown) {
      out.push({ cmd: "L", xy: [px, py + delta] }, { cmd: c.cmd, xy: c.xy.map((v, k) => k % 2 ? v + delta : v) });
    } else {
      const next: Command = { cmd: c.cmd, xy: c.xy.map((v, k) => k % 2 && moves(v) ? v + delta : v) };
      // A line the move closed up (a bridge a shrink takes back) is dropped.
      const [qx, qy] = endOf(out[out.length - 1]);
      const closed = c.cmd === "L" && Math.abs(next.xy[0] - qx) < EPS && Math.abs(next.xy[1] - qy) < EPS && !(Math.abs(ex - px) < EPS && Math.abs(ey - py) < EPS);
      if (!closed) out.push(next);
    }
    px = ex; py = ey; moved = ends;
  }
  return out;
}

/** Whether two command lists draw the same path. */
const sameCommands = (a: readonly Command[], b: readonly Command[]) =>
  a.length === b.length && a.every((c, i) => c.cmd === b[i].cmd && c.xy.every((v, k) => v === b[i].xy[k]));

/** One absolute path command: M and L carry one point, C its two control points and its end. */
interface Command { readonly cmd: "M" | "L" | "C"; readonly xy: readonly number[] }

/** Absolute M/L/C path data as commands (further coordinates continue a command, after M as L); null for anything else. */
function parsePath(path: string): Command[] | null {
  const tokens = pathTokens(path), out: Command[] = [];
  let cmd: Command["cmd"] | null = null;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    if (typeof token === "string") {
      // Exactly one M, and first.
      if ((token !== "M" && token !== "L" && token !== "C") || (token === "M") !== (out.length === 0)) return null;
      cmd = token; i++; continue;
    }
    if (!cmd) return null;
    const count = cmd === "C" ? 6 : 2, xy = tokens.slice(i, i + count);
    if (xy.length !== count || xy.some(v => typeof v !== "number" || !Number.isFinite(v))) return null;
    out.push({ cmd, xy: xy as number[] });
    if (cmd === "M") cmd = "L";
    i += count;
  }
  return out.length ? out : null;
}

const writePath = (commands: readonly Command[]) => commands.map((c, i) => c.cmd === "C"
  ? `${i ? " " : ""}C${c.xy[0]} ${c.xy[1]},${c.xy[2]} ${c.xy[3]},${c.xy[4]} ${c.xy[5]}`
  : `${i ? " " : ""}${c.cmd}${c.xy[0]} ${c.xy[1]}`).join("");

const endOf = (c: Command): readonly [number, number] => c.cmd === "C" ? [c.xy[4], c.xy[5]] : [c.xy[0], c.xy[1]];

/**
 * A path arriving horizontally at `entry` on the line `from`, moved onto the line `to` (null if it
 * does not arrive so). Its trailing run on `from` moves with what leads into it: a vertical joint
 * stretches, a curve arriving level keeps arriving level at the new height. A run that starts the
 * path, or follows any other shape (or any run, when `stepped`), keeps its start and takes a
 * vertical step one arrow length before the end, so the arrow still lies on a straight approach.
 */
function followCentre(commands: readonly Command[], entry: number, from: number, to: number, stepped = false): Command[] | null {
  if (from === to || commands.length < 2) return null;
  const last = commands.length - 1, [ex, ey] = endOf(commands[last]);
  if (commands[last].cmd !== "L" || Math.abs(ex - entry) > .01 || Math.abs(ey - from) > .01) return null;
  // The trailing run: the last lines along `from`, from the end of command `run - 1`. A line
  // that ends where it starts is a vertical joint an earlier move closed up, not part of the run.
  let run = last;
  for (; run > 1 && commands[run - 1].cmd === "L"; run--) {
    const [x, y] = endOf(commands[run - 1]), [px, py] = endOf(commands[run - 2]);
    if (Math.abs(y - from) > .01 || Math.abs(py - from) > .01 || Math.abs(x - px) < .01) break;
  }
  const lead = commands[run - 1], [lx, ly] = endOf(lead);
  if (Math.abs(ly - from) > .01) return null;
  const level = (c: Command): Command => ({ cmd: c.cmd, xy: [c.xy[0], to] });
  const out = commands.map(c => c);
  const before = run >= 2 ? endOf(commands[run - 2]) : null;
  if (!stepped && lead.cmd === "L" && before && Math.abs(before[0] - lx) < .01) {
    out[run - 1] = level(lead);
    for (let i = run; i <= last; i++) out[i] = level(commands[i]);
    return out;
  }
  if (!stepped && lead.cmd === "C" && Math.abs(lead.xy[3] - from) < .01) {
    out[run - 1] = { cmd: "C", xy: [lead.xy[0], lead.xy[1], lead.xy[2], to, lead.xy[4], to] };
    for (let i = run; i <= last; i++) out[i] = level(commands[i]);
    return out;
  }
  const step = ex - ARROW.length;
  out.splice(last, 1, { cmd: "L", xy: [step, from] }, { cmd: "L", xy: [step, to] }, { cmd: "L", xy: [ex, to] });
  return out;
}
