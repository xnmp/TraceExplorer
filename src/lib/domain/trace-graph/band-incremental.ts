import { layoutStage, countLayoutWork } from './layout-profile';
import { layoutSignature, geometrySignature } from './layout-signature';
import { createBoundedCache, estimateLayoutBytes } from './folder-layout/bounded-cache';
import { filterRouteConsumers } from "./route-consumers";
import { orderNewSiblingLeaves } from "./new-sibling-order";
/**
 * Incremental tree embedding: retained rectangles and routes are fixed obstacles.
 *
 * New connectors are lane-free: no new route runs along a connector of another source (a
 * route's source is its `from` endpoint) for any length, nor closer than `LANE_SEPARATION`
 * beside one for more than an arrowhead's length, nor alongside its curves at a shallow angle
 * (`SHALLOW_RUN`); it may cross one, and it may share its own source's earlier trunk. No new
 * route passes within `JUNCTION_BERTH` of a junction dot, and no new dot lies that close to a
 * connector: a line through a dot reads as joining it, and a trunk branching at a merge's dot
 * would make its other branches read as that merge's outputs. Nor does a new route touch another
 * source's line at a point (`route-contacts`): it keeps `PORT_BERTH`
 * from other sources' ports and `CORNER_BERTH` from their corners and forks, and its own ports
 * and corners keep the same from their lines. A tile with several parents gets a junction its inputs reach
 * from distinct directions (above, the left and the right along the junction's row) while its
 * tail leaves downward; more parents nest further junctions on a spine above it. Where no
 * lane-free placement exists the candidate is withheld (null) rather than drawn with a shared lane.
 */
import { nearestFree, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedNode, type PlacedRoute, type PlacedJunction } from "./layout";
import { ARROW, JUNCTION_BERTH, LANE_SEPARATION, PORT_BERTH, spacingFor, STACK_STEM_ROOM } from "./metrics";
import { axisOf, berthsOf, paintedSegments, distanceToTile, distanceToSegment, entersBerth, grazesTile, INTO_JUNCTION, INTO_TILE, leavingRunFrom, routeEnds, shallowRun, SHALLOW_RUN, TILE_GRAZE, type Berth, type Ends } from "./route-contacts";
import { bandExtent } from "./band-geometry";
import { intersectsTile, overlapLength, routeBounds, segments, type Segment } from "./layout-quality";
import { orthogonalRoute, LANE_TOLERANCE, NEAR_LANE, type AxisRun, type ForeignLanes, type GridSearch } from "./orthogonal-route";
import { forEachPathNumber } from "./path-data";
import { pathCommands, type Point } from "./path-sampling";

/** Distance between neighbouring parallel lanes a route family may take. */
const LANE_STEP = 3;
/** The straight final run of a junction input. */
const JOIN_APPROACH = 4;
/**
 * Gap above a tile with a junction: the junction sits two arrow lengths above the tile, with
 * room above it for a travel row (6 px below the tiles above) and its approach.
 */
const JOIN_ARRIVAL_GAP = 2 * ARROW.length + JOIN_APPROACH + 6 + LANE_STEP;
/** Vertical distance between nested junctions on a spine. */
const LEVEL_GAP = 6;
/** Parallel lanes (gutters, travel rows, side columns) tried per route family. */
const LANE_CHOICES = 4;
/** Travel rows, in lane steps from the default 6 px below the tiles above a target. */
const TRAVEL_ROWS = [0, -1, 1] as const;
/** Cover-header rows (below the cover) tried by header routes, nearest first. */
const HEADER_ROWS = [6, 9, 3, 15] as const;
/** Junction rows tried above a multi-parent tile, relative to the default (two arrow lengths above it). */
const JOIN_SHIFTS = [0] as const;
/** Clear fallback slots routed with the grid router before the candidate is withheld. */
const FALLBACK_SLOTS = 3;
/** Rows of placed tiles (nearest below the parent first) probed for holes a new tile fits in. */
const HOLE_ROWS = 8;
/** Free holes per new tile whose wiring may fail before the remaining holes are passed over. */
const HOLE_TRIES = 2;
/**
 * Probes adding no more height than the first one routed only by a detour that are still wired,
 * looking for one with a direct route.
 */
const DETOUR_SCAN = 8;
/**
 * How far a route keeps off its source's side where it runs down the gap beside it: clear of the
 * border (`TILE_GRAZE`), so the line reads as leaving the tile, not as part of its outline.
 */
const SIDE_LANE = 4;
/** Grid points a fallback route search may expand before it gives up (a bounded failure). */
const GRID_BUDGET = 5000;
/** A grid route may discover this many missing port/corner obstacles before giving up. */
const BERTH_RETRIES = 16;
/** Most 64 px rows one segment may span in the lane index (about 4 million px): beyond it the history is not usable. */
const MAX_INDEX_ROWS = 65_536;
/** Whether a coordinate or size lies within the lane index's reach: finite, at most `MAX_INDEX_ROWS` rows from zero. */
export const inReach = (value: number) => Number.isFinite(value) && Math.abs(value) <= MAX_INDEX_ROWS * 64;

/** Prefixes share immutable complete membership; the weak key releases its source index with it. */
const futureSourceIndexes = new WeakMap<readonly LayoutItem[], ReadonlySet<string>>();
function futureSourcesOf(items: readonly LayoutItem[]): ReadonlySet<string> {
  const known = futureSourceIndexes.get(items);
  if (known) return known;
  const sources = new Set<string>();
  for (const item of items) for (const parent of item.parents) sources.add(parent);
  futureSourceIndexes.set(items, sources);
  return sources;
}

/** Parsed endpoints and control points must fit the same bounded geometry as retained tiles. */
export function usableRetainedRoute(route: PlacedRoute): boolean {
  if (typeof route.path !== "string") return false;
  const bounds = routeBounds(route);
  if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(inReach)) return false;
  let usable = true;
  forEachPathNumber(route.path, value => { if (!inReach(value)) usable = false; });
  return usable;
}
/** Both ends must advance under ++; bounding only the span misses short runs at huge coordinates. */
const indexRange = (first: number, last: number) => Number.isSafeInteger(first) && Number.isSafeInteger(last) && last >= first && last - first <= MAX_INDEX_ROWS;

/**
 * Grid work one layout request may spend on its second chance (~45 ms of grid search; the
 * finer probes come on top). It buys most of the remaining placements: more work finds a few
 * more, at a steep cost in time.
 */
const SECOND_CHANCE_WORK = 200_000;
/** Probe placements a layout request may try to wire (see `IncrementalBudget`). */
const PROBE_WORK = 2000;
/** Grid work the plain fallback may spend per layout request (see `IncrementalBudget`). */
const FALLBACK_WORK = 200_000;

/**
 * Work a layout request may still spend on incremental embeddings: grid work (points
 * expanded, plus built points / 8) for the plain fallback and for the second chance, and
 * probe placements to wire. Each attempted embedding receives one budget, so its worst
 * case is bounded however many tiles,
 * parents, ports and slots it tries; once a pool is spent, its searches stop and the
 * embedding gives way to the full layout.
 */
export interface IncrementalBudget { fallback: number; second: number; probes: number }
export const incrementalBudget = (): IncrementalBudget => ({ fallback: FALLBACK_WORK, second: SECOND_CHANCE_WORK, probes: PROBE_WORK });

/** How hard the fallback tries: clear slots, grid points per search, the grid it routes on, and the pool it spends. */
interface Effort {
  readonly slots: number;
  readonly budget: number;
  readonly everyLane: boolean;
  readonly pool: IncrementalBudget;
  readonly spends: keyof IncrementalBudget;
  /** The parent that last had no route (wired first next time, so a hopeless slot fails fast). */
  hardest?: string;
}
const left = (effort: Effort) => effort.pool[effort.spends];
const spend = (effort: Effort, spent: { readonly pops: number; readonly cells: number }) => { effort.pool[effort.spends] -= spent.pops + spent.cells / 8; };
const fallbackEffort = (pool: IncrementalBudget): Effort => ({ slots: FALLBACK_SLOTS, budget: GRID_BUDGET, everyLane: false, pool, spends: "fallback" });
/**
 * The second chance, taken only when a tile has no placement otherwise (so layouts found
 * without it are unchanged): more slots, longer searches, and columns beside every lane.
 */
const secondChance = (pool: IncrementalBudget): Effort => ({ slots: 16, budget: 50_000, everyLane: true, pool, spends: "second" });

/** The M/L path through `points`, written once per run of repeated points. */
const path = (points: readonly Point[]) => {
  let out = "";
  for (let i = 0, written = 0; i < points.length; i++) {
    const p = points[i];
    if (i && p.x === points[i - 1].x && p.y === points[i - 1].y) continue;
    out += written++ ? ` L${p.x} ${p.y}` : `M${p.x} ${p.y}`;
  }
  return out;
};
const point = (x: number, y: number): Point => ({ x, y });
/** `overlap(a, b, gap)` = `overlapX(a, b, gap) && overlapY(a, b, gap)`; the halves let one row's vertical test be shared. */
const overlapX = (a: PlacedNode, b: PlacedNode, gap: number) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap;
const overlapY = (a: { y: number; height: number }, b: PlacedNode, gap: number) => a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/**
 * `segments` of the M/L path `path` writes through `points` (dropping consecutive repeats),
 * without printing and re-parsing it. `String(number)` round-trips every finite number (−0
 * prints as 0); any non-finite coordinate prints as a word, which the parser rejects, leaving
 * no segments.
 */
function pathSegments(points: readonly Point[]): Segment[] {
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return [];
  const out: Segment[] = [];
  let previous: Point | undefined;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i && p.x === points[i - 1].x && p.y === points[i - 1].y) continue;
    // A zero coordinate is read back as +0; other points are shared (no one mutates them).
    const read = p.x === 0 || p.y === 0 ? point(p.x === 0 ? 0 : p.x, p.y === 0 ? 0 : p.y) : p;
    if (previous) out.push([previous, read]);
    previous = read;
  }
  return out;
}

/** The length of the path through `points`: zero if any coordinate is not finite. */
function writtenLength(points: readonly Point[]): number {
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
  return sum;
}

/**
 * Placed tiles sorted by top edge, so a route segment is tested (exactly, by `intersectsTile`)
 * only against tiles whose bounds it can reach: the tiles starting above its lowest point and
 * reaching below its highest, that it spans in x. Tiles with a non-finite edge, and segments
 * with a non-finite coordinate, are tested exhaustively.
 */
