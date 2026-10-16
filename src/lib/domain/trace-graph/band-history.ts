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
 * it the hint, so its tile grows downward by the hint's height; losing its last output (a failed
 * or dismissed placeholder, a discard) takes the hint away, and the tile shrinks back by as much.
 * Images may also leave (a discard); the retained subset survives. Anything else (a resize,
 * another cover column, changed relationships, any other change of height) is incompatible, and
 * the band is laid out afresh.
 */
import type { GraphLayout, LayoutRequest, PlacedNode, PlacedRoute, RowBox } from "./layout";
import { overlapLength, segments, type Segment } from "./layout-quality";
import { ARROW, LANE_SEPARATION, spacingFor, TILE } from "./metrics";
import { pathTokens } from "./path-data";
import { distanceToTile, TILE_GRAZE } from "./route-contacts";

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

/** Explicit changes of the layout coordinate basis permit retained tiles to move. */
export function historyRelayoutReason(signature: string, request: LayoutRequest): 'pane-width' | 'tile-size' | undefined {
  const before=parse(signature),after=parse(bandHistorySignature(request));
  if (!before || !after) return undefined;
  if (before[0]!==after[0]) return 'pane-width';
  if (before[1]!==after[1]) return 'tile-size';
  return undefined;
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
    // downward by its height) and goes with the last (the tile shrinks back by as much).
    const gained = fact[2] - old[2] === TILE.hint && !hadChildren.has(old[0]);
    const lost = old[2] - fact[2] === TILE.hint && hadChildren.has(old[0]) && !hasChildren.has(old[0]);
    if (!gained && !lost) return null;
    heights.set(old[0], fact[2]);
  }
  return shared ? { kind: "grown", heights } : null;
}

const EPS = 1e-6;

/**
 * `layout` with each listed tile resized to its new height in place (top-left fixed), by cut and
 * stretch (Papakostas and Tollis 1998, "Interactive Orthogonal Graph Drawing"): everything on or
 * below a horizontal cut moves rigidly, so connectors crossing the cut stretch or shorten along
 * their vertical runs and nothing else changes shape.
 * - Tiles one above the other keep their gap, less only room the layout leaves spare (`keptGap`):
 *   room under a tile beside a taller neighbour in its row (the channel under the row stays) and,
 *   running right, room beyond the stack gap between the tiles of a column.
 * - Growing, the cut is the first line under the tile that crosses no tile, and everything below
 *   it moves down by what the tile and the gaps under it need. If that cut would leave a tile of
 *   the tile's own column in place too close under it, or bring a connector too close to it, the
 *   cut is right under the tile instead, and the neighbours it passes stay.
 * - Shrinking, everything below the cut moves back up as far as the freed space allows, and no
 *   further than any tile's gap to the tile above it allows: otherwise the space stays.
 * - A connector that leaves an unmoved tile's bottom edge on the cut keeps its start and gains a
 *   vertical bridge to the rest. A connector arriving at the tile's left side (running right)
 *   follows its new centre, or steps across just before the tile where following it would run
 *   along another source's line.
 * Null when no cut keeps every connector meeting its tiles where it did and, growing, as clear of
 * other tiles as it was (within `TILE_GRAZE`): the band is then laid out again, its tiles held
 * where `resizedTiles` puts them. Geometry it returns is still checked by the engine's hard gates
 * like any candidate's. Growing a tile and shrinking it back restores the drawing, unless the
 * growth had to cut right under the tile or the shrink had to keep the space.
 */
export function resizedLayout(layout: GraphLayout, heights: ReadonlyMap<string, number>): GraphLayout | null {
  let current = layout;
  for (const [key, height] of resizes(layout, heights)) {
    const next = resizeTile(current, current.nodes.get(key)!, height);
    if (!next) return null;
    current = next;
  }
  return current;
}

