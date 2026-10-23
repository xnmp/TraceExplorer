/**
 * Free-space world insertion (routing slice 5c, T37): an arrival's new tiles
 * as ordered rectangles in the folder's world frame, with every retained world
 * rectangle a constant.
 *
 * Every retained tile, ordinary cell footprint, junction dot and connector run
 * is an obstacle from the start; none of them moves. This is one-dimensional
 * compaction against fixed obstacles (ELK's rectangle packing and
 * `OneDimensionalCompactor`; scanline constraint graphs in VLSI compaction):
 * 1. **Discrete choice.** Each new tile takes one rectangle from the corners of
 *    the free space: aligned with an obstacle's edge or the pane, or one gap
 *    beyond it. Candidates are ranked by the height they add, then by the
 *    Manhattan length of their connector.
 * 2. **Topology.** The connector's corridor sequence comes from the rectilinear
 *    visibility grid of the obstacles (`orthogonalRoute`): it may cross another
 *    source's run, never run along it.
 * 3. **Metric solve.** Each interior run is a coordinate with bounds: its
 *    channel between the obstacles beside it, its neighbours' directions and
 *    the arrow's straight approach. The separation solve centres it in that
 *    channel (`solveSeparation`).
 * 4. **Emission.** The shared stem emitter rounds the corners (`roundedStem`).
 *
 * The generator only proposes. The caller certifies each complete folder with
 * the unchanged folder gate and the retained-rectangle check, and nothing else
 * is ever published. Several parents meet at one dot above the tile.
 */
import { orthogonalRoute, type AxisRun } from '../orthogonal-route';
import { solveSeparation, type CoordinateVariable } from '../separation';
import { roundedStem } from '../band-geometry';
import { importedRoute } from '../routing-plan';
import { edgeKey } from '../junctions';
import { ARROW, LANE_SEPARATION } from '../metrics';
import { JUNCTION_RADIUS, JUNCTION_STROKE_WIDTH } from '../connector-ink';
import { TILE_GRAZE } from '../route-contacts';
import type { GraphLayout, LayoutItem, PlacedNode, PlacedRoute } from '../layout';
import type { Point } from '../path-sampling';

export interface FreeSpaceRequest {
  /** Every item of the world request; parents name world keys. */
  readonly items: readonly LayoutItem[];
  /** The world drawing: retained tiles, cells, dots and routes, all constants. */
  readonly drawing: GraphLayout;
  /** Legal x range of ink in the world frame. */
  readonly pane: { readonly left: number; readonly right: number };
  /** Drawing keys that are not obstacles (the world request's neutral anchor). */
  readonly exclude?: ReadonlySet<string>;
  /** First-tile rectangles to propose at most. */
  readonly limit?: number;
}

/** Clear distance from a new tile to any obstacle, the grid's own column gap. */
export const FREE_SPACE_GAP = 8;
/** Room between a parent's bottom and a child's top for a turn and the arrow's approach. */
const ARRIVAL_GAP = 20;
/** Straight run the connector keeps above the arrowhead: the gate's terminal run. */
const APPROACH = ARROW.length;
/** A connector's centreline stays this far from every tile; the gate's graze distance. */
const CLEAR = TILE_GRAZE;
const DOT = JUNCTION_RADIUS + JUNCTION_STROKE_WIDTH / 2;
/** Grid points one connector search may expand. */
const ROUTE_BUDGET = 20_000;
/** Extra drop that leaves a connector room to jog sideways below its parent. */
const JOG = 16;
const EPS = 1e-6;
/** Parallel connectors of different sources stay one lane apart (`LANE_SEPARATION`). */
const LANE = LANE_SEPARATION;
/** A meeting's dot sits this far above the arrow's tip: its stem into the tile. */
const JOIN_STEM = 12;
/** Inputs curve into the dot over this drop, after a straight descent of `FAN_APPROACH`. */
const FAN_DROP = 6;
const FAN_APPROACH = 3;
/** Inputs one meeting takes: lanes one separation apart must stay within the dot's fan. */
const MAX_INPUTS = 5;
/** Obstacles the generator takes on; a larger world declines rather than spend cubic work. */
export const MAX_OBSTACLES = 320;
/** Rectangles one tile tries to connect, best first: each try is one corridor search. */
const MAX_TRIES = 48;
/** Rectangle positions one tile considers, nearest rows first. */
const MAX_POSITIONS = 4096;