class TileIndex {
  private readonly tops: number[] = [];
  private readonly sorted: PlacedNode[] = [];
  private readonly loose: PlacedNode[] = [];
  private tallest = 0;
  constructor(readonly tiles: PlacedNode[]) { for (const t of tiles) this.file(t); }
  add(tile: PlacedNode): void { this.tiles.push(tile); this.file(tile); }
  private file(t: PlacedNode): void {
    if (![t.x, t.y, t.width, t.height].every(Number.isFinite)) { this.loose.push(t); return; }
    let at = this.tops.length;
    while (at && this.tops[at - 1] > t.y) at--;
    this.tops.splice(at, 0, t.y); this.sorted.splice(at, 0, t);
    this.tallest = Math.max(this.tallest, t.height);
  }
  /** Whether any segment passes through a tile here or `extra` (the exact test of `intersectsTile`). */
  crosses(ss: readonly Segment[], extra?: PlacedNode): boolean {
    for (const segment of ss) {
      if (extra && intersectsTile(segment, extra)) return true;
      const a = segment[0], b = segment[1];
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      if (!Number.isFinite(minX + maxX + minY + maxY)) { for (const t of this.tiles) if (intersectsTile(segment, t)) return true; continue; }
      for (const t of this.loose) if (intersectsTile(segment, t)) return true;
      // A segment can only cross a tile whose bounds it overlaps (the inset rectangle lies within them).
      const tops = this.tops, sorted = this.sorted;
      let lo = 0, hi = tops.length;
      const from = minY - this.tallest;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (tops[mid] <= from) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < tops.length && tops[i] < maxY; i++) {
        const t = sorted[i];
        if (t.y + t.height > minY && t.x < maxX && t.x + t.width > minX && intersectsTile(segment, t)) return true;
      }
    }
    return false;
  }
  /**
   * Whether a route through `ss` from `source`'s port comes within `TILE_GRAZE` of a tile here or
   * `extra`, other than along the run it leaves `source` by (`grazesTile`).
   */
  grazes(ss: readonly Segment[], source: PlacedNode, extra?: PlacedNode): boolean {
    if (!ss.length) return false;
    const lead = leavingRunFrom(ss, source);
    const near = (t: PlacedNode, segment: Segment, leaving: boolean) => !(leaving && t.key === source.key) && grazesTile([segment], t);
    for (let i = 0; i < ss.length; i++) {
      const segment = ss[i], a = segment[0], b = segment[1], first = i < lead;
      if (extra && near(extra, segment, first)) return true;
      const minX = Math.min(a.x, b.x) - TILE_GRAZE, maxX = Math.max(a.x, b.x) + TILE_GRAZE, minY = Math.min(a.y, b.y) - TILE_GRAZE, maxY = Math.max(a.y, b.y) + TILE_GRAZE;
      if (!Number.isFinite(minX + maxX + minY + maxY)) continue;
      for (const t of this.loose) if (near(t, segment, first)) return true;
      const tops = this.tops, sorted = this.sorted;
      let lo = 0, hi = tops.length;
      const from = minY - this.tallest;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (tops[mid] <= from) lo = mid + 1; else hi = mid; }
      for (let k = lo; k < tops.length && tops[k] < maxY; k++) {
        const t = sorted[k];
        if (t.y + t.height > minY && t.x < maxX && t.x + t.width > minX && near(t, segment, first)) return true;
      }
    }
    return false;
  }
}

/** A run of `source`; a speck is a near-zero-length piece, held as the point it sits at. */
interface Run extends AxisRun { readonly source: string; readonly segment: Segment; readonly speck?: true }
/**
 * Pieces shorter than this are specks: flattened zero-radius corners, whose direction is float
 * noise (and changes when attachment redraws the route). The metric counts such a piece lying
 * on a route's line as shared lane, so a route must not pass through one of another source.
 */
const SPECK = 1e-3;
/** Parallel runs of two sources closer than `LANE_SEPARATION` over more than this share a lane (`sharedLanePx`). */
const NEAR_RUN = ARROW.length;
const sourceKey = (kind: string, id: string) => `${kind}\u0000${id}`;
/** A junction's spine as wired: from its top dot down to the arrowhead above its tile. */
const SPINE: Ends = Object.freeze({ start: 0, end: PORT_BERTH, arrow: true });
/** A spine piece from one dot to the next. */
const DOT_TO_DOT: Ends = Object.freeze({ start: 0, end: 0 });
/** A route's ends without berths: its corners alone keep other sources off. */
const NO_ENDS: Ends = DOT_TO_DOT;

/** Side of a `Cells` cell, px. */
const CELL = 64;
/** Cells a segment may span before `Cells` files it by row instead (long runs). */
const WIDE = 16;

/**
 * Segment indices by 64 px square cell, for the contact checks' small box queries; a segment
 * spanning more than `WIDE` cells (a long run) is filed by row instead. Every list a filing
 * pushes onto goes to `log`, as `LaneIndex` withdraws additions.
 */
class Cells {
  private readonly cells = new Map<number, number[]>();
  private readonly wide: number[][] = [];
  file(index: number, minX: number, minY: number, maxX: number, maxY: number, log: unknown[][]): void {
    const r0 = Math.floor(minY / CELL), r1 = Math.floor(maxY / CELL), c0 = Math.floor(minX / CELL), c1 = Math.floor(maxX / CELL);
    if (!indexRange(r0, r1) || !indexRange(c0, c1)) return;
    if ((r1 - r0 + 1) * (c1 - c0 + 1) <= WIDE) {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const key = r * 2 ** 20 + c, list = this.cells.get(key);
        if (list) { list.push(index); log.push(list); } else { const fresh = [index]; this.cells.set(key, fresh); log.push(fresh); }
      }
    } else for (let r = r0; r <= r1; r++) log.push(push(this.wide, r, index));
  }
  /** Calls `visit` with each segment filed in a cell the box meets (a segment may come more than once); stops when it returns true. */
  some(minX: number, minY: number, maxX: number, maxY: number, visit: (index: number) => boolean): boolean {
    const r0 = Math.floor(minY / CELL), r1 = Math.floor(maxY / CELL), c0 = Math.floor(minX / CELL), c1 = Math.floor(maxX / CELL);
    if (!indexRange(r0, r1) || !indexRange(c0, c1)) return true;
    for (let r = r0; r <= r1; r++) {
      const wide = this.wide[r];
      if (wide) for (const index of wide) if (visit(index)) return true;
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(r * 2 ** 20 + c);
        if (list) for (const index of list) if (visit(index)) return true;
      }
    }
    return false;
  }
}

/**
 * Placed connector segments with their sources. Answers which tiles they cross (bucketed by
 * 64 px rows, so a probe tests only segments near it) and whether a new route would run along
 * another source's lane: axis-parallel runs are bucketed by their rounded coordinate. Oblique
 * segments (flattened curve corners) only block tiles: an axis-parallel route can share no
 * length with them under the metric's collinearity tolerance. Specks are filed both ways, and
 * block any run passing through them.
 *
 * A `base` (never modified once built) holds segments shared by many searches. Additions made
 * after a `mark` are withdrawn by `rollback` to it, so trial routes need no copies.
 */
class LaneIndex {
  constructor(private readonly base?: LaneIndex, private readonly deferContacts = false) {}
  private readonly all: Segment[] = [];
  /** The source of each segment in `all`. */
  private readonly sources: string[] = [];
  /** Junction dots, each with its `JUNCTION_BERTH`, by 64 px row of their point. */
  private readonly dots: Berth[][] = [];
  /** Ports, corners and forks other sources keep off (`route-contacts`), by 64 px row of their point. */
  private readonly berths: (Berth & { readonly source: string })[][] = [];
  /** Alternative unpainted departures: preserve at least one, not both. */
  private readonly departures = new Map<string, readonly Berth[]>();
  /** Segment indices by 64 px row (an index property for a negative row; NaN rows are never visited). */
  private readonly rows: number[][] = [];
  /** Every segment by cell, and the slanted ones (flattened curves: neither horizontal nor vertical) apart. */
  private readonly cells = new Cells();
  private readonly slanted = new Cells();
  /** Per segment, the last query that visited it (a segment filed in several cells counts once). */
  private readonly visited: number[] = [];
  private query = 0;
  private readonly horizontal = new Map<number, Run[]>();
  private readonly vertical = new Map<number, Run[]>();
  /** Every list an addition pushed onto, in order. */
  private readonly log: unknown[][] = [];
  /** A segment spanned more rows than the index allows (absurd coordinates): its rows were not filed. */
  private oversized = false;
  /** Whether this index, or its base, met geometry too large to index; its answers are then incomplete. */
  tooLarge(): boolean { return this.oversized || !!this.base?.tooLarge(); }

