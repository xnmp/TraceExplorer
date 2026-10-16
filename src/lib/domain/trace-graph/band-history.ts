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
import type { GraphLayout, LayoutRequest, PlacedJunction, PlacedNode, PlacedRoute, ResizeRecord, RowBox } from "./layout";
import { overlapLength, segments, type Segment } from "./layout-quality";
import { ARROW, JUNCTION_BERTH, LANE_SEPARATION, spacingFor, TILE, TRACK_HEIGHT } from "./metrics";
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
 * like any candidate's. A growth is recorded on the layout it returns (`ResizeRecord`), and
 * shrinking the tile back undoes it exactly when nothing else changed since, which growing the
 * tile again must confirm; otherwise the shrink cuts as above.
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
  let height = layout.height, bandBounds = layout.bandBounds;
  for (const [key, size] of resizes(layout, heights)) {
    const tile = nodes.get(key)!, bottom = tile.y + tile.height, delta = Math.max(0, size - tile.height);
    nodes.forEach((n, id) => nodes.set(id, id === key ? { ...n, height: size } : delta && n.y >= bottom - EPS ? { ...n, y: n.y + delta } : n));
    height += delta;
    if (bandBounds && delta && bandBounds.top >= bottom - EPS) bandBounds = { ...bandBounds, top: bandBounds.top + delta };
  }
  return { ...layout, ...(bandBounds ? { bandBounds } : {}), nodes, routes: [], junctions: new Map(), rows: [], height };
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
  if (height < tile.height) { const undone = undoneGrowth(layout, tile, height); if (undone) return undone; }
  const result = resizedInPlace(layout, tile, height);
  return result && height > tile.height ? recorded(layout, result, tile, height) : result;
}

/** How many growths a layout remembers, latest first, to undo them in turn. */
const RECORD_DEPTH = 4;

/** `grown`, the result of growing `tile` of `layout` to `height`, with what the growth changed recorded on it. */
function recorded(layout: GraphLayout, grown: GraphLayout, tile: PlacedNode, height: number): GraphLayout {
  const nodes = [...layout.nodes.values()].filter(n => grown.nodes.get(n.key) !== n);
  const junctions = [...layout.junctions].filter(([id, j]) => grown.junctions.get(id) !== j);
  const routes = layout.routes.flatMap((route, i): (readonly [number, string])[] => grown.routes[i]?.path !== route.path ? [[i, route.path]] : []);
  const previous = trimmed(layout.resized, RECORD_DEPTH - 1);
  const record: ResizeRecord = { key: tile.key, from: tile.height, to: height, nodes, junctions, routes,
    rows: grown.rows === layout.rows ? undefined : layout.rows, height: layout.height, bandBounds: layout.bandBounds, ...(previous ? { previous } : {}) };
  return { ...grown, resized: record };
}

/** The first `depth` records of a chain: the chain itself when it is no longer. */
function trimmed(record: ResizeRecord | undefined, depth: number): ResizeRecord | undefined {
  if (!record || depth <= 0) return undefined;
  const rest = trimmed(record.previous, depth - 1);
  return rest === record.previous ? record : { ...record, previous: rest };
}

/**
 * `layout` before the growth of `tile` its latest record holds, when the tile shrinks back to the
 * height it grew from and growing it again gives exactly `layout`: nothing else changed since.
 */