/** An obstacle; `source` names the connector source whose ink it is (the same source may share it). */
type Box = Pick<PlacedNode, 'x' | 'y' | 'width' | 'height'> & { readonly key?: string; readonly source?: string };
type Run = AxisRun & { readonly source?: string };
const separated = (a: Box, b: Box, gap: number) => a.x + a.width + gap <= b.x + EPS || b.x + b.width + gap <= a.x + EPS
  || a.y + a.height + gap <= b.y + EPS || b.y + b.height + gap <= a.y + EPS;

/** Axis-parallel runs of a polyline (curve samples are not runs). */
function runsOf(points: readonly Point[], source?: string): { horizontal: Run[]; vertical: Run[] } {
  const horizontal: Run[] = [], vertical: Run[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.y - b.y) <= EPS && Math.abs(a.x - b.x) > EPS) horizontal.push({ at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), source });
    else if (Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) > EPS) vertical.push({ at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), source });
  }
  return { horizontal, vertical };
}

/** Collinear interior points removed; consecutive duplicates dropped. */
function corners(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) <= EPS && Math.abs(last.y - p.y) <= EPS) continue;
    const before = out.at(-2);
    if (last && before && ((Math.abs(before.x - last.x) <= EPS && Math.abs(last.x - p.x) <= EPS)
      || (Math.abs(before.y - last.y) <= EPS && Math.abs(last.y - p.y) <= EPS))) out.pop();
    out.push(p);
  }
  return out;
}

interface Scene { readonly boxes: Box[]; readonly lanes: { horizontal: Run[]; vertical: Run[] } }
const sourceOf = (route: PlacedRoute): string => route.from.id;
/** The scene a connector from `source` sees: another source's ink only. */
const foreignTo = (scene: Scene, source: string): Scene => ({ boxes: scene.boxes.filter(b => b.source !== source),
  lanes: { horizontal: scene.lanes.horizontal.filter(r => r.source !== source), vertical: scene.lanes.vertical.filter(r => r.source !== source) } });

/** Whether a run from a to b keeps `CLEAR` from every box and never runs along a foreign lane. */
function runClear(a: Point, b: Point, scene: Scene, ignore: readonly Box[]): boolean {
  const skip = new Set(ignore.map(box => box.key));
  const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, hi = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
  for (const box of scene.boxes) {
    if (box.key !== undefined && skip.has(box.key)) continue;
    if (lo.x < box.x + box.width + CLEAR - EPS && hi.x > box.x - CLEAR + EPS
      && lo.y < box.y + box.height + CLEAR - EPS && hi.y > box.y - CLEAR + EPS) return false;
  }
  const horizontal = Math.abs(a.y - b.y) <= EPS;
  for (const run of horizontal ? scene.lanes.horizontal : scene.lanes.vertical) {
    const at = horizontal ? a.y : a.x, [s, e] = horizontal ? [lo.x, hi.x] : [lo.y, hi.y];
    if (Math.abs(run.at - at) < 3 - EPS && s < run.hi - EPS && run.lo < e - EPS) return false;
  }
  return true;
}

/**
 * Centre interior runs in their channels. A run's coordinate is bounded by the
 * nearest obstacle on either side over its span, by its neighbours' directions
 * and, before the end, by the straight approach `approach`. Runs are solved one
 * at a time in path order; a move that would make any adjacent run unclear is not taken.
 */