  /** Adds a route's segments (consecutive, as drawn) from `source`, and its berths: its corners, and its ends as `ends` says. */
  add(list: readonly Segment[], source: string, ends: Ends = NO_ENDS): void {
    if (list.some(([a, b]) => ![a.x, a.y, b.x, b.y].every(inReach))) { this.oversized = true; return; }
    for (const berth of berthsOf(list, ends)) {
      const row = Math.floor(berth.y / 64);
      if (Number.isFinite(row) && Number.isFinite(berth.x)) this.log.push(push(this.berths, row, { ...berth, source }));
    }
    for (const segment of paintedSegments(list, ends)) {
      const index = this.all.push(segment) - 1;
      this.sources.push(source);
      this.log.push(this.all, this.sources);
      const [a, b] = segment;
      const top = Math.floor(Math.min(a.y, b.y) / 64), bottom = Math.floor(Math.max(a.y, b.y) / 64);
      if (!indexRange(top, bottom)) { this.oversized = true; continue; }
      for (let row = top; row <= bottom; row++) this.log.push(push(this.rows, row, index));
      this.visited.push(0);
      this.log.push(this.visited);
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      this.cells.file(index, minX, minY, maxX, maxY, this.log);
      if (!axisOf(segment)) this.slanted.file(index, minX, minY, maxX, maxY, this.log);
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (!(dx + dy > 0) || !Number.isFinite(dx + dy)) continue;
      if (dx + dy < SPECK) {
        this.log.push(file(this.horizontal, { at: a.y, lo: a.x, hi: a.x, source, segment, speck: true }), file(this.vertical, { at: a.x, lo: a.y, hi: a.y, source, segment, speck: true }));
        continue;
      }
      if (dy <= LANE_TOLERANCE / 8 && dy < dx) this.log.push(file(this.horizontal, { at: (a.y + b.y) / 2, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), source, segment }));
      else if (dx <= LANE_TOLERANCE / 8 && dx < dy) this.log.push(file(this.vertical, { at: (a.x + b.x) / 2, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), source, segment }));
    }
  }
  /** A future source needs one clear departure; either candidate port may serve it. */
  reserveDeparture(node: PlacedNode): void {
    this.departures.set(sourceKey('node', node.key), [
      { x: node.x + node.width / 2, y: node.y + node.height, radius: PORT_BERTH },
      { x: node.x + node.width, y: node.y + node.height / 2, radius: PORT_BERTH },
    ]);
  }
  private blockingDeparture(ink: readonly Segment[], source: string): Berth | undefined {
    for (const [owner, ports] of this.departures) {
      if (owner === source) continue;
      const clear = ports.filter(port => !this.touched(port, owner));
      if (clear.length && clear.every(port => ink.some(segment => entersBerth(segment, port)))) return clear[0];
    }
    return undefined;
  }
  /** Adds a junction dot: later routes keep `JUNCTION_BERTH` from it. */
  addDot(dot: Point): void {
    if (!inReach(dot.x) || !inReach(dot.y)) { this.oversized = true; return; }
    const row = Math.floor(dot.y / 64);
    if (Number.isFinite(row) && Number.isFinite(dot.x)) this.log.push(push(this.dots, row, { x: dot.x, y: dot.y, radius: JUNCTION_BERTH }));
  }

  /** Whether a segment passes within `JUNCTION_BERTH` of `dot`. */
  nearSegment(dot: Point): boolean {
    if (this.base?.nearSegment(dot)) return true;
    const berth = { x: dot.x, y: dot.y, radius: JUNCTION_BERTH };
    const top = Math.floor((dot.y - JUNCTION_BERTH) / 64), bottom = Math.floor((dot.y + JUNCTION_BERTH) / 64);
    if (!indexRange(top, bottom)) return true;
    for (let row = top; row <= bottom; row++) {
      const bucket = this.rows[row];
      if (bucket) for (const index of bucket) if (entersBerth(this.all[index], berth)) return true;
    }
    return false;
  }

  /** Whether any of `list` passes within `JUNCTION_BERTH` of a dot. */
  private nearDot(list: readonly Segment[]): boolean {
    return list.some(([a, b]) => !indexRange(Math.floor((Math.min(a.y, b.y) - JUNCTION_BERTH) / 64), Math.floor((Math.max(a.y, b.y) + JUNCTION_BERTH) / 64)))
      || this.dotNear(list) !== undefined;
  }

  private dotNear(list: readonly Segment[]): Berth | undefined {
    const retained = this.base?.dotNear(list);
    if (retained) return retained;
    for (const segment of list) {
      const [a, b] = segment, top = Math.floor((Math.min(a.y, b.y) - JUNCTION_BERTH) / 64), bottom = Math.floor((Math.max(a.y, b.y) + JUNCTION_BERTH) / 64);
      if (!indexRange(top, bottom)) return undefined;
      const left = Math.min(a.x, b.x) - JUNCTION_BERTH, right = Math.max(a.x, b.x) + JUNCTION_BERTH;
      for (let row = top; row <= bottom; row++) {
        const dots = this.dots[row];
        if (dots) for (const dot of dots) if (dot.x > left && dot.x < right && entersBerth(segment, dot)) return dot;
      }
    }
    return undefined;
  }

  /**
   * The parts of `segment` that `source` has not drawn yet: an axis-parallel segment less its
   * source's runs on the same line (a route following its source's trunk adds no ink there).
   * Any other segment is new throughout.
   */
  private newInk(segment: Segment, source: string): Segment[] {
    const axis = axisOf(segment);
    if (!axis) return [segment];
    const [a, b] = segment, horizontal = axis === 1, at = horizontal ? a.y : a.x;
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const drawn: [number, number][] = [];
    this.ownRuns(horizontal, at, source, drawn);
    if (!drawn.length) return [segment];
    drawn.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const piece = (from: number, to: number): Segment => horizontal ? [point(from, at), point(to, at)] : [point(at, from), point(at, to)];
    const out: Segment[] = [];
    let from = lo;
    for (const [l, h] of drawn) {
      if (l > from) out.push(piece(from, Math.min(l, hi)));
      if (h > from) from = h;
      if (!(from < hi)) break;
    }
    if (from < hi) out.push(piece(from, hi));
    return out.filter(([p, q]) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y) >= SPECK);
  }

  /** Adds to `into` the spans of `source`'s runs on the line at `at` (within `LANE_TOLERANCE`). */
  private ownRuns(horizontal: boolean, at: number, source: string, into: [number, number][]): void {
    this.base?.ownRuns(horizontal, at, source, into);
    if (!inReach(at)) return;
    const map = horizontal ? this.horizontal : this.vertical;
    for (let k = Math.round(at - LANE_TOLERANCE); k <= Math.round(at + LANE_TOLERANCE); k++) {
      const runs = map.get(k);
      if (runs) for (const run of runs) if (run.source === source && !run.speck && Math.abs(run.at - at) < LANE_TOLERANCE) into.push([run.lo, run.hi]);
    }
  }

  /** A point `rollback` returns to. */
  mark(): number { return this.log.length; }
  /** Withdraws every addition made since `mark`. */
  rollback(mark: number): void { while (this.log.length > mark) this.log.pop()!.pop(); }

  /** Whether any segment passes through the tile (the exact test of `intersectsTile`). */
  hits(tile: PlacedNode): boolean {
    if (this.base?.hits(tile)) return true;
    const top = Math.floor(tile.y / 64), bottom = Math.floor((tile.y + tile.height) / 64);
    if (!indexRange(top, bottom)) return true;
    for (let row = top; row <= bottom; row++) {
      const bucket = this.rows[row];
      if (bucket) for (const index of bucket) if (intersectsTile(this.all[index], tile)) return true;
    }
    return false;
  }

  /**
   * Whether any segment comes within `TILE_GRAZE` of the tile: through it, along its border or
   * beside it (`distanceToTile`). A tile placed there would have another tile's line on its
   * outline, which reads as its own input or output; a route keeps the same clearance from tiles
   * placed before it (`TileIndex.grazes`).
   */
  grazed(tile: PlacedNode): boolean {
    if (this.base?.grazed(tile)) return true;
    const left = tile.x - TILE_GRAZE, right = tile.x + tile.width + TILE_GRAZE, top = tile.y - TILE_GRAZE, bottom = tile.y + tile.height + TILE_GRAZE;
    const query = ++this.query;
    return this.cells.some(left, top, right, bottom, index => {
      if (this.visited[index] === query) return false;
      this.visited[index] = query;
      const segment = this.all[index], [a, b] = segment;
      if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) return false;
      return distanceToTile(segment, tile) < TILE_GRAZE - 1e-9;
    });
  }

  /**
   * Whether any of `list` (axis-parallel, consecutive) runs along a segment of a source other than
   * `source`, or alongside a curve of it at a shallow angle (the two read as one line, as near
   * lanes do), passes within `JUNCTION_BERTH` of a dot (new routes end at no dot already placed),
   * or touches another source's line (`route-contacts`): passes within
   * the berth of its ports, corners or forks, or has a corner or (as `ends` says) an end within
   * its own berth of that line. Only the route's new ink counts for curves, dots and touches:
   * where it follows its source's earlier lines, the drawing does not change.
   */
  conflicts(list: readonly Segment[], source: string, ends: Ends = NO_ENDS): boolean {
    // Any order gives the same answer; a route's final approach is the likeliest to be taken.
    const painted = paintedSegments(list, ends);
    for (let i = painted.length - 1, n = 0; n < painted.length; n++, i = n - 1) if (this.runsAlong(painted[i], source)) return true;
    const ink = painted.flatMap(segment => this.newInk(segment, source));
    if (!ink.length) return false;
    if (this.nearDot(ink)) return true;
    for (const segment of ink) if (axisOf(segment) && this.shallowInto(segment, source, new Map())) return true;
    if (!this.deferContacts) {
      for (const segment of ink) if (this.nearBerth(segment, source)) return true;
      for (const berth of berthsOf(list, ends)) if (ink.some(segment => entersBerth(segment, berth)) && this.touched(berth, source)) return true;
    }
    return !!this.blockingDeparture(ink, source);
  }

  /** A forbidden meeting the visibility grid must route around, excluding shared source ink. */
  blockingBerth(list: readonly Segment[], source: string): Berth | undefined {
    const ink = list.flatMap(segment => this.newInk(segment, source));
    const dot = this.dotNear(ink);
    if (dot) return dot;
    for (const segment of ink) {
      const berth = this.berthNear(segment, source);
      if (berth) return berth;
    }
    // A legal crossing may become an accidental join when the new path turns
    // beside it. Give the visibility search that witness too, so it can move
    // the corner instead of repeatedly returning the same shortest path.
    for (const berth of berthsOf(list, NO_ENDS)) {
      if (ink.some(segment => entersBerth(segment, berth)) && this.touched(berth, source)) return berth;
    }
    return this.blockingDeparture(ink, source);
  }

  /** Whether the segment passes within the berth of a port, corner or fork of a source other than `source`. */
  private nearBerth(segment: Segment, source: string): boolean {
    const [a, b] = segment;
    return !indexRange(Math.floor((Math.min(a.y, b.y) - PORT_BERTH) / 64), Math.floor((Math.max(a.y, b.y) + PORT_BERTH) / 64))
      || this.berthNear(segment, source) !== undefined;
  }

  private berthNear(segment: Segment, source: string): Berth | undefined {
    const retained = this.base?.berthNear(segment, source);
    if (retained) return retained;
    const [a, b] = segment, top = Math.floor((Math.min(a.y, b.y) - PORT_BERTH) / 64), bottom = Math.floor((Math.max(a.y, b.y) + PORT_BERTH) / 64);
    if (!indexRange(top, bottom)) return undefined;
    const left = Math.min(a.x, b.x) - PORT_BERTH, right = Math.max(a.x, b.x) + PORT_BERTH;
    for (let row = top; row <= bottom; row++) {
      const list = this.berths[row];
      if (list) for (const berth of list) if (berth.source !== source && berth.x > left && berth.x < right && entersBerth(segment, berth)) return berth;
    }
    return undefined;
  }

  /** Whether a segment of a source other than `source` passes within the berth's radius of its point. */
  private touched(berth: Berth, source: string): boolean {
    if (this.base?.touched(berth, source)) return true;
    const r = berth.radius, query = ++this.query;
    return this.cells.some(berth.x - r, berth.y - r, berth.x + r, berth.y + r, index => {
      if (this.visited[index] === query) return false;
      this.visited[index] = query;
      return this.sources[index] !== source && entersBerth(this.all[index], berth);
    });
  }

  /**
   * Adds to `near` (per source) how far axis-parallel `segment` runs within `LANE_SEPARATION` of
   * other sources' slanted pieces; whether any source's total exceeds `SHALLOW_RUN`.
   */
  private shallowInto(segment: Segment, source: string, near: Map<string, number>): boolean {
    if (this.base?.shallowInto(segment, source, near)) return true;
    // A piece within 45° of the segment's axis comes within LANE_SEPARATION of its line only
    // inside this reach of it (LANE_SEPARATION / cos 45°).
    const reach = LANE_SEPARATION * Math.SQRT2, [a, b] = segment;
    const minX = Math.min(a.x, b.x) - reach, maxX = Math.max(a.x, b.x) + reach, minY = Math.min(a.y, b.y) - reach, maxY = Math.max(a.y, b.y) + reach;
    const query = ++this.query;
    return this.slanted.some(minX, minY, maxX, maxY, index => {
      if (this.visited[index] === query) return false;
      this.visited[index] = query;
      const other = this.sources[index];
      if (other === source) return false;
      const [p, q] = this.all[index];
      if (Math.max(p.x, q.x) < minX || Math.min(p.x, q.x) > maxX || Math.max(p.y, q.y) < minY || Math.min(p.y, q.y) > maxY) return false;
      const run = shallowRun(segment, this.all[index]);
      if (!(run > 0)) return false;
      const total = (near.get(other) ?? 0) + run;
      near.set(other, total);
      return total > SHALLOW_RUN;
    });
  }

  private runsAlong(segment: Segment, source: string): boolean {
    const [a, b] = segment;
    if (a.y === b.y && a.x !== b.x) return this.blocked(true, a.y, Math.min(a.x, b.x), Math.max(a.x, b.x), source, segment);
    if (a.x === b.x && a.y !== b.y) return this.blocked(false, a.x, Math.min(a.y, b.y), Math.max(a.y, b.y), source, segment);
    return false;
  }

  private blocked(horizontal: boolean, at: number, lo: number, hi: number, source: string, segment: Segment): boolean {
    if (!inReach(at)) return true;
    if (this.base?.blocked(horizontal, at, lo, hi, source, segment)) return true;
    const map = horizontal ? this.horizontal : this.vertical;
    // Runs within reach of `at` are filed under these rounded coordinates (a run filed under
    // `last` lies at or beyond last - 0.5, so only within reach if that is below at + NEAR_LANE).
    let last = Math.round(at + NEAR_LANE);
    if (!(last - .5 < at + NEAR_LANE)) last--;
    for (let k = Math.round(at - NEAR_LANE); k <= last; k++) {
      const runs = map.get(k);
      if (runs) for (const run of runs) {
        if (run.source === source) continue;
        if (run.speck) { if (Math.abs(run.at - at) < SPECK && lo <= run.lo + SPECK && run.hi - SPECK <= hi) return true; continue; }
        const apart = Math.abs(run.at - at);
        if (!(apart < NEAR_LANE)) continue;
        const shared = Math.min(hi, run.hi) - Math.max(lo, run.lo);
        // Closer than LANE_SEPARATION, two lines running together further than an arrowhead read as one.
        if (!(apart < LANE_TOLERANCE)) { if (shared > NEAR_RUN) return true; continue; }
        // Runs meeting end to end: the metric's projection can leave a rounding-sized overlap.
        if (shared > 0 || (shared > -SPECK && (overlapLength(segment, run.segment) > 0 || overlapLength(run.segment, segment) > 0))) return true;
      }
    }
    return false;
  }

  /**
   * Every run of a source other than `source`: the lanes a grid route from it must not follow.
   * Berths and curves are left to the check of the finished route (`conflicts`).
   */
  foreign(source: string, into: { horizontal: Run[]; vertical: Run[] } = { horizontal: [], vertical: [] }): ForeignLanes {
    this.base?.foreign(source, into);
    // Specks are left to the check of the finished route.
    for (const runs of this.horizontal.values()) for (const run of runs) if (run.source !== source && !run.speck) into.horizontal.push(run);
    for (const runs of this.vertical.values()) for (const run of runs) if (run.source !== source && !run.speck) into.vertical.push(run);
    return into;
  }
}
/** Pushes `value` onto `lists[key]` (created if missing); returns that list. */
function push<T>(lists: T[][], key: number, value: T): T[] {
  const list = lists[key];
  if (list) { list.push(value); return list; }
  return lists[key] = [value];
}
/** Files `run` under its rounded coordinate; returns the list it joined. */
function file(map: Map<number, Run[]>, run: Run): Run[] {
  const key = Math.round(run.at), runs = map.get(key);
  if (runs) { runs.push(run); return runs; }
  const created = [run];
  map.set(key, created);
  return created;
}