function undoneGrowth(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout | null {
  const record = layout.resized;
  if (!record || record.key !== tile.key || record.from !== height || record.to !== tile.height) return null;
  const nodes = new Map(layout.nodes), junctions = new Map(layout.junctions), routes = [...layout.routes];
  for (const n of record.nodes) { if (!nodes.has(n.key)) return null; nodes.set(n.key, n); }
  for (const [id, j] of record.junctions) { if (!junctions.has(id)) return null; junctions.set(id, j); }
  for (const [i, path] of record.routes) { if (!routes[i]) return null; routes[i] = { ...routes[i], path }; }
  const { resized: _, bandBounds: __, ...rest } = layout;
  const undone: GraphLayout = { ...rest, nodes, junctions, routes, rows: record.rows ?? layout.rows, height: record.height,
    ...(record.bandBounds ? { bandBounds: record.bandBounds } : {}), ...(record.previous ? { resized: record.previous } : {}) };
  const again = resizedInPlace(undone, nodes.get(tile.key)!, record.to);
  return again && sameDrawing(again, layout) ? undone : null;
}

function resizedInPlace(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout | null {
  const resized = { ...tile, height }, bottom = tile.y + tile.height, edge = tile.y + height;
  const stackGap = spacingFor(tile.width).column;
  // The first line under the tile's current lower edge that crosses no tile.
  const cut = settle(layout.nodes.values(), bottom);
  const cuts: (readonly [line: number, delta: number, slab?: Slab])[] = [];
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
    // anything that stays above the cut but reaches into that space: any tile (rows keep the
    // channel under their lowest tile, as growing keeps it), and dots and lines in the slab that moves.
    const shrink = (slab?: Slab): number => {
      const within = (x: number) => !slab || (x >= slab[0] - EPS && x <= slab[1] + EPS);
      let floor = settle([...layout.nodes.values()].map(n => n.key === tile.key ? resized : n), edge);
      const inside = (y: number) => y > floor + EPS && y < cut - EPS;
      for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < cut - EPS && n.y + n.height > floor + EPS) floor = Math.max(floor, n.y + n.height);
      for (const j of layout.junctions.values()) if (within(j.x) && inside(j.y)) floor = Math.max(floor, j.y);
      for (const route of layout.routes) {
        const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number");
        for (let i = 1; i < numbers.length; i += 2) if (within(numbers[i - 1]) && inside(numbers[i])) floor = Math.max(floor, numbers[i]);
      }
      // A tile that moves up keeps its gap to every tile that stays above it in its column.
      let delta = cut - floor;
      for (const lower of layout.nodes.values()) {
        if (lower.y < cut - EPS || delta <= EPS || !movesTile(lower, cut, slab)) continue;
        for (const upper of layout.nodes.values()) {
          if (upper.y >= cut - EPS || upper.y + upper.height > lower.y + EPS || !sharesColumn(upper, lower)) continue;
          const kept = keptGap(layout, stackGap, upper, lower, lower.y - (upper.y + upper.height), lower.y - cut);
          delta = Math.min(delta, lower.y - (upper.key === tile.key ? edge : upper.y + upper.height) - kept);
        }
      }
      return delta;
    };
    const slab = slabFor(layout, tile, cut);
    const narrow = slab ? shrink(slab) : 0;
    if (slab && narrow > EPS) cuts.push([cut, -narrow, slab]);
    const delta = shrink();
    if (delta > EPS) cuts.push([cut, -delta]);
    // Otherwise the tile shrinks alone, and the space stays.
    cuts.push([cut, 0]);
  }
  // A shrink moves what lies below back towards what stays, as it was before the tile grew or
  // as a fresh layout of the smaller tile has it; only growth can bring lines onto tiles.
  const grows = height > tile.height;
  // Growing, the least movement first: shove what lies under the tile; failing that, cut and stretch.
  const shoved = grows ? shove(layout, tile, height) : null;
  if (shoved && keepsPorts(layout, shoved, tile.key) && keepsClear(layout, shoved)) return shoved;
  for (const [line, delta, given] of cuts) {
    // Growing, only the slab under the tile that nothing below the cut leaves sideways moves,
    // when there is one; failing that, everything below the cut.
    const slab = given ?? (grows && delta ? slabFor(layout, tile, line) : null);
    const slabs: readonly (Slab | undefined)[] = given ? [given] : slab ? [slab, undefined] : [undefined];
    for (const slab of slabs) {
      const result = moved(layout, tile, resized, line, delta, slab);
      if (result && keepsPorts(layout, result, tile.key) && (!grows || keepsClear(layout, result))) return result;
    }
  }
  return null;
}

/**
 * Room the drawing needs under a thing above another it overlaps horizontally: a row's channel
 * between tiles; bend tracks under a tile; a track and the arrowhead's approach above a tile; a
 * dot's berth; one track between lines.
 */
function roomUnder(space: ReturnType<typeof spacingFor>, upper: Thing["kind"], lower: Thing["kind"]): number {
  if (upper === "tile") return lower === "tile" ? space.bandChannel : 3 * TRACK_HEIGHT;
  if (lower === "tile") return space.approach + TRACK_HEIGHT;
  return upper === "dot" || lower === "dot" ? JUNCTION_BERTH : TRACK_HEIGHT;
}