function centred(points: readonly Point[], scene: Scene, parent: Box, end: Box, approach: number): Point[] {
  const out = points.map(p => ({ ...p }));
  for (let k = 1; k + 2 < out.length; k++) {
    const a = out[k], b = out[k + 1], before = out[k - 1], after = out[k + 2];
    const horizontal = Math.abs(a.y - b.y) <= EPS, at = horizontal ? a.y : a.x;
    const [s, e] = horizontal ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    let lower = -Infinity, upper = Infinity;
    for (const box of scene.boxes) {
      const [bs, be, b0, b1] = horizontal ? [box.x, box.x + box.width, box.y, box.y + box.height] : [box.y, box.y + box.height, box.x, box.x + box.width];
      if (!(s < be + CLEAR && bs - CLEAR < e)) continue;
      if (b1 <= at + EPS) lower = Math.max(lower, b1); else if (b0 >= at - EPS) upper = Math.min(upper, b0);
    }
    for (const run of horizontal ? scene.lanes.horizontal : scene.lanes.vertical) {
      if (!(s < run.hi && run.lo < e)) continue;
      if (run.at <= at + EPS) lower = Math.max(lower, run.at + LANE); else upper = Math.min(upper, run.at - LANE);
    }
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
    // Neighbours keep their direction and some length; the end keeps its approach.
    const prev = horizontal ? before.y : before.x, next = horizontal ? after.y : after.x;
    let low = lower + CLEAR + 1, high = upper - CLEAR - 1;
    for (const end of [prev, next]) { if (end < at) low = Math.max(low, end + 2); else high = Math.min(high, end - 2); }
    if (horizontal && k + 3 === out.length) high = Math.min(high, out.at(-1)!.y - approach);
    if (horizontal && k === 1) low = Math.max(low, parent.y + parent.height + 2);
    if (!(low <= high)) continue;
    const variable: CoordinateVariable = { id: 'run', preferred: (lower + upper) / 2, bounds: { lower: low, upper: high } };
    const solved = solveSeparation({ variables: [variable], order: ['run'], separations: [] });
    if (!solved.ok) continue;
    const value = Math.round(solved.positions.get('run')! * 2) / 2;
    const moved = out.map(p => ({ ...p }));
    if (horizontal) { moved[k].y = value; moved[k + 1].y = value; } else { moved[k].x = value; moved[k + 1].x = value; }
    const touched = [k - 1, k, k + 1];
    if (touched.every(i => runClear(moved[i], moved[i + 1], scene, i === 0 ? [parent] : i + 2 === moved.length ? [end] : []))) out.splice(0, out.length, ...moved);
  }
  return out;
}

/**
 * A connector from `parent`'s bottom port to `end`, arriving straight down for at
 * least `approach`. `box` is the tile or dot the connector ends at; it is an
 * obstacle everywhere but on the final run. Rounded, unless the final corner's
 * fillet would shorten the approach below `approach`.
 */
function connector(parent: PlacedNode, end: Point, box: Box, approach: number, all: Scene, pane: FreeSpaceRequest['pane']): string | null {
  const scene = foreignTo(all, parent.key);
  const port = { x: parent.x + parent.width / 2, y: parent.y + parent.height };
  const start = { x: port.x, y: port.y + CLEAR }, goal = { x: end.x, y: end.y - approach };
  if (goal.y <= start.y) return null;
  const boxes = [...scene.boxes, box].map(b => ({ ...b, key: '', band: 0, row: 0 }));
  const found = orthogonalRoute(start, goal, boxes, pane.right, scene.lanes, { budget: ROUTE_BUDGET, bounds: { left: pane.left + 1, right: pane.right - 1 } });
  if (!found) return null;
  const sharp = corners([port, ...found, end]);
  const local: Scene = { boxes: [...scene.boxes, box], lanes: scene.lanes };
  for (let i = 1; i < sharp.length; i++) if (!runClear(sharp[i - 1], sharp[i], local, i === 1 ? [parent] : i + 1 === sharp.length ? [box] : [])) return null;
  const last = sharp.at(-1)!, previous = sharp.at(-2)!;
  if (Math.abs(last.x - previous.x) > EPS || last.y - previous.y < approach - EPS) return null;
  const path = centred(sharp, local, parent, box, approach), tip = path.at(-1)!;
  return roundedStem(path, (_before, corner, after) => after.x === tip.x && after.y === tip.y ? Math.max(0, Math.hypot(after.x - corner.x, after.y - corner.y) - approach) : Infinity);
}