/**
 * `segments(route.path)`, memoized per retained route object: a committed history layout is
 * re-embedded by every layout request made against it. The path is compared on each lookup,
 * so a mutated route is re-parsed; the cached segments are never exposed or mutated.
 */
const parsedRoutes = new WeakMap<PlacedRoute, { readonly path: string; readonly ss: readonly Segment[] }>();
function retainedSegments(route: PlacedRoute): readonly Segment[] {
  const cached = parsedRoutes.get(route);
  if (cached && cached.path === route.path) return cached.ss;
  const ss = segments(route.path);
  parsedRoutes.set(route, { path: route.path, ss });
  return ss;
}

/**
 * The retained routes' segments, indexed, memoized per previous layout for the last list of
 * routes kept from it (the same routes, with the same paths and sources, give the same index).
 */
const retainedIndexes = new WeakMap<GraphLayout, { readonly routes: readonly PlacedRoute[]; readonly keys: readonly string[]; readonly index: LaneIndex }>();
function retainedIndex(previous: GraphLayout, kept: readonly PlacedRoute[]): LaneIndex {
  const keys = kept.map(r => `${r.path}\u0001${sourceKey(r.from.kind, r.from.id)}`);
  const cached = retainedIndexes.get(previous);
  if (cached && cached.routes.length === kept.length && kept.every((r, i) => r === cached.routes[i] && keys[i] === cached.keys[i])) return cached.index;
  const index = new LaneIndex();
  for (const r of kept) { const ss = retainedSegments(r); index.add(ss, sourceKey(r.from.kind, r.from.id), routeEnds(r, ss, previous.nodes, previous.junctions)); }
  // The dots the kept routes reach.
  const dots = new Set<string>();
  for (const r of kept) for (const end of [r.from, r.to]) if (end.kind === "junction") dots.add(end.id);
  for (const id of dots) { const j = previous.junctions.get(id); if (j && Number.isFinite(j.x) && Number.isFinite(j.y)) index.addDot(point(j.x, j.y)); }
  retainedIndexes.set(previous, { routes: kept, keys, index });
  return index;
}

/**
 * Insertion probes every placed box per new tile, so work grows quadratically. Beyond this many
 * visible tiles the history candidate is skipped (the cold candidates and anchored translations
 * remain): its stability is not worth seconds of layout.
 */
export const INCREMENTAL_LIMIT = 256;

/**
 * Probes `x * ys.length + y` (indices into `xs` and `ys`, both free of repeats) sorted by the
 * row bottom they reach, `Math.max(bottom, y + height)`, then y, then x. With every key
 * finite that order is strict and depends on y before x, so it is each row (by bottom, then
 * y) with its columns left to right; otherwise the probes are sorted as listed (x-major).
 */
function rankProbes(xs: readonly number[], ys: readonly number[], bottom: number, height: number): number[] {
  const ny = ys.length, reach = (y: number) => Math.max(bottom, y + height), ranked: number[] = [];
  let finite = true;
  for (const y of ys) if (!Number.isFinite(y) || !Number.isFinite(reach(y))) finite = false;
  for (const x of xs) if (!Number.isFinite(x)) finite = false;
  if (!finite) {
    for (let p = 0; p < xs.length * ny; p++) ranked.push(p);
    return ranked.sort((a, b) => reach(ys[a % ny]) - reach(ys[b % ny]) || ys[a % ny] - ys[b % ny] || xs[(a - a % ny) / ny] - xs[(b - b % ny) / ny]);
  }
  const rows: number[] = [], columns: number[] = [];
  for (let y = 0; y < ny; y++) rows.push(y);
  for (let x = 0; x < xs.length; x++) columns.push(x);
  rows.sort((a, b) => reach(ys[a]) - reach(ys[b]) || ys[a] - ys[b]);
  columns.sort((a, b) => xs[a] - xs[b]);
  for (const y of rows) for (const x of columns) ranked.push(x * ny + y);
  return ranked;
}

/** `[...new Set([a, b, c])]`: the distinct values (SameValueZero), in order. */
function distinctValues3(a: number, b: number, c: number): number[] {
  const same = (x: number, y: number) => x === y || (x !== x && y !== y);
  const out = [a];
  if (!same(b, a)) out.push(b);
  if (!same(c, a) && !same(c, b)) out.push(c);
  return out;
}

/** `preferred`, then lanes `step` apart alternating either side, within [lo, hi]; at most `count`. */
function lanesAround(preferred: number, lo: number, hi: number, count: number, step: number): number[] {
  const out: number[] = [];
  if (!(lo <= hi)) return out;
  for (let k = 0; out.length < count && k <= 2 * count; k++) {
    const value = preferred + step * (k % 2 ? -(k + 1) / 2 : k / 2);
    if (value >= lo && value <= hi) out.push(value);
  }
  return out;
}

/**
 * Where a route ends. `down` arrives moving down onto `end` (a tile's top port or a
 * junction); `right` and `left` arrive moving that way along `end`'s row (a junction's side
 * inputs, or `right` into a tile's left port).
 */
interface Arrival { readonly end: Point; readonly heading: "down" | "right" | "left"; readonly level: number }

/** Everything a route search reads besides its parent and arrival. */
interface Scene {
  readonly tiles: TileIndex;
  /** The probed tile (not yet among `tiles`). */
  readonly extra: PlacedNode;
  readonly width: number;
  readonly clearance: number;
  readonly paneEdges?: { readonly left: number; readonly right: number };
  /** Height of the cover row (the header the cover's side routes cross). */
  readonly header: number;
  /** Lowest edge of any tile above the probed tile (and of the parent). */
  readonly bottomAbove: number;
  readonly cover: string;
  readonly coverStem: (points: readonly Point[]) => readonly Point[];
  /** The lanes route families choose among. */
  readonly grain: Grain;
}

/** Parallel lanes a route family may take: `choices` of them, `step` apart. */
interface Grain { readonly step: number; readonly choices: number }
const GRAIN: Grain = { step: LANE_STEP, choices: LANE_CHOICES };
/** The second chance's lanes: half a step apart (still well clear of the lane tolerance), twice as many. */
const FINE_GRAIN: Grain = { step: LANE_STEP / 2, choices: 2 * LANE_CHOICES };

/**
 * One route shape: its base lanes, then (only if the base runs along another source's lane)
 * the same shape on neighbouring lanes. Variants are built only when asked for.
 */
interface Family { readonly base: readonly Point[]; readonly variants: () => readonly (readonly Point[])[] }
/** A family whose `lanes(k)` gives lane choice k (k = 0 is the base); choices that do not exist give null. */
function family(lanes: (k: number) => readonly Point[] | null, choices: number): Family | null {
  let base: readonly Point[] | null = null, first = 0;
  for (; first < choices && !base; first++) base = lanes(first);
  if (!base) return null;
  return { base, variants: () => {
    const out: (readonly Point[])[] = [];
    for (let k = first; k < choices; k++) { const plan = lanes(k); if (plan) out.push(plan); }
    return out;
  } };
}
/** A family whose lane choice is a pair: `lanes(k, j)` for k < `choices` and j < TRAVEL_ROWS.length. */
function lanePairs(lanes: (k: number, j: number) => readonly Point[] | null, choices: number): Family | null {
  return family(i => lanes(Math.floor(i / TRAVEL_ROWS.length), i % TRAVEL_ROWS.length), choices * TRAVEL_ROWS.length);
}
/** `preferred` and then lanes a grain step apart alternating either side, within [lo, hi]: lane k. */
function laneAround(preferred: number, lo: number, hi: number, k: number, g: Grain): number | null {
  const lanes = lanesAround(preferred, lo, hi, 2 * g.choices - 1, g.step);
  return k < lanes.length ? lanes[k] : null;
}

/**
 * The bounded orthogonal route families from `p` to one arrival: `direct` ones (nearly the
 * shortest shapes: through the gap between source and target, or a jog beside a junction)
 * or the detours through the outer gutters and travel rows. Routes leave from `p`'s bottom
 * port, or from its right port unless `bottomOnly` (the cover, whose stem attachment owns its
 * other ports).
 */
function plans(p: PlacedNode, arrival: Arrival, s: Scene, bottomOnly: boolean, direct: boolean, emit: (f: Family | null) => void): void {
  const { end, heading } = arrival, { width } = s, grain = s.grain, { step, choices } = grain;
  const bottom = point(p.x + p.width / 2, p.y + p.height), right = point(p.x + p.width, p.y + p.height / 2);
  const bx = bottom.x, pb = bottom.y, ex = end.x, ey = end.y, pr = p.x + p.width;
  const bottomAbove = Math.max(pb, s.bottomAbove);
  // The straight final run into the target: a tile's arrowhead needs its length, a junction input less.
  const run = arrival.level < 0 ? ARROW.length : JOIN_APPROACH;
  const lane = (k: number) => s.clearance + 2 + step * k;
  const outer = (k: number, left: boolean) => left ? 8 + step * k : width - 8 - step * k;
  /** Travel row j below the tiles above the target: 6 px below them, then the rows either side. */
  const travel = (j: number) => bottomAbove + 6 + step * TRAVEL_ROWS[j];
  const headerRow = (k: number) => s.header + HEADER_ROWS[k % HEADER_ROWS.length];
  const exitRow = (k: number) => pb + 4 + step * k;
  const sideX = (k: number) => pr + SIDE_LANE + step * k;
  if (heading === "down" && direct) {
    if (ey >= pb + 8) {
      if (bx === ex) emit(family(() => [bottom, end], 1));
      else emit(family(k => { const mid = laneAround((pb + ey - 8) / 2, pb, ey - run, k, grain); return mid === null ? null : [bottom, point(bx, mid), point(ex, mid), end]; }, 2 * choices - 1));
    }
    // From the right port down the gap beside the parent, then along a row between the tiles
    // above the target and its arrival: the way past lines leaving the parent's row near their
    // ports (lane choice (k, j): gap lane k, row j).
    if (!bottomOnly) {
      const rows = 2 * choices - 1;
      emit(family(i => {
        const x = sideX(Math.floor(i / rows)), y = laneAround((bottomAbove + ey - run) / 2, bottomAbove + 2, ey - run - 2, i % rows, grain);
        return y === null || x > width - 8 || Math.abs(ex - x) < 1 ? null : [right, point(x, right.y), point(x, y), point(ex, y), end];
      }, choices * rows));
    }
    return;
  }
  if (heading === "down") {
    // Shelf returns and blocked direct approaches use the visible outer gutters. Lane choice
    // (k, j) picks the gutter lane k and the row j the route takes into the target.
    if (!bottomOnly) for (const left of [true, false]) emit(lanePairs((k, j) => {
      const g = lane(k), y = Math.max(pb + g, s.bottomAbove + g), ty = ey - run - step * j, x = left ? g : width - g;
      return ty >= y ? [right, point(width - g, right.y), point(width - g, y), point(x, y), point(x, ty), point(ex, ty), end] : null;
    }, choices));
    // A new edit below the entire visible scene escapes through its source's side gap, then
    // the cover header and an outer gutter, or through the gap below its source, then along a
    // travel row: lane choice (k, j) picks the gutter lane k and the travel row j.
    for (const left of [true, false]) {
      if (!bottomOnly) emit(lanePairs((k, j) => sideX(k) <= width - 8 && ey >= travel(j) + run
        ? [right, point(sideX(k), right.y), point(sideX(k), headerRow(k)), point(outer(k, left), headerRow(k)), point(outer(k, left), travel(j)), point(ex, travel(j)), end] : null, choices));
      emit(lanePairs((k, j) => ey >= travel(j) + run
        ? [bottom, point(bx, exitRow(k)), point(outer(k, left), exitRow(k)), point(outer(k, left), travel(j)), point(ex, travel(j)), end] : null, choices));
    }
    return;
  }
  // Side arrivals: along `end`'s row from the left (heading right) or the right (heading left).
  const fromLeft = heading === "right";
  if (arrival.level < 0) {
    // A tile's left port, from the parent's right port across the gap between them: straight
    // where the ports line up, else a jog in the gap, off the parent's side and before the
    // arrowhead's straight run.
    if (direct && !bottomOnly && ex >= pr + 8) {
      if (ey === right.y) emit(family(() => [right, end], 1));
      else emit(family(k => {
        const lo = pr + SIDE_LANE, hi = ex - run, mid = laneAround(Math.min(hi, Math.max(lo, (pr + ex - 8) / 2)), lo, hi, k, grain);
        return mid === null ? null : [right, point(mid, right.y), point(mid, ey), end];
      }, 2 * choices - 1));
    }
    return;
  }
  if (direct) {
    if (ey > pb) {
      if (fromLeft ? bx < ex : bx > ex) emit(family(() => [bottom, point(bx, ey), end], 1));
      // A jog beside the junction, when the parent's own column is on the wrong side or taken.
      for (const offset of [12, 24]) {
        const x = ex + (fromLeft ? -offset : offset);
        emit(family(k => { const mid = laneAround((pb + ey) / 2, pb + 2, ey - 2, k, grain); return mid === null ? null : [bottom, point(bx, mid), point(x, mid), point(x, ey), end]; }, 3));
      }
    }
    if (!bottomOnly) emit(family(k => {
      const x = fromLeft ? laneAround((pr + ex) / 2, pr + 4, ex - 4, k, grain) : Math.max(pr, ex) + 8 + step * k;
      return x === null ? null : [right, point(x, right.y), point(x, ey), end];
    }, 3));
    return;
  }
  emit(family(k => ey >= exitRow(k) + 8 ? [bottom, point(bx, exitRow(k)), point(outer(k, fromLeft), exitRow(k)), point(outer(k, fromLeft), ey), end] : null, choices));
  if (bottomOnly) return;
  emit(family(k => sideX(k) <= width - 8 && ey >= headerRow(k) + 8
    ? [right, point(sideX(k), right.y), point(sideX(k), headerRow(k)), point(outer(k, fromLeft), headerRow(k)), point(outer(k, fromLeft), ey), end] : null, choices));
  emit(family(k => {
    const g = lane(k), gutter = width - g, y = Math.max(pb + g, s.bottomAbove + g);
    if (!fromLeft) return [right, point(gutter, right.y), point(gutter, ey), end];
    return ey >= y + 8 ? [right, point(gutter, right.y), point(gutter, y), point(g, y), point(g, ey), end] : null;
  }, choices));
}