interface Thing {
  readonly kind: "tile" | "line" | "dot";
  readonly left: number; readonly right: number; readonly top: number; readonly bottom: number;
  /** Its body. */
  readonly id: number;
  /** For a connector's corner: a vertical line leaves it upward (`over`), downward (`beneath`). */
  over?: boolean; beneath?: boolean;
}

/**
 * `tile` grown to `height` in a layout running down by pushing what lies under its lower edge no
 * further than it must: one-dimensional compaction by longest paths in a constraint graph, as
 * layout compactors and interactive routers' "shove" do (Hsueh and Pederson 1979). Things are
 * tiles, junction dots and connector pieces; each belongs to a body that moves as a unit: a
 * horizontal or slanted line or a curve moves whole, with the dots and tiles its ends meet and the
 * branches leaving it; vertical lines stretch. Of two things one above the other that overlap
 * horizontally, the lower keeps at least the room the drawing needs below the upper (`roomUnder`),
 * or what it had if that was less. An arrival at the tile's side follows its centre, as cutting
 * does. Null when the layout does not run down, the tile is the cover (the band's top moves with
 * it), a connector's path cannot be read, an arrival cannot follow, or a line held where it meets
 * the tile's top or sides (or a tile beside it) would have to move.
 */
function shove(layout: GraphLayout, tile: PlacedNode, height: number): GraphLayout | null {
  const edge = tile.y + tile.height, by = height - tile.height;
  if (!(by > 0) || layout.orientation !== "down" || !layout.bandBounds || tile.y + tile.height <= layout.bandBounds.top + EPS) return null;
  const space = spacingFor(tile.width);
  const parent: number[] = [0, 1];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); };
  const element = () => { parent.push(parent.length); return parent.length - 1; };
  // 0: the tile's lower edge; 1: what stays (the tile's top and sides, tiles beside the edge).
  const SEED = 0, FIXED = 1;
  const tiles = new Map<string, number>();
  for (const n of layout.nodes.values()) if (n.key !== tile.key) tiles.set(n.key, element());
  const dots = new Map<string, number>();
  for (const id of layout.junctions.keys()) dots.set(id, element());
  const things: Thing[] = [{ kind: "tile", left: tile.x, right: tile.x + tile.width, top: edge, bottom: edge, id: SEED }];
  for (const n of layout.nodes.values()) if (n.key !== tile.key) things.push({ kind: "tile", left: n.x, right: n.x + n.width, top: n.y, bottom: n.y + n.height, id: tiles.get(n.key)! });
  for (const [id, j] of layout.junctions) things.push({ kind: "dot", left: j.x, right: j.x, top: j.y, bottom: j.y, id: dots.get(id)! });
  const paths: { readonly commands: readonly Command[]; readonly points: readonly number[] }[] = [];
  /** Per source: its routes' rigid pieces and points, where a branch leaving the source's trunk can start. */
  const trunks = new Map<string, { x0: number; y0: number; x1: number; y1: number; id: number }[]>();
  for (const route of layout.routes) {
    const commands = parsePath(route.path);
    if (!commands) return null;
    const points = commands.map(() => element()), source = JSON.stringify(route.from);
    let pieces = trunks.get(source);
    if (!pieces) trunks.set(source, pieces = []);
    const corners: Thing[] = [];
    for (let i = 0; i < commands.length; i++) {
      const [x, y] = endOf(commands[i]);
      const corner: Thing = { kind: "line", left: x, right: x, top: y, bottom: y, id: points[i] };
      things.push(corner);
      corners.push(corner);
      pieces.push({ x0: x, y0: y, x1: x, y1: y, id: points[i] });
      if (!i) continue;
      const [px, py] = endOf(commands[i - 1]), c = commands[i];
      if (c.cmd === "L" && Math.abs(c.xy[0] - px) < EPS) {
        // A vertical line: the corner it leaves downward lies over the corner it reaches.
        const [upper, lower] = y > py ? [corners[i - 1], corner] : [corner, corners[i - 1]];
        upper.beneath = true; lower.over = true;
        continue;
      }
      union(points[i - 1], points[i]);
      const xs = c.cmd === "C" ? [px, c.xy[0], c.xy[2], c.xy[4]] : [px, x], ys = c.cmd === "C" ? [py, c.xy[1], c.xy[3], c.xy[5]] : [py, y];
      things.push({ kind: "line", left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), id: points[i] });
      if (c.cmd === "L") pieces.push({ x0: px, y0: py, x1: x, y1: y, id: points[i] });
    }
    paths.push({ commands, points });
  }
  const onPiece = (x: number, y: number, q: { x0: number; y0: number; x1: number; y1: number }) => {
    const dx = q.x1 - q.x0, dy = q.y1 - q.y0, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((x - q.x0) * dx + (y - q.y0) * dy) / l)) : 0;
    return Math.hypot(x - q.x0 - t * dx, y - q.y0 - t * dy) < .15;
  };
  layout.routes.forEach((route, r) => {
    const { commands, points } = paths[r], [sx, sy] = endOf(commands[0]), last = points[points.length - 1];
    // A start on its tile's outline moves with it (the grown tile's lower edge with the seed, its
    // other sides not at all); a start elsewhere is a branch, held on the piece of its source's trunk it leaves.
    let held = false;
    if (route.from.kind === "junction") { const dot = dots.get(route.from.id); if (dot !== undefined) { union(points[0], dot); held = true; } }
    else if (route.from.id === tile.key) { if (onOutline(tile, sx, sy)) { union(points[0], Math.abs(sy - edge) < .01 ? SEED : FIXED); held = true; } }
    else { const n = layout.nodes.get(route.from.id); if (n && onOutline(n, sx, sy)) { union(points[0], tiles.get(n.key)!); held = true; } }
    if (!held) for (const q of trunks.get(JSON.stringify(route.from)) ?? []) if (q.id !== points[0] && !points.includes(q.id) && onPiece(sx, sy, q) && (q.x0 !== q.x1 || q.y0 === q.y1)) union(points[0], q.id);
    if (route.to.kind === "junction") { const dot = dots.get(route.to.id); if (dot !== undefined) union(last, dot); }
    else if (route.terminal) union(last, route.to.id === tile.key ? FIXED : tiles.get(route.to.id) ?? FIXED);
  });
  // Tiles across the edge's line stand beside the tile: they stay.
  for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < edge - EPS && n.y + n.height > edge + EPS) union(tiles.get(n.key)!, FIXED);
  if (find(SEED) === find(FIXED)) return null;
  // Pairs one above the other that overlap horizontally, with the spare room between them: the
  // pushes from a body, found when the search below takes it (most bodies never move).
  const floorOf = floors(layout.nodes.values());
  const reach = Math.max(space.bandChannel, space.approach + TRACK_HEIGHT, 3 * TRACK_HEIGHT) + by;
  let span = 0;
  for (const t of things) span = Math.max(span, t.bottom - t.top);
  // Things by top (to find those under a thing), each thing's place by bottom, and the things of each body.
  const byTop = things.map((_, i) => i).sort((a, b) => things[a].top - things[b].top);
  const rankByBottom = new Int32Array(things.length);
  things.map((_, i) => i).sort((a, b) => things[a].bottom - things[b].bottom).forEach((i, rank) => { rankByBottom[i] = rank; });
  const members = new Map<number, number[]>();
  things.forEach((t, i) => { const body = find(t.id), list = members.get(body); if (list) list.push(i); else members.set(body, [i]); });
  /**
   * Pushes from `body` to the bodies under it, with the spare room between them: for each of its
   * things, those under it within reach. Listed by the lower thing, then the upper by bottom.
   */
  const pushesFrom = (body: number): { to: number; slack: number }[] => {
    const found: [lower: number, upper: number, to: number, slack: number][] = [];
    for (const u of members.get(body) ?? []) {
      const upper = things[u], from = upper.bottom - span - 2 * EPS, to = upper.bottom + reach + 2 * EPS;
      let lo = 0, hi = byTop.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (things[byTop[mid]].top < from) lo = mid + 1; else hi = mid; }
      for (let k = lo; k < byTop.length; k++) {
        const l = byTop[k], lower = things[l];
        if (lower.top > to) break;
        // Within reach: nearer than any room the drawing needs plus the growth, and no lower than the tallest thing.
        if (upper.bottom < lower.top - reach || upper.bottom > lower.top + span + EPS) continue;
        // Of two corners at one height, the one a vertical line reaches from above lies over the
        // one a vertical line leaves downward: the lines would otherwise come to run along each other.
        if (upper.top >= lower.top - EPS && !(upper.top <= lower.top + EPS && upper.over && lower.beneath)) continue;
        const margin = upper.kind === "tile" || lower.kind === "tile" ? TILE_GRAZE : LANE_SEPARATION;
        if (!(upper.left < lower.right + margin && lower.left < upper.right + margin)) continue;
        const b = find(lower.id);
        if (b === body) continue;
        // Under a tile, what lies below the floor of its row needs no more room from the floor than
        // it has: a tile shorter than its row grows into the row's spare room first, moving nothing.
        // Still, tiles one above the other keep a column's gap, and lines stay off the tile's edge.
        let need = roomUnder(space, upper.kind, lower.kind);
        if (upper.kind === "tile") {
          const floor = floorOf(upper.bottom);
          if (lower.top >= floor - EPS) need = Math.min(need, lower.top - floor);
          need = Math.max(need, lower.kind === "tile" ? space.column : TILE_GRAZE);
        }
        const slack = Math.max(0, Math.max(0, lower.top - upper.bottom) - need);
        if (slack < by - EPS) found.push([l, rankByBottom[u], b, slack]);
      }
    }
    return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , to, slack]) => ({ to, slack }));
  };
  const seed = find(SEED), fixed = find(FIXED), moves = new Map<number, number>([[seed, by]]);
  // Longest paths from the edge (every slack is nonnegative: each body is final when taken, largest first).
  const heap: [number, number][] = [[by, seed]], done = new Set<number>();
  const push = (entry: [number, number]) => {
    heap.push(entry);
    for (let i = heap.length - 1; i > 0;) { const up = (i - 1) >> 1; if (heap[up][0] >= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; }
  };
  const pop = (): [number, number] => {
    const top = heap[0], end = heap.pop()!;
    if (heap.length) {
      heap[0] = end;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [amount, body] = pop();
    if (done.has(body)) continue;
    done.add(body);
    for (const { to, slack } of pushesFrom(body)) {
      const next = amount - slack;
      if (next > (moves.get(to) ?? 0) + EPS) {
        // What stays would have to move: no shove.
        if (to === fixed) return null;
        moves.set(to, next); push([next, to]);
      }
    }
  }
  const dy = (id: number) => moves.get(find(id)) ?? 0;
  const nodes = new Map<string, PlacedNode>();
  layout.nodes.forEach((n, id) => nodes.set(id, id === tile.key ? { ...tile, height } : dy(tiles.get(id)!) ? { ...n, y: n.y + dy(tiles.get(id)!) } : n));
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, dy(dots.get(id)!) ? { ...j, y: j.y + dy(dots.get(id)!) } : j] as const));
  const routes = layout.routes.map((route, r) => {
    const { commands, points } = paths[r];
    if (!points.some(p => dy(p))) return route;
    return { ...route, path: writePath(commands.map((c, i) => { const move = dy(points[i]); return move ? { cmd: c.cmd, xy: c.xy.map((v, k) => k % 2 ? v + move : v) } : c; })) };
  });
  // Rows end under their lowest tile; the band keeps its margin under its lowest point.
  const rows: readonly RowBox[] = layout.rows.map(r => {
    const tilesOf = r.keys.flatMap(k => { const n = nodes.get(k); return n ? [n] : []; });
    const changed = r.keys.some(k => { const n = nodes.get(k), was = layout.nodes.get(k); return n && was && (n.y !== was.y || n.height !== was.height); });
    return changed && tilesOf.length ? { ...r, bottom: Math.max(...tilesOf.map(n => n.y + n.height)) } : r;
  });
  const centred = recentred(routes, tile, height);
  if (!centred) return null;
  return { ...layout, nodes, junctions, routes: centred, rows, height: layout.height + lowest(nodes, junctions, centred) - lowest(layout.nodes, layout.junctions, layout.routes) };
}