/**
 * The tiles of `layout` with each listed tile resized in place and, where one grows, every tile
 * whose top lies on or below its lower edge moved down by as much; no connectors or junctions.
 * When `resizedLayout` cannot resize a committed layout, its tiles are held here while the band
 * is laid out again: a layout without its connectors is never kept as it is.
 */
export function resizedTiles(layout: GraphLayout, heights: ReadonlyMap<string, number>): GraphLayout {
  const nodes = new Map(layout.nodes);
  let height = layout.height;
  for (const [key, size] of resizes(layout, heights)) {
    const tile = nodes.get(key)!, bottom = tile.y + tile.height, delta = Math.max(0, size - tile.height);
    nodes.forEach((n, id) => nodes.set(id, id === key ? { ...n, height: size } : delta && n.y >= bottom - EPS ? { ...n, y: n.y + delta } : n));
    height += delta;
  }
  return { ...layout, nodes, routes: [], junctions: new Map(), rows: [], height };
}

/** The valid height changes of known tiles. */
const resizes = (layout: GraphLayout, heights: ReadonlyMap<string, number>) => [...heights].filter(([key, height]) => {
  const tile = layout.nodes.get(key);
  return !!tile && height > 0 && Number.isFinite(height) && height !== tile.height;
});

/** The first line at or under `y` that crosses none of `nodes`. */
function settle(nodes: Iterable<PlacedNode>, y: number): number {
  const list = [...nodes];
  let line = y;
  for (let moved = true; moved;) {
    moved = false;
    for (const n of list) if (n.y < line - EPS && n.y + n.height > line + EPS) { line = n.y + n.height; moved = true; }
  }
  return line;
}

/** Whether two tiles overlap horizontally: one lies above the other. */
const sharesColumn = (a: PlacedNode, b: PlacedNode) => a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS;

/**
 * The gap two tiles one above the other keep, `gap` apart now, the lower one `room` under the
 * cut. Rows (running down) and shelves (running right) are separated by a channel: the lower
 * tile keeps its distance to the cut (the line under the upper tile's row), and only room above
 * the cut, beside a taller neighbour, is spare. Running right, the tiles of one column of a shelf
 * (one generation in one display row) are stacked `stackGap` apart, and only space beyond that is
 * spare: a shrink may have left it. Never more than they have.
 */
function keptGap(layout: GraphLayout, stackGap: number, upper: PlacedNode, lower: PlacedNode, gap: number, room: number): number {
  const stacked = layout.orientation === "right" && upper.row === lower.row && upper.band === lower.band;
  return Math.min(gap, stacked ? stackGap : Math.max(stackGap, room));
}