interface Route {
  readonly points: readonly Point[];
  readonly ss: readonly Segment[];
  readonly arrival: Arrival;
  /** Taken from the detours: no direct route was lane-free (`RouteSearch.find`). */
  readonly detour?: true;
}
/** A route's ends by where it arrives: a tile's port (an arrowhead) or a junction's dot. */
const endsInto = (arrival: Arrival): Ends => arrival.level < 0 ? INTO_TILE : INTO_JUNCTION;

/** A planned route with its segments, as drawn and as lane-checked, and whether it keeps clear of every tile. */
/** A planned route. Its segments, lane segments and tile test are computed on first need. */
class Candidate {
  private segments?: readonly Segment[];
  private laneSegments?: readonly Segment[];
  clear?: boolean;
  /** Runs along a lane of the `lanes` a recording `find` searched (so of any superset of them). */
  crowded?: true;
  readonly length: number;
  constructor(readonly points: readonly Point[], private readonly stem?: (points: readonly Point[]) => readonly Point[]) { this.length = writtenLength(points); }
  get ss(): readonly Segment[] { return this.segments ??= pathSegments(this.points); }
  /** The segments other sources must keep off: the cover's as attachment redraws them. */
  get lanes(): readonly Segment[] { return this.laneSegments ??= this.stem ? pathSegments(this.stem(this.points)) : this.ss; }
}

/**
 * The route search from `p` to any of `arrivals`. Plans, their segments and their tile tests
 * do not depend on other routes, so they are built once and reused by every `find` against a
 * different set of placed lanes.
 */
class RouteSearch {
  private readonly source: string;
  private readonly bottomOnly: boolean;
  /** The direct families, then the detours (built only if no direct route fits). */
  private readonly tiers: { families: Family[]; owner: Arrival[]; order: number[]; bases: Candidate[]; variants: Map<number, Candidate[]> }[] = [];

  constructor(private readonly p: PlacedNode, private readonly arrivals: readonly Arrival[], private readonly s: Scene, private readonly terminal: boolean) {
    this.bottomOnly = p.key === s.cover;
    this.source = sourceKey("node", p.key);
  }

  private tier(index: number) {
    let tier = this.tiers[index];
    if (tier) return tier;
    const families: Family[] = [], owner: Arrival[] = [];
    for (const arrival of this.arrivals) plans(this.p, arrival, this.s, this.bottomOnly, index === 0, f => { if (f) { families.push(f); owner.push(arrival); } });
    const lengths = families.map(f => writtenLength(f.base));
    tier = { families, owner, order: families.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b), bases: [], variants: new Map() };
    return this.tiers[index] = tier;
  }

  private candidate(points: readonly Point[]): Candidate {
    return new Candidate(points, this.bottomOnly ? this.s.coverStem : undefined);
  }

  private isClear(c: Candidate): boolean { return c.clear ??= this.clear(c.points, c.ss); }

  /** In the pane (the band's extent, plus 8 px padding, must fit) and clear of tiles, the arrowhead included. */
  private clear(points: readonly Point[], ss: readonly Segment[]): boolean {
    const s = this.s, last = ss.at(-1);
    for (const q of points) if (!(q.x >= 8 && q.x <= s.width - 8)) return false;
    if (!last || s.tiles.crosses(ss, s.extra) || s.tiles.grazes(ss, this.p, s.extra)) return false;
    if (this.terminal) {
      const [a, b] = last, length = Math.hypot(b.x - a.x, b.y - a.y);
      const tip = point(b.x + (b.x - a.x) / length * ARROW.length, b.y + (b.y - a.y) / length * ARROW.length);
      if (s.tiles.crosses([[b, tip]], s.extra)) return false;
    }
    return true;
  }

  /**
   * The shortest route clear of tiles and of other sources' `lanes`, or null. Direct routes
   * come before detours. In each, every family's base lanes are tried first, shortest first
   * (ties in listed order); then the other lanes of the families whose base ran along another
   * source's lane (and only those), shortest first.
   *
   * A `record`ing search marks the candidates it finds crowded. Later searches must be given a
   * superset of its lanes (lanes are only ever added), so those candidates stay crowded there
   * and need no new lane test.
   *
   * Routes into a `taken` arrival are skipped: another source's route ends there from the same
   * side, so their final approaches would run along it.
   */
  find(lanes: LaneIndex, record = false, taken?: ReadonlySet<Arrival>, directOnly = false): Route | null {
    for (let index = 0; index < (directOnly ? 1 : 2); index++) {
      const { families, owner, order, bases, variants } = this.tier(index), crowded: number[] = [];
      for (const f of order) {
        if (taken?.has(owner[f])) continue;
        const c = bases[f] ??= this.candidate(families[f].base);
        if (!this.isClear(c)) continue;
        if (!c.crowded) {
          if (!lanes.conflicts(c.lanes, this.source, endsInto(owner[f]))) return route(c, owner[f], index);
          if (record) c.crowded = true;
        }
        crowded.push(f);
      }
      const options: Candidate[] = [], from: number[] = [];
      for (const f of crowded.sort((a, b) => a - b)) {
        let list = variants.get(f);
        if (!list) { list = families[f].variants().map(points => this.candidate(points)); variants.set(f, list); }
        for (const c of list) { options.push(c); from.push(f); }
      }
      const ranked = options.map((_, i) => i).sort((a, b) => options[a].length - options[b].length || a - b);
      for (const i of ranked) {
        const c = options[i];
        if (c.crowded) continue;
        if (!lanes.conflicts(c.lanes, this.source, endsInto(owner[from[i]]))) { if (this.isClear(c)) return route(c, owner[from[i]], index); }
        else if (record) c.crowded = true;
      }
    }
    return null;
  }
}

/** The route a search found in tier `tier` (0: direct, 1: detours). */
const route = (c: Candidate, arrival: Arrival, tier: number): Route => tier ? { points: c.points, ss: c.ss, arrival, detour: true } : { points: c.points, ss: c.ss, arrival };

/** Junction points above tile `n` for `count` parents: level 0 lowest, `LEVEL_GAP` apart. */
function joinLevels(n: PlacedNode, count: number, shift: number): Point[] {
  const levels = Math.max(1, Math.ceil((count - 1) / 2)), x = n.x + n.width / 2, y = n.y - 2 * ARROW.length + shift;
  return Array.from({ length: levels }, (_, i) => point(x, y - LEVEL_GAP * i));
}

/** The spine (level to level) and tail (level 0 to the arrowhead) of junction `levels` above `n`. */
function spinePoints(levels: readonly Point[], n: PlacedNode): Point[] {
  return [...levels].reverse().concat([point(levels[0].x, n.y - ARROW.length)]);
}

/** Arrivals into junction `levels`: either side of each, and from above into the top one. */
function joinArrivals(levels: readonly Point[]): Arrival[] {
  const out: Arrival[] = [];
  levels.forEach((end, level) => {
    if (level === levels.length - 1) out.push({ end, heading: "down", level });
    out.push({ end, heading: "right", level }, { end, heading: "left", level });
  });
  return out;
}

/** A tile's routes: one per parent (in parent order) and, with a junction, its spine levels. */
interface Wiring { readonly routes: readonly Route[]; readonly levels?: readonly Point[] }

/**
 * Lane-free routes from every parent into `n` from the probe's route families: directly, or
 * through a junction (spine) whose rows are tried at a few offsets, its parents in a few
 * orders. `undefined` when there is none.
 */
function wire(parents: readonly PlacedNode[], n: PlacedNode, s: Scene, lanes: LaneIndex, item: string, hardest: { index: number }, directOnly = false): Wiring | undefined {
  if (parents.length === 1) {
    const t = n, arrivals: Arrival[] = [{ end: point(t.x + t.width / 2, t.y - ARROW.length), heading: "down", level: -1 }, { end: point(t.x - ARROW.length, t.y + t.height / 2), heading: "right", level: -1 }];
    const route = new RouteSearch(parents[0], arrivals, s, true).find(lanes, false, undefined, directOnly);
    return route ? { routes: [route] } : undefined;
  }
  const junction = sourceKey("junction", `incremental-join:${item}`);
  const laneSegments = (p: PlacedNode, route: Route) => p.key === s.cover ? pathSegments(s.coverStem(route.points)) : route.ss;
  for (const shift of JOIN_SHIFTS) {
    const levels = joinLevels(n, parents.length, shift), spine = pathSegments(spinePoints(levels, n));
    if (levels.some(level => lanes.nearSegment(level)) || lanes.conflicts(spine, junction, SPINE) || s.tiles.crosses(spine, s.extra)) continue;
    // The spine's levels are distinct sources; no parent may run along any of it.
    const before = lanes.mark();
    lanes.add(spine, junction, SPINE);
    const arrivals = joinArrivals(levels), searches: RouteSearch[] = [];
    const search = (i: number) => searches[i] ??= new RouteSearch(parents[i], arrivals, s, false);
    // Each parent's best route with the spine alone. Other parents' routes only add lanes to
    // avoid, so a parent without one settles the shift, and one still lane-free beside them
    // is still that parent's best.
    // The parent that last had no route goes first: it settles most probes that fail.
    const alone: Route[] = [];
    let complete = true;
    for (let k = 0; k < parents.length; k++) {
      const i = k ? (k <= hardest.index ? k - 1 : k) : hardest.index, route = search(i).find(lanes, true, undefined, directOnly);
      if (!route) { hardest.index = i; complete = false; break; }
      alone[i] = route;
    }
    if (!complete) { lanes.rollback(before); continue; }
    const withSpine = lanes.mark();
    // Parents are wired in turn, each avoiding those before it. A parent left without a route
    // goes first in the next attempt (at most one attempt per parent, and two in all).
    let order = parents.map((_, i) => i);
    for (let attempt = 0; attempt < Math.max(2, parents.length); attempt++) {
      const routes: Route[] = [], taken = new Set<Arrival>();
      let stuck = -1;
      for (const i of order) {
        const p = parents[i], source = sourceKey("node", p.key);
        const route = !lanes.conflicts(laneSegments(p, alone[i]), source, INTO_JUNCTION) ? alone[i] : search(i).find(lanes, false, taken, directOnly);
        if (!route) { stuck = i; break; }
        routes[i] = route;
        taken.add(route.arrival);
        lanes.add(laneSegments(p, route), source, INTO_JUNCTION);
      }
      lanes.rollback(withSpine);
      if (stuck < 0) { lanes.rollback(before); return { routes, levels }; }
      if (order[0] === stuck) break;
      order = [stuck, ...order.filter(i => i !== stuck)];
    }
    lanes.rollback(before);
  }
  return undefined;
}