/** Candidate rectangles for a `w`×`h` tile below `parents`, best first. */
function rectangles(parents: readonly PlacedNode[], w: number, h: number, scene: Scene, pane: FreeSpaceRequest['pane'], bottom: number): Box[] {
  // A meeting needs its stem, its fan and one horizontal track per input above the dot.
  const lowest = Math.max(...parents.map(p => p.y + p.height)),
    meeting = parents.length > 1 ? JOIN_STEM + FAN_DROP + FAN_APPROACH + parents.length * (LANE + 1) : 0;
  const portX = parents.reduce((sum, p) => sum + p.x + p.width / 2, 0) / parents.length;
  const xs = new Set<number>([portX - w / 2, pane.left, pane.right - w]);
  // Directly below the parents, and one or two tracks lower for a connector that must jog.
  const ys = new Set<number>([0, JOG, 2 * JOG].flatMap(extra => [lowest + ARRIVAL_GAP + meeting + extra, bottom + ARRIVAL_GAP + meeting + extra]));
  for (const p of parents) xs.add(p.x + (p.width - w) / 2);
  for (const b of scene.boxes) {
    xs.add(b.x); xs.add(b.x + b.width - w); xs.add(b.x + b.width + FREE_SPACE_GAP); xs.add(b.x - FREE_SPACE_GAP - w);
    ys.add(b.y); ys.add(b.y + b.height + ARRIVAL_GAP + meeting);
  }
  const out: { box: Box; key: readonly number[] }[] = [];
  let positions = 0;
  for (const y of [...ys].sort((a, b) => a - b)) {
    if (!(y >= lowest + ARRIVAL_GAP + meeting - EPS)) continue;
    for (const x of xs) {
      if (++positions > MAX_POSITIONS) break;
      if (!(x >= pane.left - EPS && x + w <= pane.right + EPS)) continue;
      const box = { x, y, width: w, height: h };
      if (!scene.boxes.every(b => separated(box, b, FREE_SPACE_GAP))) continue;
      const length = parents.reduce((sum, p) => sum + Math.abs(x + w / 2 - p.x - p.width / 2) + (y - p.y - p.height), 0);
      out.push({ box, key: [Math.max(0, y + h - bottom), length, y, x] });
    }
  }
  const lexical = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  return out.sort((a, b) => lexical(a.key, b.key)).map(c => c.box);
}

function sceneOf(drawing: GraphLayout, exclude: ReadonlySet<string>): Scene {
  const boxes: Box[] = [];
  for (const [key, n] of drawing.nodes) if (!exclude.has(key)) boxes.push({ key, x: n.x, y: n.y, width: n.width, height: n.height });
  for (const dot of drawing.junctions.values()) boxes.push({ x: dot.x - DOT, y: dot.y - DOT, width: 2 * DOT, height: 2 * DOT });
  const lanes = { horizontal: [] as Run[], vertical: [] as Run[] };
  for (const route of drawing.routes) {
    const runs = runsOf(importedRoute(route).points, sourceOf(route));
    lanes.horizontal.push(...runs.horizontal); lanes.vertical.push(...runs.vertical);
    boxes.push(...cornerBoxes(route));
  }
  return { boxes, lanes };
}

/**
 * Where a connector turns or ends, another source's ink keeps a lane's distance in every
 * direction (the gate's corner probe). A crossing elsewhere is transverse and allowed.
 */
function cornerBoxes(route: PlacedRoute, end = true): Box[] {
  const points = importedRoute(route).points, out: Box[] = [];
  const source = sourceOf(route), at = (p: Point) => out.push({ x: p.x - LANE, y: p.y - LANE, width: 2 * LANE, height: 2 * LANE, source });
  if (!points.length) return out;
  at(points[0]); if (end) at(points.at(-1)!);
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i - 1], p = points[i], b = points[i + 1];
    if (Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > EPS) at(p);
  }
  return out;
}