function resizeTile(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout | null {
  const resized = { ...tile, height }, bottom = tile.y + tile.height, edge = tile.y + height;
  const stackGap = spacingFor(tile.width).column;
  // The first line under the tile's current lower edge that crosses no tile.
  const cut = settle(layout.nodes.values(), bottom);
  const cuts: (readonly [line: number, delta: number])[] = [];
  if (height > tile.height) {
    // Growing: what lies under the tile in its column keeps its gap. A tile the cut leaves in
    // place must already be far enough below; one that moves, moves at least that far. Running
    // down, the rows below also keep the channel under the tile's row.
    let delta = layout.orientation === "down" ? Math.max(0, edge - cut) : 0, fits = true;
    for (const n of layout.nodes.values()) {
      if (n.key === tile.key || n.y < bottom - EPS || !sharesColumn(n, tile)) continue;
      const kept = keptGap(layout, stackGap, tile, n, n.y - bottom, n.y - cut);
      if (n.y >= cut - EPS) delta = Math.max(delta, edge + kept - n.y);
      else if (n.y - edge < kept - EPS) fits = false;
    }
    if (fits && (cut > bottom + EPS || delta < height - tile.height - EPS)) cuts.push([cut, delta]);
    // Right under the tile, everything below moves down by all the tile grows: every gap stays.
    cuts.push([bottom, height - tile.height]);
  } else {
    // Shrinking frees the space between the cut and the line under the tile's new edge, less
    // anything that stays above the cut but reaches into that space.
    let floor = settle([...layout.nodes.values()].map(n => n.key === tile.key ? resized : n), edge);
    const inside = (y: number) => y > floor + EPS && y < cut - EPS;
    for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < cut - EPS && n.y + n.height > floor + EPS) floor = Math.max(floor, n.y + n.height);
    for (const j of layout.junctions.values()) if (inside(j.y)) floor = Math.max(floor, j.y);
    for (const route of layout.routes) {
      const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number");
      for (let i = 1; i < numbers.length; i += 2) if (inside(numbers[i])) floor = Math.max(floor, numbers[i]);
    }
    // A tile that moves up keeps its gap to every tile that stays above it in its column.
    let delta = cut - floor;
    for (const lower of layout.nodes.values()) {
      if (lower.y < cut - EPS || delta <= EPS) continue;
      for (const upper of layout.nodes.values()) {
        if (upper.y >= cut - EPS || upper.y + upper.height > lower.y + EPS || !sharesColumn(upper, lower)) continue;
        const kept = keptGap(layout, stackGap, upper, lower, lower.y - (upper.y + upper.height), lower.y - cut);
        delta = Math.min(delta, lower.y - (upper.key === tile.key ? edge : upper.y + upper.height) - kept);
      }
    }
    if (delta > EPS) cuts.push([cut, -delta]);
    // Otherwise the tile shrinks alone, and the space stays.
    cuts.push([cut, 0]);
  }
  // A shrink moves what lies below back towards what stays, as it was before the tile grew or
  // as a fresh layout of the smaller tile has it; only growth can bring lines onto tiles.
  const grows = height > tile.height;
  for (const [line, delta] of cuts) {
    const result = moved(layout, tile, resized, line, delta);
    if (result && keepsPorts(layout, result, tile.key) && (!grows || keepsClear(layout, result))) return result;
  }
  return null;
}

/**
 * `layout` with `tile` replaced by `resized` and everything on or below the line `cut` moved down
 * by `delta` (up when negative): tiles whose top is on or below it, junctions, and connector points.
 * Null when a connector's path cannot be read, or an arrival at the tile cannot follow its centre.
 */