/**
 * Grid-routed wiring into a fallback slot `n`: each parent (in order) takes the first junction
 * level (or the tile) its lane-aware grid route reaches with a lane-free path.
 */
function gridWire(parents: readonly PlacedNode[], n: PlacedNode, s: Scene, lanes: LaneIndex, item: string, effort: Effort): Wiring | undefined {
  if (effort.everyLane) return gridWireAll(parents, n, s, lanes, item, effort);
  const obstacles = [...s.tiles.tiles, n], multi = parents.length > 1;
  const levels = multi ? joinLevels(n, parents.length, 0) : undefined;
  const before = lanes.mark();
  if (levels) {
    const spine = pathSegments(spinePoints(levels, n));
    if (levels.some(level => lanes.nearSegment(level)) || lanes.conflicts(spine, sourceKey("junction", `incremental-join:${item}`), SPINE) || s.tiles.crosses(spine, s.extra)) return undefined;
    lanes.add(spine, sourceKey("junction", `incremental-join:${item}`), SPINE);
  }
  const routes: Route[] = [];
  for (const p of parents) {
    const source = sourceKey("node", p.key);
    // The bottom port, then (except for the cover) the right port, each left by a short stub.
    const ports = [[point(p.x + p.width / 2, p.y + p.height), point(p.x + p.width / 2, p.y + p.height + 2)]];
    if (p.key !== s.cover) ports.push([point(p.x + p.width, p.y + p.height / 2), point(p.x + p.width + 2, p.y + p.height / 2)]);
    const goals = levels ? levels.map((end, level): Arrival => ({ end, heading: "down", level })) : [{ end: point(n.x + n.width / 2, n.y - 16), heading: "down" as const, level: -1 }];
    let found: Route | undefined;
    search: for (const [port, start] of ports) for (const arrival of goals) {
      if (!(left(effort) > 0)) break search;
      const grid = routeAroundBerths(start, arrival.end, obstacles, s.width, lanes, source, effort, { bounds: s.paneEdges });
      if (!grid) continue;
      const points = [port, ...grid, ...(levels ? [] : [point(arrival.end.x, n.y - ARROW.length)])];
      const ss = pathSegments(points);
      if (!ss.length || lanes.conflicts(p.key === s.cover ? pathSegments(s.coverStem(points)) : ss, source, levels ? INTO_JUNCTION : INTO_TILE)) continue;
      found = { points, ss, arrival };
      break search;
    }
    if (!found) { lanes.rollback(before); return undefined; }
    routes.push(found);
    lanes.add(p.key === s.cover ? pathSegments(s.coverStem(found.points)) : found.ss, source, levels ? INTO_JUNCTION : INTO_TILE);
  }
  lanes.rollback(before);
  return { routes, levels };
}

/**
 * The grid knows parallel lanes, but its shortest path can still cross a foreign port or
 * corner. Add that rejecting witness as an obstacle and search again. Adding every berth
 * up front would form a much larger Cartesian grid, even when the first route is legal.
 * Every attempt spends the same shared request budget; the final full lane check still
 * rejects unsupported corner/curve conflicts rather than weakening the geometry contract.
 */
function routeAroundBerths(start: Point, goal: Point, obstacles: readonly PlacedNode[], width: number,
  lanes: LaneIndex, source: string, effort: Effort, options: Pick<GridSearch, 'bounds' | 'column'>): readonly Point[] | null {
  const foreign = lanes.foreign(source), avoided: PlacedNode[] = [], seen = new Set<string>();
  for (let attempt = 0; attempt < BERTH_RETRIES && left(effort) > 0; attempt++) {
    const spent = { cells: 0, pops: 0 };
    const grid = orthogonalRoute(start, goal, avoided.length ? [...obstacles, ...avoided] : obstacles, width, foreign,
      { ...options, budget: Math.min(effort.budget, left(effort)), everyLane: effort.everyLane, spent });
    spend(effort, spent);
    if (!grid) return null;
    const berth = lanes.blockingBerth(pathSegments(grid), source);
    if (!berth) return grid;
    const key = JSON.stringify([berth.x, berth.y, berth.radius]);
    if (seen.has(key)) return null;
    seen.add(key);
    // The grid expands rectangles by TILE_GRAZE; the resulting square contains the berth.
    const radius = Math.max(0, berth.radius - TILE_GRAZE);
    avoided.push({ key, x: berth.x - radius, y: berth.y - radius, width: radius * 2, height: radius * 2, row: 0, band: 0 });
  }
  return null;
}

/**
 * The second chance's grid wiring into slot `n`: the parent that last failed goes first; each
 * leaves by its bottom or right port (the cover by its bottom only) and takes one search
 * per port to whichever junction level (or the tile) it reaches first.
 */
function gridWireAll(parents: readonly PlacedNode[], n: PlacedNode, s: Scene, lanes: LaneIndex, item: string, effort: Effort): Wiring | undefined {
  const obstacles = [...s.tiles.tiles, n], multi = parents.length > 1, junction = sourceKey("junction", `incremental-join:${item}`);
  const levels = multi ? joinLevels(n, parents.length, 0) : undefined;
  if (levels) {
    const spine = pathSegments(spinePoints(levels, n));
    if (levels.some(level => lanes.nearSegment(level)) || lanes.conflicts(spine, junction, SPINE) || s.tiles.crosses(spine, s.extra)) return undefined;
  }
  const before = lanes.mark();
  if (levels) lanes.add(pathSegments(spinePoints(levels, n)), junction, SPINE);
  const first = parents.findIndex(p => p.key === effort.hardest);
  const order = parents.map((_, i) => i);
  if (first > 0) order.unshift(...order.splice(first, 1));
  const goal = levels ? levels[0] : point(n.x + n.width / 2, n.y - 16), column = levels ? levels.slice(1).map(l => l.y) : undefined;
  const routes: Route[] = [];
  for (const i of order) {
    const p = parents[i], source = sourceKey("node", p.key), cover = p.key === s.cover;
    const ports = [[point(p.x + p.width / 2, p.y + p.height), point(p.x + p.width / 2, p.y + p.height + 2)]];
    if (!cover) ports.push([point(p.x + p.width, p.y + p.height / 2), point(p.x + p.width + 2, p.y + p.height / 2)]);
    let found: Route | undefined;
    for (const [port, start] of ports) {
      if (!(left(effort) > 0)) break;
      const grid = routeAroundBerths(start, goal, obstacles, s.width, lanes, source, effort, { column, bounds: s.paneEdges });
      if (!grid) continue;
      const end = grid[grid.length - 1], level = levels ? levels.findIndex(l => l.y === end.y) : -1;
      const points = [port, ...grid, ...(levels ? [] : [point(goal.x, n.y - ARROW.length)])];
      const ss = pathSegments(points);
      if (!ss.length || lanes.conflicts(cover ? pathSegments(s.coverStem(points)) : ss, source, levels ? INTO_JUNCTION : INTO_TILE)) continue;
      found = { points, ss, arrival: { end, heading: "down", level } };
      break;
    }
    if (!found) { effort.hardest = p.key; lanes.rollback(before); return undefined; }
    routes[i] = found;
    lanes.add(cover ? pathSegments(s.coverStem(found.points)) : found.ss, source, levels ? INTO_JUNCTION : INTO_TILE);
  }
  lanes.rollback(before);
  return { routes, levels };
}

/**
 * The cover's routes as attachment redraws them: everything above the stem cut is replaced by
 * the cover stem (down from the cover, along its track, down to the cut), as `attachPackedBand`
 * does. Lane checks use this geometry, so other sources keep off the redrawn stem too.
 */
function coverStemFor(request: LayoutRequest, cover: PlacedNode): (points: readonly Point[]) => readonly Point[] {
  const placement = request.history?.attachment?.placement;
  const top = cover.y + cover.height, cut = top + (placement?.stemRoom ?? STACK_STEM_ROOM) - 16, lane = top + (placement?.track ?? 12);
  const x = cover.x + cover.width / 2, columns = [...(placement?.coverColumns ?? []), ...(placement?.bypassColumns ?? [])].map((c): [number, number] => [c - 3.5, c + 3.5]);
  const bridge = placement?.bridge;
  return (points) => {
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1], end = points[i];
      if (end.y < cut) continue;
      const t = end.y === from.y ? 0 : (cut - from.y) / (end.y - from.y), at = point(from.x + (end.x - from.x) * t, from.y + (end.y - from.y) * t);
      const drop = nearestFree(at.x, columns, 0, Math.max(request.maxWidth, at.x)) ?? at.x;
      const stem = bridge ? [point(x, top), point(x, bridge.top), point(bridge.gutter, bridge.top), point(bridge.gutter, lane)] : [point(x, top), point(x, lane)];
      return [...stem, point(drop, lane), point(drop, at.y), at, ...points.slice(i)];
    }
    return points;
  };
}

/** Tile pins do not pin wires. Free an occluded source port by rerouting a blocking
 * terminal connector while preserving every retained rectangle and logical edge. */
function freeBlockedPorts(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget): GraphLayout {
  const newParents = new Set(request.items.filter(n => !previous.nodes.has(n.key)).flatMap(n => n.parents));
  if (!newParents.size || previous.nodes.size > INCREMENTAL_LIMIT || !inReach(request.maxWidth)
    || !inReach(previous.width) || !inReach(previous.height)
    || [...previous.nodes.values()].some(n => ![n.x, n.y, n.width, n.height].every(inReach))
    || [...previous.junctions.values()].some(j => ![j.x, j.y].every(inReach))
    || previous.routes.some(r => !usableRetainedRoute(r))) return previous;
  let routes = [...previous.routes], changed = false, repairs = 0;
  const source = (r: PlacedRoute) => sourceKey(r.from.kind, r.from.id);
  for (const key of newParents) {
    const parent = previous.nodes.get(key); if (!parent) continue;
    const ports = [point(parent.x + parent.width / 2, parent.y + parent.height), point(parent.x + parent.width, parent.y + parent.height / 2)];
    const blockers = ports.map(port => routes.filter(r => source(r) !== sourceKey('node', key)
      && segments(r.path).some(segment => distanceToSegment(segment, port) < PORT_BERTH - .01)));
    if (blockers.some(list => !list.length)) continue;
    const candidates = [...new Set(blockers.flat())].sort((a, b) => Number(blockers.every(list => list.includes(b))) - Number(blockers.every(list => list.includes(a))));
    for (const blocked of candidates) {
      if (repairs++ >= 4 || !(budget.second > 0)) return changed ? { ...previous, routes } : previous;
      if (blocked.from.kind !== 'node' || blocked.to.kind !== 'node' || !blocked.terminal || blocked.from.id === blocked.to.id) continue;
      const from = previous.nodes.get(blocked.from.id), to = previous.nodes.get(blocked.to.id);
      if (!from || !to) continue;
      const kept = routes.filter(r => r !== blocked), cover = previous.nodes.get(request.band!.key);
      if (!cover) return previous;
      let replacement: Wiring | undefined;
      // One clear port suffices. Requiring both can be impossible where a child
      // sits just below its parent; represent the chosen berth in the search grid.
      for (const port of ports) {
        const lanes = new LaneIndex(retainedIndex(previous, kept));
        const berth: PlacedNode = { key: JSON.stringify(['reserved-port', key]), x: port.x - PORT_BERTH, y: port.y - PORT_BERTH,
          width: PORT_BERTH * 2, height: PORT_BERTH * 2, row: 0, band: 0 };
        const scene: Scene = { tiles: new TileIndex([...previous.nodes.values(), berth]), extra: to,
          width: Math.max(request.maxWidth, previous.width), clearance: spacingFor(request.tileWidth).clearance,
          header: cover.height, bottomAbove: to.y - 20, cover: cover.key, coverStem: coverStemFor(request, cover), grain: FINE_GRAIN };
        replacement = gridWireAll([from], to, scene, lanes, to.key, secondChance(budget));
        if (replacement) break;
      }
      if (!replacement) continue;
      routes = routes.map(r => r === blocked ? { ...r, path: path(replacement!.routes[0].points) } : r);
      changed = true;
      break;
    }
  }
  return changed ? { ...previous, routes } : previous;
}