interface Inserted { readonly drawing: GraphLayout; readonly scene: Scene }
const withRuns = (scene: Scene, routes: readonly PlacedRoute[], boxes: readonly Box[]): Scene => {
  const lanes = { horizontal: [...scene.lanes.horizontal], vertical: [...scene.lanes.vertical] };
  const corners: Box[] = [];
  for (const route of routes) { const runs = runsOf(importedRoute(route).points, sourceOf(route)); lanes.horizontal.push(...runs.horizontal); lanes.vertical.push(...runs.vertical); corners.push(...cornerBoxes(route)); }
  return { boxes: [...scene.boxes, ...boxes, ...corners], lanes };
};

/**
 * One new tile placed in `box` with its connectors, or null when no corridor reaches it.
 * A single parent connects into the tile's top port. Several parents meet at one dot
 * above it, as the layered solve draws a meeting: inputs, ordered by their port's x,
 * descend one lane apart and curve into the dot, and one stem leaves it for the tile.
 */
function insert(drawing: GraphLayout, scene: Scene, item: LayoutItem, box: Box, pane: FreeSpaceRequest['pane']): Inserted | null {
  const parents = [...new Set(item.parents)].map(key => drawing.nodes.get(key)!);
  const child: PlacedNode = { key: item.key, x: box.x, y: box.y, width: item.width, height: item.height,
    row: Math.max(...parents.map(p => p.row)) + 1, band: parents[0].band };
  const cx = child.x + child.width / 2, tip = { x: cx, y: child.y - ARROW.length };
  const nodes = new Map(drawing.nodes); nodes.set(child.key, child);
  const done = (routes: PlacedRoute[], junctions: GraphLayout['junctions'], dots: Box[]): Inserted => ({
    drawing: { ...drawing, nodes, junctions, routes: [...drawing.routes, ...routes], height: Math.max(drawing.height, child.y + child.height) },
    scene: withRuns({ ...scene, boxes: [...scene.boxes, ...dots] }, routes, [child]) });
  if (parents.length === 1) {
    const [parent] = parents, path = connector(parent, tip, child, APPROACH, scene, pane);
    if (!path) return null;
    return done([{ id: edgeKey({ kind: 'node', id: parent.key }, { kind: 'node', id: child.key }),
      from: { kind: 'node', id: parent.key }, to: { kind: 'node', id: child.key },
      consumers: [{ parent: parent.key, child: child.key }], terminal: true, path }], drawing.junctions, []);
  }
  if (parents.length > MAX_INPUTS) return null;
  const dot = { x: cx, y: tip.y - JOIN_STEM }, id = JSON.stringify(['free-space-junction', child.key]);
  const dotBox: Box = { x: dot.x - DOT, y: dot.y - DOT, width: 2 * DOT, height: 2 * DOT };
  const ordered = [...parents].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2) || (a.key < b.key ? -1 : 1));
  // Lanes one separation apart, symmetric about the dot (an odd count has one straight in).
  const offsets = ordered.map((_, i) => ordered.length % 2 ? i - (ordered.length - 1) / 2 : i < ordered.length / 2 ? i - ordered.length / 2 : i - ordered.length / 2 + 1);
  const span = LANE * Math.max(...offsets.map(Math.abs));
  // The fan and the stem need their whole region free of other obstacles.
  const fan = { x: cx - span - CLEAR, y: dot.y - FAN_DROP - FAN_APPROACH, width: 2 * (span + CLEAR), height: child.y - (dot.y - FAN_DROP - FAN_APPROACH) };
  if (!scene.boxes.every(b => separated(fan, b, 0))) return null;
  const routes: PlacedRoute[] = [];
  let current: Scene = { ...scene, boxes: [...scene.boxes, child] };
  for (const [i, parent] of ordered.entries()) {
    // Each lane curves into the dot over FAN_DROP.
    const lane = cx + LANE * offsets[i], entry = { x: lane, y: dot.y - FAN_DROP };
    const lead = connector(parent, entry, dotBox, FAN_APPROACH, current, pane);
    if (!lead) return null;
    const path = Math.abs(lane - cx) <= EPS ? `${lead} L${dot.x} ${dot.y}`
      : `${lead} C${lane} ${dot.y - FAN_DROP / 2} ${dot.x} ${dot.y - FAN_DROP / 2} ${dot.x} ${dot.y}`;
    const route: PlacedRoute = { id: edgeKey({ kind: 'node', id: parent.key }, { kind: 'junction', id }),
      from: { kind: 'node', id: parent.key }, to: { kind: 'junction', id }, consumers: [{ parent: parent.key, child: child.key }], terminal: false, path };
    routes.push(route);
    // Inputs of one meeting converge on purpose: later inputs avoid this one's lead, not its fan into the dot.
    const leadBox = cornerBoxes({ ...route, path: lead }, false);
    current = withRuns({ ...current, boxes: [...current.boxes, ...leadBox] }, [], []);
    const runs = runsOf(importedRoute({ ...route, path: lead }).points, sourceOf(route));
    current = { ...current, lanes: { horizontal: [...current.lanes.horizontal, ...runs.horizontal], vertical: [...current.lanes.vertical, ...runs.vertical] } };
  }
  routes.push({ id: edgeKey({ kind: 'junction', id }, { kind: 'node', id: child.key }), from: { kind: 'junction', id }, to: { kind: 'node', id: child.key },
    consumers: ordered.map(p => ({ parent: p.key, child: child.key })), terminal: true, path: `M${dot.x} ${dot.y} L${tip.x} ${tip.y}` });
  const junctions = new Map(drawing.junctions);
  junctions.set(id, { id, x: dot.x, y: dot.y, parents: ordered.map(p => p.key) });
  return done(routes, junctions, [dotBox]);
}