/**
 * `routes` with each arrival at `tile`'s left side on its centre line (`arrivesLevel`) moved onto
 * its centre at `height` (`followCentre`). An arrival whose run, moved with the centre, would run
 * along another source's line steps across one arrow length before the tile instead, keeping its
 * run where it was. Null when an arrival cannot follow.
 */
function recentred(routes: readonly PlacedRoute[], tile: PlacedNode, height: number): PlacedRoute[] | null {
  const oldCentre = tile.y + tile.height / 2, newCentre = tile.y + height / 2, entry = tile.x - ARROW.length;
  const out = [...routes], arrivals = new Map<number, readonly Command[]>();
  for (const [i, route] of routes.entries()) {
    if (!route.terminal || route.to.kind !== "node" || route.to.id !== tile.key) continue;
    const commands = parsePath(route.path);
    if (!commands || !arrivesLevel(commands, entry, oldCentre)) continue;
    const followed = followCentre(commands, oldCentre, newCentre);
    if (!followed) return null;
    arrivals.set(i, commands);
    out[i] = { ...route, path: writePath(followed) };
  }
  for (const [i, commands] of arrivals) {
    const own = segments(out[i].path), source = JSON.stringify(out[i].from);
    const shares = out.some(other => other !== out[i] && JSON.stringify(other.from) !== source
      && segments(other.path).some(t => own.some(s => overlapLength(s, t) > EPS)));
    if (!shares) continue;
    const stepped = followCentre(commands, oldCentre, newCentre, true);
    if (!stepped) return null;
    out[i] = { ...out[i], path: writePath(stepped) };
  }
  return out;
}