/** Shift only an internal orthogonal run that occludes a newly active source port.
 * Endpoints and logical identities stay fixed; the shared insertion budget bounds repair.
 * This also handles junction inputs, which cannot be replaced by a tile-to-tile router. */
function freePortLanes(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget): GraphLayout {
  const newParents = new Set(request.items.filter(n => !previous.nodes.has(n.key)).flatMap(n => n.parents));
  let routes = [...previous.routes], repairs = 0;
  if (previous.nodes.size > INCREMENTAL_LIMIT || !inReach(request.maxWidth)
    || previous.routes.some(r => !usableRetainedRoute(r))) return previous;
  const tiles = new TileIndex([...previous.nodes.values()]);
  for (const key of newParents) {
    const parent = previous.nodes.get(key); if (!parent) continue;
    const ports = [point(parent.x + parent.width / 2, parent.y + parent.height), point(parent.x + parent.width, parent.y + parent.height / 2)];
    for (const blocked of [...routes]) {
      if (repairs >= 4 || budget.probes <= 0) return { ...previous, routes };
      if (blocked.from.kind !== 'node' || blocked.from.id === key) continue;
      const lines = segments(blocked.path);
      if (!lines.length || !ports.some(port => lines.some(line => distanceToSegment(line, port) < PORT_BERTH - .01))) continue;
      const from = previous.nodes.get(blocked.from.id); if (!from) continue;
      // Curved attachment headers do not prevent repairing a later straight run.
      // Keep their exact commands and controls; flattened curve segments are never edited.
      const commands = pathCommands(blocked.path), raw = [...blocked.path.matchAll(/[MLC][^MLC]*/g)].map(m => m[0]);
      if (!commands || commands.length !== raw.length) continue;
      const points = commands.map(c => point(c.values.at(-2)!, c.values.at(-1)!));
      const lanes = retainedIndex(previous, routes);
      let found: string | undefined;
      for (let i = 1; i < points.length - 2 && !found; i++) {
        // Only internal straight neighbours may move. Curve endpoints and both route ends stay fixed.
        if ([commands[i], commands[i + 1], commands[i + 2]].some(c => c.kind !== 'L')) continue;
        const a = points[i], b = points[i + 1], vertical = a.x === b.x, horizontal = a.y === b.y;
        if (!vertical && !horizontal) continue;
        const nearby = ports.filter(port => distanceToSegment([a, b], port) < PORT_BERTH - .01);
        for (const port of nearby) {
          const old = vertical ? a.x : a.y, axis = vertical ? 'x' : 'y', center = vertical ? port.x : port.y;
          const direction = old < center ? -1 : 1;
          for (const distance of [PORT_BERTH + LANE_STEP, PORT_BERTH + 2 * LANE_STEP, PORT_BERTH, PORT_BERTH + 3 * LANE_STEP]) {
            if (budget.probes-- <= 0) break;
            const coordinate = center + direction * distance;
            const candidate = points.map((p, k) => k === i || k === i + 1 ? { ...p, [axis]: coordinate } : p);
            if (candidate.some(p => p.x < 8 || p.x > request.maxWidth - 8)) continue;
            const nextPath = raw.map((command, k) => k === i || k === i + 1 ? `L${candidate[k].x} ${candidate[k].y} ` : command).join('');
            const pieces = segments(nextPath), end = candidate.at(-1)!, beforeEnd = candidate.at(-2)!;
            if ([i, i + 1, i + 2].some(k => candidate[k - 1].x !== candidate[k].x && candidate[k - 1].y !== candidate[k].y)) continue;
            if (blocked.terminal && !((end.x === beforeEnd.x && end.y - beforeEnd.y >= ARROW.length)
              || (end.y === beforeEnd.y && end.x - beforeEnd.x >= ARROW.length))) continue;
            if (tiles.crosses(pieces) || tiles.grazes(pieces, from)
              || lanes.conflicts(pieces, sourceKey('node', blocked.from.id), blocked.to.kind === 'junction' ? INTO_JUNCTION : INTO_TILE)) continue;
            found = nextPath; break;
          }
          if (found) break;
        }
      }
      if (found) { routes = routes.map(r => r === blocked ? { ...r, path: found! } : r); repairs++; }
    }
  }
  return repairs ? { ...previous, routes } : previous;
}

/** Repairable drafts defer contact admission to connector repair and independent certification. */
type InsertionPolicy = "stable" | "constrained" | "repairable";

function insertWithPortRepair(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget, paneEdges?: Scene["paneEdges"], policy: InsertionPolicy = "stable"): GraphLayout | null {
  countLayoutWork("pinned-search");
  const repaired = freeBlockedPorts(request, previous, budget);
  const placed = insertTree(request, repaired, budget, paneEdges, policy);
  if (placed) return placed;
  const shifted = freePortLanes(request, repaired, budget);
  return shifted === repaired ? null : insertTree(request, shifted, budget, paneEdges, policy);
}

interface InsertionMemo { readonly layout: GraphLayout | null; readonly remaining: IncrementalBudget }
const insertionMemo = createBoundedCache<InsertionMemo>(entry => 64 + (entry.layout ? estimateLayoutBytes(entry.layout) : 0));

/** Content keys admit worker clones too. Cached objects stay private; budget effects are replayed
 * exactly, including failed searches. No rejected candidate acquires a geometry certificate.
 * The repairable policy returns an uncertified draft: repair its connector contacts and
 * run the independent geometry gate before admitting it as a displayed layout. */
export function incrementalTree(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget = incrementalBudget(), policy: InsertionPolicy = "stable"): GraphLayout | null {
  const endStage = layoutStage('pinned-band');
  try {
    const memoKey = JSON.stringify([policy, layoutSignature(request), geometrySignature(previous), previous.pinnedViolation, [budget.fallback, budget.second, budget.probes].map(String)]);
    const known = insertionMemo.get(memoKey);
    if (known) {
      Object.assign(budget, known.remaining);
      countLayoutWork('pinned-cache-hit');
      return structuredClone(known.layout);
    }
    const result = buildIncrementalTree(request, previous, budget, policy);
    insertionMemo.set(memoKey, { layout: structuredClone(result), remaining: { ...budget } });
    return result;
  } finally { endStage(); }
}

function buildIncrementalTree(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget, policy: InsertionPolicy): GraphLayout | null {
  const placed = insertWithPortRepair(request, previous, budget, undefined, policy);
  if (!placed) return null;
  const key = request.band!.key;
  // Pinned ink cannot be centered to make room for cosmetic allocation padding.
  // Spend only the actual free margin on either side, retaining the painted
  // arrow half-width just as the other pane-bounded candidates do.
  const raw = bandExtent({ ...placed, bandBounds: undefined }, key, 0);
  const padding = Math.max(ARROW.width / 2, Math.min(8, raw.left, placed.width - raw.left - raw.width));
  const extent = bandExtent({ ...placed, bandBounds: undefined }, key, padding);
  if (extent.left < 0 || extent.left + extent.width > placed.width) return null;
  return { ...placed, bandBounds: { left: 0, width: extent.left + extent.width,
    top: placed.nodes.get(key)!.height + (request.history?.attachment?.placement.stemRoom ?? STACK_STEM_ROOM) }, preferredX: 0 };
}

/** World coordinates already include packing. No child-band allocation padding applies. */
export function incrementalWorld(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget = incrementalBudget(), paneLeft = 0): GraphLayout | null {
  const placed = insertWithPortRepair(request, previous, budget, { left: paneLeft, right: request.maxWidth });
  if (!placed) return null;
  const extent = bandExtent({ ...placed, bandBounds: undefined }, request.band!.key, 0);
  return extent.left < 0 || extent.left + extent.width > request.maxWidth ? null : { ...placed, bandBounds: undefined };
}