function moved(layout: GraphLayout, tile: PlacedNode, resized: PlacedNode, cut: number, delta: number): GraphLayout | null {
  const moves = (y: number) => y >= cut - EPS;
  const nodes = new Map<string, PlacedNode>();
  layout.nodes.forEach((n, id) => nodes.set(id, id === tile.key ? resized : delta && moves(n.y) ? { ...n, y: n.y + delta } : n));
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, delta && moves(j.y) ? { ...j, y: j.y + delta } : j] as const));
  /** Whether (x, y) lies on the lower edge of a tile that stays where it is. */
  const onStayingBottom = (x: number, y: number) => {
    for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < cut - EPS && Math.abs(n.y + n.height - y) < EPS && x >= n.x - EPS && x <= n.x + n.width + EPS) return true;
    return false;
  };
  const oldCentre = tile.y + tile.height / 2, newCentre = resized.y + resized.height / 2, entry = tile.x - ARROW.length;
  /** Arrivals at the tile moved onto its new centre, with what they were before (shifted, not yet re-centred). */
  const arrivals = new Map<number, readonly Command[]>();
  const routes: PlacedRoute[] = [];
  for (const [i, route] of layout.routes.entries()) {
    // Geometry it cannot read, it does not edit.
    const commands = parsePath(route.path);
    if (!commands) return null;
    const shifted = delta ? shiftedPath(commands, moves, delta, onStayingBottom) : commands;
    if (route.terminal && route.to.kind === "node" && route.to.id === tile.key && arrivesLevel(shifted, entry, oldCentre)) {
      const followed = followCentre(shifted, oldCentre, newCentre);
      if (!followed) return null;
      arrivals.set(i, shifted);
      routes.push({ ...route, path: writePath(followed) });
    } else routes.push(sameCommands(shifted, commands) ? route : { ...route, path: writePath(shifted) });
  }
  // An arrival whose run, moved with the centre, now runs along another source's line steps
  // across one arrow length before the tile instead, keeping its run where it was.
  for (const [i, shifted] of arrivals) {
    const own = segments(routes[i].path), source = JSON.stringify(routes[i].from);
    const shares = routes.some(other => other !== routes[i] && JSON.stringify(other.from) !== source
      && segments(other.path).some(t => own.some(s => overlapLength(s, t) > EPS)));
    if (!shares) continue;
    const stepped = followCentre(shifted, oldCentre, newCentre, true);
    if (!stepped) return null;
    routes[i] = { ...routes[i], path: writePath(stepped) };
  }
  // Running down, a row the cut passes through (the tile's, or one whose tiles stay) ends under
  // its lowest tile. Running right, rows bound columns along x, which a vertical move keeps.
  const rows: readonly RowBox[] = layout.orientation !== "down" ? layout.rows : layout.rows.map(r => r.keys.includes(tile.key) || (delta && !moves(r.top) && moves(r.bottom))
    ? { ...r, bottom: Math.max(...r.keys.map(k => { const n = nodes.get(k); return n ? n.y + n.height : -Infinity; }), r.top) }
    : delta && moves(r.top) ? { ...r, top: r.top + delta, bottom: r.bottom + delta } : r);
  // The band keeps its margin under its lowest tile.
  const lowest = (tiles: ReadonlyMap<string, PlacedNode>) => Math.max(...[...tiles.values()].map(n => n.y + n.height));
  return { ...layout, nodes, junctions, routes, rows, height: layout.height + delta + Math.max(0, lowest(nodes) - lowest(layout.nodes) - delta) };
}

/** Whether (x, y) lies on the tile's outline. */
const onOutline = (n: PlacedNode, x: number, y: number) => x >= n.x - .01 && x <= n.x + n.width + .01 && y >= n.y - .01 && y <= n.y + n.height + .01
  && (Math.abs(x - n.x) <= .01 || Math.abs(x - n.x - n.width) <= .01 || Math.abs(y - n.y) <= .01 || Math.abs(y - n.y - n.height) <= .01);

/**
 * Where a connector meets the tiles it connects, relative to each tile's top-left corner: its start
 * where it leaves its tile's outline (a branch leaving a trunk starts elsewhere), and its end where
 * it ends in the arrowhead into its target.
 */
function portOffsets(layout: GraphLayout, route: PlacedRoute, starts: boolean): number[] {
  const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number");
  if (numbers.length < 4) return [];
  const from = starts && route.from.kind === "node" ? layout.nodes.get(route.from.id) : undefined;
  const to = route.terminal && route.to.kind === "node" ? layout.nodes.get(route.to.id) : undefined;
  return [...(from ? [numbers[0] - from.x, numbers[1] - from.y] : []), ...(to ? [numbers[numbers.length - 2] - to.x, numbers[numbers.length - 1] - to.y] : [])];
}

/** Whether every connector of `after` meets the tiles it connects where it did in `before`, but at the resized tile. */
function keepsPorts(before: GraphLayout, after: GraphLayout, resized: string): boolean {
  return after.routes.every((route, i) => {
    if ((route.to.kind === "node" && route.to.id === resized) || (route.from.kind === "node" && route.from.id === resized)) return true;
    const old = before.routes[i], source = old.from.kind === "node" ? before.nodes.get(old.from.id) : undefined;
    const numbers = pathTokens(old.path).filter((t): t is number => typeof t === "number");
    const starts = !!source && numbers.length >= 2 && onOutline(source, numbers[0], numbers[1]);
    const was = portOffsets(before, old, starts), now = portOffsets(after, route, starts);
    return was.length === now.length && was.every((v, k) => Math.abs(v - now[k]) < EPS);
  });
}