/**
 * Complete drawings with every missing item placed in free space, best first.
 * Later tiles of a multi-tile arrival take their best rectangle greedily.
 * Yields nothing for a root item, a parent that is absent, more than `MAX_INPUTS` parents,
 * or a world of more than `MAX_OBSTACLES` obstacles.
 */
export function* freeSpaceInsertions(request: FreeSpaceRequest): Generator<GraphLayout> {
  const { drawing, pane } = request, exclude = request.exclude ?? new Set<string>();
  const missing = request.items.filter(item => !drawing.nodes.has(item.key));
  if (!missing.length) return;
  // Topological order over the missing items; each needs exactly one parent.
  const order: LayoutItem[] = [], placed = new Set(drawing.nodes.keys()), pending = [...missing];
  while (pending.length) {
    const index = pending.findIndex(item => item.parents.every(p => placed.has(p)));
    if (index < 0) return;
    const [item] = pending.splice(index, 1);
    if (!item.parents.length) return;
    if (![item.width, item.height].every(v => Number.isFinite(v) && v > 0)) return;
    order.push(item); placed.add(item.key);
  }
  const base = sceneOf(drawing, exclude);
  if (base.boxes.length > MAX_OBSTACLES) return;
  const bottomOf = (scene: Scene) => scene.boxes.reduce((max, b) => Math.max(max, b.y + b.height), 0);
  const [first, ...rest] = order;
  const parentsOf = (layout: GraphLayout, item: LayoutItem) => [...new Set(item.parents)].map(key => layout.nodes.get(key)!);
  let proposed = 0, tried = 0;
  for (const box of rectangles(parentsOf(drawing, first), first.width, first.height, base, pane, bottomOf(base))) {
    if (proposed >= (request.limit ?? 12) || ++tried > MAX_TRIES) return;
    const placedFirst = insert(drawing, base, first, box, pane);
    if (!placedFirst) continue;
    proposed++;
    let step: Inserted | null = placedFirst;
    for (const item of rest) {
      const current: Inserted = step;
      let next: Inserted | null = null;
      for (const candidate of rectangles(parentsOf(current.drawing, item), item.width, item.height, current.scene, pane, bottomOf(current.scene)).slice(0, MAX_TRIES)) {
        next = insert(current.drawing, current.scene, item, candidate, pane);
        if (next) break;
      }
      step = next;
      if (!step) break;
    }
    if (step) yield step.drawing;
  }
}