function insertTree(request: LayoutRequest, previous: GraphLayout, budget: IncrementalBudget, paneEdges?: Scene["paneEdges"], policy: InsertionPolicy = "stable"): GraphLayout | null {
  const key = request.band!.key, s = spacingFor(request.tileWidth), wanted = new Set(request.items.map(n => n.key));
  if (request.items.length > INCREMENTAL_LIMIT || !wanted.has(key)) return null;
  if (!previous.nodes.has(key) || request.items.some(n => n.key !== key && n.parents.length === 0 && !previous.nodes.has(n.key))) return null;
  // Geometry beyond the lane index's reach (or not finite) cannot be searched in bounded time; lay out afresh.
  if (!inReach(request.maxWidth) || request.items.some(n => !inReach(n.width) || !inReach(n.height))) return null;
  const nodes = new Map<string, PlacedNode>();
  previous.nodes.forEach((node, id) => { if (wanted.has(id)) nodes.set(id, node); });
  for (const n of nodes.values()) if (!inReach(n.x) || !inReach(n.y) || !inReach(n.width) || !inReach(n.height)) return null;
  // Retained routes carry only their visible consumers; the junctions they touch stay.
  const visible = (c: { readonly parent: string; readonly child: string }) => wanted.has(c.parent) && wanted.has(c.child);
  const kept: PlacedRoute[] = [], routes: PlacedRoute[] = [], referenced = new Set<string>();
  for (const r of filterRouteConsumers(previous.routes, visible)) {
    if (!usableRetainedRoute(r)) return null;
    kept.push(r);
    routes.push(r);
    if (r.from.kind === "junction") referenced.add(r.from.id);
    if (r.to.kind === "junction") referenced.add(r.to.id);
  }
  const joins = new Map<string, PlacedJunction>();
  previous.junctions.forEach((join, id) => { if (referenced.has(id)) joins.set(id, join); });
  for (const id of referenced) { const j = joins.get(id); if (!j || !inReach(j.x) || !inReach(j.y)) return null; }
  if (!inReach(previous.width) || !inReach(previous.height)) return null;
  const lanes = new LaneIndex(retainedIndex(previous, kept), policy === "repairable");
  // Retained geometry beyond any real band (millions of pixels) cannot be indexed; lay out afresh.
  if (lanes.tooLarge()) return null;
  // Hidden outputs need one usable departure, without occupying both ports.
  // The same complete membership keeps future sources out of leaf reordering.
  const futureSources = futureSourcesOf(request.band?.items ?? request.items);
  const remaining = request.items.filter(n => !nodes.has(n.key));
  // Multi-parent nodes need more independent corridors. On a bounded retry, place
  // them before easier siblings; readiness below still enforces topological order.
  if (policy === "constrained") remaining.sort((a, b) => b.parents.length - a.parents.length || b.order - a.order || b.key.localeCompare(a.key));
  if (!remaining.length) return null;
  for (const node of nodes.values()) if (futureSources.has(node.key)) lanes.reserveDeparture(node);
  // Retained routes may already occupy channels outside the pane or the tile
  // envelope. Keep that certified allocation when extending the drawing.
  const width = Math.max(request.maxWidth, previous.width), cover = nodes.get(key)!;
  const coverStem = coverStemFor(request, cover);
  // Placed boxes in `nodes` order and their lowest edge, kept in step with `nodes` below.
  let boxes = [...nodes.values()], bottom = -Infinity, tiles = new TileIndex([...boxes]);
  for (const n of boxes) bottom = Math.max(bottom, n.y + n.height);
  const baseBottom = Math.max(previous.height, bottom);
  const header = (boxes.find(n => n.band === 0 && n.row === 0))?.height ?? 0;
  let grain = GRAIN;
  const sceneFor = (n: PlacedNode): Scene => {
    let bottomAbove = -Infinity;
    for (const b of boxes) if (b.y < n.y) bottomAbove = Math.max(bottomAbove, b.y + b.height);
    return { tiles, extra: n, width, paneEdges, clearance: s.clearance, header: header || (n.band === 0 && n.row === 0 ? n.height : 0), bottomAbove, cover: key, coverStem, grain };
  };
  let second: Effort | undefined;
  const plain = fallbackEffort(budget);
  // Each node gets at most 96 primary placement probes; fallback uses visible row corners and up to 32 columns. Order is topological, with stable sibling ties.
  while (remaining.length) {
    const index = remaining.findIndex(n => n.parents.every(p => nodes.has(p)));
    if (index < 0) return null;
    const [item] = remaining.splice(index, 1), parents = item.parents.map(p => nodes.get(p)!), parent = parents.reduce((a, b) => a.y + a.height > b.y + b.height ? a : b);
    const multi = parents.length > 1, levelCount = multi ? Math.max(1, Math.ceil((parents.length - 1) / 2)) : 0;
    // A junction's spine needs its levels' room above the default arrival gap.
    const arrivalGap = multi ? JOIN_ARRIVAL_GAP + LEVEL_GAP * (levelCount - 1) : 20;
    // Up to 32 distinct in-bounds columns, in candidate order (dedupe, filter, then truncate).
    const xs: number[] = [], seen = new Set<number>();
    const column = (x: number) => {
      if (xs.length >= 32 || seen.has(x)) return;
      seen.add(x);
      if (x >= 24 && x + item.width <= width - 24) xs.push(x);
    };
    column(parent.x + parent.width + s.column);
    // Beside a parent of another height the ports do not line up: the next column then leaves
    // room for the jog between them (a side lane and the arrowhead's approach), where the
    // column gap alone would put it on the parent's border.
    if (item.height !== parent.height) column(parent.x + parent.width + Math.max(s.column, SIDE_LANE + s.approach));
    column(parent.x); column(24); column(width - item.width - 24);
    for (const b of boxes) { column(b.x); column(b.x + b.width + s.column); }
    const ys = distinctValues3(Math.max(cover.height + STACK_STEM_ROOM, parent.y), Math.max(cover.height + STACK_STEM_ROOM, parent.y + parent.height + arrivalGap), bottom + arrivalGap);
    // Holes: the rows of placed tiles below the parent that a new tile fits in without adding
    // height (rows from index `base` of `ys`). At most HOLE_TRIES free holes are wired in vain.
    const base = ys.length, below = parent.y + parent.height + arrivalGap, holes = new Set<number>();
    for (const b of boxes) if (b.y >= below && b.y + item.height <= bottom && !ys.includes(b.y)) holes.add(b.y);
    ys.push(...[...holes].sort((a, b) => a - b).slice(0, HOLE_ROWS));
    // Every probe and slot has the item's height, so the boxes a row's tiles can overlap depend only on its y.
    const rows = new Map<number, PlacedNode[]>();
    const clear = (n: PlacedNode) => {
      let near = rows.get(n.y);
      if (!near) { const row = { y: n.y, height: n.height }; near = boxes.filter(b => overlapY(row, b, s.clearance)); rows.set(n.y, near); }
      for (const b of near) if (overlapX(n, b, s.clearance)) return false;
      return !lanes.hits(n) && !lanes.grazed(n);
    };
    const free = (n: PlacedNode) => parents.every(parent => n.x >= parent.x + parent.width || n.y >= parent.y + parent.height) && clear(n);
    // Rank every probe, then test freedom lazily: only probes up to the first routable one are
    // checked, and only those are wired. Probe p is (xs[p / ny], ys[p % ny]). A placement that
    // only a detour reaches (round other tiles, through the header or the outer gutters) is
    // taken only if no probe adding no more height has a direct route: a detour costs length
    // and turns, and the layout that holds still must not lose to a fresh one on them.
    const ny = ys.length, ranked = rankProbes(xs, ys, bottom, item.height);
    const probes = (): { node: PlacedNode; wiring: Wiring } | undefined => {
      const hardest = { index: 0 };
      let holeTries = HOLE_TRIES;
      // The first placement routed only by a detour, kept while probes adding no more height
      // are wired for a direct route (at most DETOUR_SCAN of them).
      let detoured: { readonly found: { node: PlacedNode; wiring: Wiring }; readonly reach: number } | undefined, scan = DETOUR_SCAN;
      for (const probe of ranked) {
        const x = xs[(probe - probe % ny) / ny], y = ys[probe % ny], hole = (probe % ny) >= base;
        if (hole && !holeTries) continue;
        const n: PlacedNode = { key: item.key, x, y, width: item.width, height: item.height, row: y === parent.y ? parent.row : parent.row + 1, band: parent.band + 1 };
        if (!free(n)) continue;
        if (detoured && (Math.max(bottom, n.y + n.height) > detoured.reach || !(scan-- > 0))) return detoured.found;
        if (!(budget.probes > 0)) return detoured?.found;
        budget.probes--;
        // Once a detour is in hand, only a direct route can replace it.
        const wiring = wire(parents, n, sceneFor(n), lanes, item.key, hardest, !!detoured);
        if (wiring && !wiring.routes.some(r => r.detour)) return { node: n, wiring };
        if (wiring) detoured ??= { found: { node: n, wiring }, reach: Math.max(bottom, n.y + n.height) };
        else {
          if (hole) holeTries--;
        }
      }
      return detoured?.found;
    };
    // Contacts are a hard constraint. A failed compact probe must search another
    // route or placement rather than returning an illegal connector for later rejection.
    let best = probes();
    if (!best) {
      const rowYs = [...new Set([Math.max(baseBottom, ...parents.map(p => p.y + p.height)) + arrivalGap,
        ...boxes.filter(n => n.y > baseBottom).map(n => n.y), Math.max(bottom, previous.height) + arrivalGap])].sort((a, b) => a - b);
      const slotXs = Array.from({ length: Math.min(32, Math.max(1, Math.floor((width - 48 + s.column) / (item.width + s.column)))) }, (_, i) => 24 + i * (item.width + s.column));
      const fallback = (effort: Effort): { node: PlacedNode; wiring: Wiring } | undefined => {
        let tried = 0;
        for (const y of rowYs) for (const x of slotXs) {
          const n: PlacedNode = { key: item.key, x, y, width: item.width, height: item.height, row: parent.row + 1, band: parent.band + 1 };
          if (!(parents.every(p => n.y >= p.y + p.height || n.x >= p.x + p.width) && clear(n))) continue;
          if (!(x >= 0 && x + item.width <= width) || tried++ >= effort.slots || !(left(effort) > 0)) return undefined;
          const wiring = gridWire(parents, n, sceneFor(n), lanes, item.key, effort);
          if (wiring) return { node: n, wiring };
        }
        return undefined;
      };
      // Once a tile needed the second chance, later tiles go to it directly: the scene has proved
      // too crowded for the plain fallback, and its failures cost as much as the second chance.
      best = second ? undefined : fallback(plain);
      if (!best) {
        // The second chance: the probes again on lanes half a step apart, then the grid router.
        const effort = second ??= secondChance(budget);
        grain = FINE_GRAIN;
        best = probes() ?? fallback(effort);
        grain = GRAIN;
      }
      if (!best) return null;
    }
    const placed = best.node;
    if (nodes.has(item.key)) { nodes.set(item.key, placed); boxes = [...nodes.values()]; tiles = new TileIndex([...boxes]); bottom = Math.max(...boxes.map(n => n.y + n.height)); }
    else { nodes.set(item.key, placed); boxes.push(placed); tiles.add(placed); bottom = Math.max(bottom, placed.y + placed.height); }
    commit(item.key, item.parents, parents, placed, best.wiring);
    if (futureSources.has(item.key)) lanes.reserveDeparture(placed);
  }

  /** Records a placed tile's routes, junctions and lanes. */
  function commit(child: string, parentKeys: readonly string[], parents: readonly PlacedNode[], placed: PlacedNode, wiring: Wiring): void {
    const lanePoints = (p: PlacedNode, points: readonly Point[]) => p.key === key ? coverStem(points) : points;
    if (!wiring.levels) {
      const p = parents[0], route = wiring.routes[0];
      routes.push({ id: JSON.stringify(["incremental", p.key, child]), from: { kind: "node", id: p.key }, to: { kind: "node", id: child },
        consumers: [{ parent: p.key, child }], terminal: true, path: path(route.points) });
      lanes.add(pathSegments(lanePoints(p, route.points)), sourceKey("node", p.key), INTO_TILE);
      return;
    }
    // Levels no parent reached are dropped; the spine runs through their points unchanged.
    const levels = wiring.levels, used = levels.map((_, level) => wiring.routes.some(r => r.arrival.level === level));
    const ids = levels.map((_, level) => JSON.stringify(["incremental-join", child, level]));
    const kept = levels.map((_, level) => level).filter(level => used[level]);
    /** One shared consumer table; descending entry levels make every spine a prefix. */
    const byLevel = Array.from({ length: levels.length }, () => [] as string[]);
    parentKeys.forEach((parent, i) => byLevel[wiring.routes[i].arrival.level].push(parent));
    const entries: { readonly parent: string; readonly child: string }[] = [];
    const prefixEnds = new Uint32Array(levels.length);
    for (let level = levels.length - 1; level >= 0; level--) {
      for (const parent of byLevel[level]) entries.push({ parent, child });
      prefixEnds[level] = entries.length;
    }
    const consumersAbove = (level: number) => ({ entries, start: 0, end: prefixEnds[level] });
    /** Junction metadata preserves the original parent order. */
    const above = (level: number) => parentKeys.filter((_, i) => wiring.routes[i].arrival.level >= level);
    parents.forEach((p, i) => {
      const route = wiring.routes[i];
      routes.push({ id: JSON.stringify(["incremental", p.key, child]), from: { kind: "node", id: p.key }, to: { kind: "junction", id: ids[route.arrival.level] },
        consumers: [{ parent: p.key, child }], terminal: false, path: path(route.points) });
      lanes.add(pathSegments(lanePoints(p, route.points)), sourceKey("node", p.key), INTO_JUNCTION);
    });
    for (const level of kept) { joins.set(ids[level], { id: ids[level], x: levels[level].x, y: levels[level].y, parents: above(level) }); lanes.addDot(levels[level]); }
    // Spine routes between consecutive kept levels, top down, then the tail from the lowest.
    for (let k = kept.length - 1; k > 0; k--) {
      const upper = kept[k], lower = kept[k - 1], from = levels[upper], to = levels[lower];
      routes.push({ id: JSON.stringify(["incremental-spine", ids[upper], ids[lower]]), from: { kind: "junction", id: ids[upper] }, to: { kind: "junction", id: ids[lower] },
        consumers: consumersAbove(upper), terminal: false, path: path([from, to]) });
      lanes.add(pathSegments([from, to]), sourceKey("junction", ids[upper]), DOT_TO_DOT);
    }
    const low = levels[kept[0]], end = point(low.x, placed.y - ARROW.length);
    routes.push({ id: JSON.stringify(["incremental-tail", ids[kept[0]], child]), from: { kind: "junction", id: ids[kept[0]] }, to: { kind: "node", id: child },
      consumers: { entries, start: 0, end: entries.length }, terminal: true, path: path([low, end]) });
    lanes.add(pathSegments([low, end]), sourceKey("junction", ids[kept[0]]), SPINE);
  }

  const readingOrder = new Map<string, number>();
  for (let i = 0; i < request.items.length; i++) readingOrder.set(request.items[i].key, i);
  const provisional: GraphLayout = { ...previous, nodes, routes, junctions: joins, rows: [],
    width: Math.max(previous.width, width), height: bottom + s.bottom,
    readingOrder };
  return orderNewSiblingLeaves(provisional, request.items, previous.nodes, futureSources);
}