/**
 * Whether no connector of `after` comes closer to a tile it neither starts nor ends at than it was
 * in `before`, where that is within `TILE_GRAZE`: a line stretched along a tile's edge, or a tile
 * grown onto a line, reads as the line belonging to the tile; and no junction's dot lies in a
 * tile. Only connectors, dots and tiles the resize changed are compared.
 */
function keepsClear(before: GraphLayout, after: GraphLayout): boolean {
  const changed = [...after.nodes.values()].filter(n => {
    const was = before.nodes.get(n.key);
    return !was || was.y !== n.y || was.height !== n.height;
  });
  const all = [...after.nodes.values()];
  // No junction's dot comes to lie in a tile.
  for (const [id, j] of after.junctions) {
    const moved = before.junctions.get(id)?.y !== j.y;
    for (const n of moved ? all : changed) if (j.x > n.x + EPS && j.x < n.x + n.width - EPS && j.y > n.y + EPS && j.y < n.y + n.height - EPS) return false;
  }
  for (const [i, route] of after.routes.entries()) {
    const old = before.routes[i], tiles = old.path === route.path ? changed : all;
    if (!tiles.length) continue;
    const now = segments(route.path);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [a, b] of now) { minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x); minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y); }
    let was: Segment[] | undefined;
    for (const n of tiles) {
      if ((route.from.kind === "node" && route.from.id === n.key) || (route.to.kind === "node" && route.to.id === n.key)) continue;
      if (n.x > maxX + TILE_GRAZE || n.x + n.width < minX - TILE_GRAZE || n.y > maxY + TILE_GRAZE || n.y + n.height < minY - TILE_GRAZE) continue;
      let near = Infinity;
      for (const s of now) near = Math.min(near, distanceToTile(s, n));
      if (near >= TILE_GRAZE - EPS) continue;
      was ??= segments(old.path);
      const prior = before.nodes.get(n.key);
      let far = Infinity;
      if (prior) for (const s of was) far = Math.min(far, distanceToTile(s, prior));
      if (near < far - EPS) return false;
    }
  }
  return true;
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

/** Whether a path ends in a line arriving rightward at `entry` on the line `level`: an arrival at a tile's left side. */
function arrivesLevel(commands: readonly Command[], entry: number, level: number): boolean {
  const last = commands.length - 1;
  if (last < 1 || commands[last].cmd !== "L") return false;
  const [ex, ey] = endOf(commands[last]), [px, py] = endOf(commands[last - 1]);
  return Math.abs(ex - entry) <= .01 && Math.abs(ey - level) <= .01 && Math.abs(py - level) <= .01 && px < ex - .01;
}

/**
 * A path arriving at a tile's left side on the line `from` (`arrivesLevel`), moved onto the line
 * `to`. Its trailing run on `from` moves with what leads into it: a vertical joint stretches, a
 * curve arriving level keeps arriving level at the new height. A run that starts the path, or
 * follows any other shape (or any run, when `stepped`), keeps its start and takes a vertical step
 * one arrow length before the end, so the arrow still lies on a straight approach. Null when that
 * step would come within `LANE_SEPARATION` of where the run starts: it would run along the edge of
 * the tile the path leaves, or turn straight back at the corner before it.
 */
function followCentre(commands: readonly Command[], from: number, to: number, stepped = false): Command[] | null {
  if (from === to) return [...commands];
  const last = commands.length - 1, [ex] = endOf(commands[last]);
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
  if (step - lx < LANE_SEPARATION - EPS) return null;
  out.splice(last, 1, { cmd: "L", xy: [step, from] }, { cmd: "L", xy: [step, to] }, { cmd: "L", xy: [ex, to] });
  return out;
}