/**
 * The first line at or under a height that crosses none of `nodes` (`settle`), as a lookup: the
 * floor of the row a tile's lower edge lies in.
 */
function floors(nodes: Iterable<PlacedNode>): (y: number) => number {
  const spans = [...nodes].map(n => [n.y, n.y + n.height] as [number, number]).sort((a, b) => a[0] - b[0]);
  // Merged runs of tiles that overlap vertically (by more than EPS), as `settle` steps through them.
  const runs: [number, number][] = [];
  for (const [top, bottom] of spans) {
    const last = runs[runs.length - 1];
    if (last && top < last[1] - EPS) last[1] = Math.max(last[1], bottom);
    else runs.push([top, bottom]);
  }
  return y => {
    let lo = 0, hi = runs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (runs[mid][0] < y - EPS) lo = mid + 1; else hi = mid; }
    const run = runs[lo - 1];
    return run && run[1] > y + EPS ? run[1] : y;
  };
}

/** The lowest point of a drawing: tiles' lower edges, dots and connector points. */
function lowest(nodes: ReadonlyMap<string, PlacedNode>, dots: ReadonlyMap<string, { readonly y: number }>, routes: readonly PlacedRoute[]): number {
  let low = -Infinity;
  for (const n of nodes.values()) low = Math.max(low, n.y + n.height);
  for (const j of dots.values()) low = Math.max(low, j.y);
  for (const route of routes) { const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number"); for (let i = 1; i < numbers.length; i += 2) low = Math.max(low, numbers[i]); }
  return low;
}

/** Whether two layouts draw the same tiles, dots and connectors (to rounding). */
function sameDrawing(a: GraphLayout, b: GraphLayout): boolean {
  if (a.nodes.size !== b.nodes.size || a.routes.length !== b.routes.length) return false;
  for (const [key, n] of a.nodes) { const m = b.nodes.get(key); if (!m || Math.abs(m.x - n.x) > EPS || Math.abs(m.y - n.y) > EPS || Math.abs(m.height - n.height) > EPS) return false; }
  for (const [id, j] of a.junctions) { const k = b.junctions.get(id); if (!k || Math.abs(k.x - j.x) > EPS || Math.abs(k.y - j.y) > EPS) return false; }
  return a.routes.every((route, i) => {
    const p = pathTokens(route.path).filter((t): t is number => typeof t === "number"), q = pathTokens(b.routes[i].path).filter((t): t is number => typeof t === "number");
    return p.length === q.length && p.every((v, k) => Math.abs(v - q[k]) < 1e-6);
  });
}

/** An x interval: the part of the band below a cut that moves, when not all of it does. */
type Slab = readonly [left: number, right: number];

/** Whether a tile moves with a cut at `line`, restricted to `slab` when given: its top lies on or below the line, inside the slab. */
const movesTile = (n: PlacedNode, line: number, slab?: Slab) => n.y >= line - EPS && (!slab || (n.x >= slab[0] - EPS && n.x + n.width <= slab[1] + EPS));

/**
 * The narrowest x interval holding the tile's span such that nothing on or below `line` leaves
 * it sideways: every tile whose top lies there, junction dot, and connector piece (a line or
 * curve with both ends there, or one reaching there other than straight down) lies inside it or
 * outside it. Moving only what lies inside rigidly keeps every connector's shape, stretching the
 * vertical lines that cross the cut, as moving everything below the cut does (cut and stretch
 * restricted to a vertical slab). Null when the slab holds every tile below the line anyway.
 */
function slabFor(layout: GraphLayout, tile: PlacedNode, line: number): Slab | null {
  const spans: [number, number][] = [];
  const below = (y: number) => y >= line - EPS;
  let tilesBelow = 0;
  for (const n of layout.nodes.values()) if (n.key !== tile.key && below(n.y)) { spans.push([n.x, n.x + n.width]); tilesBelow++; }
  if (!tilesBelow) return null;
  for (const j of layout.junctions.values()) if (below(j.y)) spans.push([j.x, j.x]);
  for (const route of layout.routes) {
    const commands = parsePath(route.path);
    if (!commands) return null;
    let [px, py] = commands[0].xy;
    for (let i = 1; i < commands.length; i++) {
      const xy = commands[i].xy;
      for (let k = 0; k < xy.length; k += 2) {
        const x = xy[k], y = xy[k + 1];
        if (below(y) || below(py)) spans.push(Math.abs(x - px) < EPS ? [x, x] : [Math.min(x, px), Math.max(x, px)]);
        px = x; py = y;
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  // Merge overlapping or touching spans; keep the block that holds the tile's span.
  let left = tile.x, right = tile.x + tile.width;
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of spans) {
      if (a > right + EPS || b < left - EPS || (a >= left - EPS && b <= right + EPS)) continue;
      left = Math.min(left, a); right = Math.max(right, b); changed = true;
    }
  }
  let inside = 0;
  for (const n of layout.nodes.values()) if (n.key !== tile.key && movesTile(n, line, [left, right])) inside++;
  return inside < tilesBelow ? [left, right] : null;
}

/**
 * `layout` with `tile` replaced by `resized` and everything on or below the line `cut` moved down
 * by `delta` (up when negative): tiles whose top is on or below it, junctions, and connector points.
 * Null when a connector's path cannot be read, or an arrival at the tile cannot follow its centre.
 */
function moved(layout: GraphLayout, tile: PlacedNode, resized: PlacedNode, cut: number, delta: number, slab?: Slab): GraphLayout | null {
  const moves = (x: number, y: number) => y >= cut - EPS && (!slab || (x >= slab[0] - EPS && x <= slab[1] + EPS));
  const nodes = new Map<string, PlacedNode>();
  layout.nodes.forEach((n, id) => nodes.set(id, id === tile.key ? resized : delta && movesTile(n, cut, slab) ? { ...n, y: n.y + delta } : n));
  const junctions = new Map([...layout.junctions].map(([id, j]) => [id, delta && moves(j.x, j.y) ? { ...j, y: j.y + delta } : j] as const));
  /** Whether (x, y) lies on the lower edge of a tile that stays where it is. */
  const onStayingBottom = (x: number, y: number) => {
    for (const n of layout.nodes.values()) if (n.key !== tile.key && n.y < cut - EPS && Math.abs(n.y + n.height - y) < EPS && x >= n.x - EPS && x <= n.x + n.width + EPS) return true;
    return false;
  };
  const shifted: PlacedRoute[] = [];
  for (const route of layout.routes) {
    // Geometry it cannot read, it does not edit.
    const commands = parsePath(route.path);
    if (!commands) return null;
    const path = delta ? shiftedPath(commands, moves, delta, onStayingBottom) : commands;
    shifted.push(sameCommands(path, commands) ? route : { ...route, path: writePath(path) });
  }
  const routes = recentred(shifted, tile, resized.height);
  if (!routes) return null;
  const lowest = (tiles: ReadonlyMap<string, PlacedNode>) => Math.max(...[...tiles.values()].map(n => n.y + n.height));
  if (slab) {
    // Within a slab, a row keeps the span of its tiles, wherever each went; the band grows only
    // by what the slab adds below its lowest point.
    const rows: readonly RowBox[] = layout.orientation !== "down" ? layout.rows : layout.rows.map(r => {
      const tiles = r.keys.flatMap(k => { const n = nodes.get(k), was = layout.nodes.get(k); return n && was && (n.y !== was.y || n.height !== was.height) ? [n] : []; });
      return tiles.length ? { ...r, top: Math.min(r.top, ...tiles.map(n => n.y)), bottom: Math.max(r.bottom, ...tiles.map(n => n.y + n.height)) } : r;
    });
    const extent = (tiles: ReadonlyMap<string, PlacedNode>, list: readonly PlacedRoute[], dots: ReadonlyMap<string, { readonly y: number }>) => {
      let bottom = lowest(tiles);
      for (const j of dots.values()) bottom = Math.max(bottom, j.y);
      for (const route of list) { const numbers = pathTokens(route.path).filter((t): t is number => typeof t === "number"); for (let i = 1; i < numbers.length; i += 2) bottom = Math.max(bottom, numbers[i]); }
      return bottom;
    };
    const bandBounds = layout.bandBounds && delta && moves((slab[0] + slab[1]) / 2, layout.bandBounds.top) ? { bandBounds: { ...layout.bandBounds, top: layout.bandBounds.top + delta } } : {};
    return { ...layout, ...bandBounds, nodes, junctions, routes, rows, height: layout.height + Math.max(0, extent(nodes, routes, junctions) - extent(layout.nodes, layout.routes, layout.junctions)) };
  }
  // Running down, a row the cut passes through (the tile's, or one whose tiles stay) ends under
  // its lowest tile. Running right, rows bound columns along x, which a vertical move keeps.
  const rows: readonly RowBox[] = layout.orientation !== "down" ? layout.rows : layout.rows.map(r => r.keys.includes(tile.key) || (delta && !(r.top >= cut - EPS) && r.bottom >= cut - EPS)
    ? { ...r, bottom: Math.max(...r.keys.map(k => { const n = nodes.get(k); return n ? n.y + n.height : -Infinity; }), r.top) }
    : delta && r.top >= cut - EPS ? { ...r, top: r.top + delta, bottom: r.bottom + delta } : r);
  // The first child row (the band's top) moves with everything below the cut when the cut lies above it: the cover resized.
  const bandBounds = layout.bandBounds && delta && layout.bandBounds.top >= cut - EPS ? { bandBounds: { ...layout.bandBounds, top: layout.bandBounds.top + delta } } : {};
  // The band keeps its margin under its lowest tile.
  return { ...layout, ...bandBounds, nodes, junctions, routes, rows, height: layout.height + delta + Math.max(0, lowest(nodes) - lowest(layout.nodes) - delta) };
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
function shiftedPath(commands: readonly Command[], moves: (x: number, y: number) => boolean, delta: number, onStayingBottom: (x: number, y: number) => boolean): Command[] {
  const [sx, sy] = commands[0].xy;
  let px = sx, py = sy, moved = moves(sx, sy) && !onStayingBottom(sx, sy);
  const out: Command[] = [{ cmd: "M", xy: [sx, moved ? sy + delta : sy] }];
  for (let i = 1; i < commands.length; i++) {
    const c = commands[i], [ex, ey] = endOf(c), ends = moves(ex, ey);
    const vertical = c.cmd === "L" && Math.abs(c.xy[0] - px) < EPS, leavesDown = c.cmd !== "C" || Math.abs(c.xy[0] - px) < EPS;
    if (delta > 0 && !moved && ends && !vertical && leavesDown) {
      out.push({ cmd: "L", xy: [px, py + delta] }, { cmd: c.cmd, xy: c.xy.map((v, k) => k % 2 ? v + delta : v) });
    } else {
      const next: Command = { cmd: c.cmd, xy: c.xy.map((v, k) => k % 2 && moves(c.xy[k - 1], v) ? v + delta : v) };
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
