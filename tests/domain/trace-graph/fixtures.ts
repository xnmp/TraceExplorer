import type { NodeKey, NodeScope, TraceNode } from "$lib/domain/trace-graph/model";
import type { GraphLayout } from "$lib/domain/trace-graph/layout";
import type { JunctionPlan } from "$lib/domain/trace-graph/junctions";
import { endpointKey } from "$lib/domain/trace-graph/junctions";

let counter = 0;
export function node(key: NodeKey, parents: NodeKey[] = [], scope: NodeScope = "current", extra: Partial<TraceNode> = {}): TraceNode {
  counter += 1;
  return {
    key, parents, scope, artifactId: counter, runId: parents.length ? counter : null, path: `/pictures/${key}.png`,
    location: `./${key}.png`, state: "present", temporary: false, discarded: false, earlierRevision: false,
    order: extra.order ?? counter, prompt: key, ...extra,
  };
}

/** The mockup's sample folder: four components plus the input-combination contract set. */
export function mockupNodes(): TraceNode[] {
  return [
    node("village"), node("palette"), node("mist-ref", [], "subfolder"), node("lantern-ref", [], "external"),
    node("daylight", ["village"]), node("warm", ["village", "palette", "mist-ref", "lantern-ref"]), node("cool", ["palette"]),
    node("morning", ["daylight"]), node("sunny", ["daylight"]), node("evening", ["warm"]), node("rain", ["warm"]),
    node("merge", ["daylight", "warm"], "current", { temporary: true }), node("quiet", ["rain"]),
    node("forest"), node("forest-mist", ["forest"]), node("autumn", ["forest"]), node("forest-dawn", ["forest-mist"]),
    node("forest-merge", ["forest-mist", "autumn"]), node("forest-night", ["autumn"]),
    node("a"), node("b"), node("c"), node("d", ["a", "b", "c"]), node("e", ["a", "b"]), node("f", ["b", "c"]),
    node("g", ["a", "c"]), node("h", ["a", "b"]), node("i", ["d", "a"]), node("k", ["a", "b", "c"]),
  ];
}

const incomingByRoutes = new WeakMap<object, Map<string, string[]>>();
/** Edges into each endpoint, built once per route list (callers ask for every node of one layout). */
function incomingEdges(routes: JunctionPlan["routes"]): Map<string, string[]> {
  const cached = incomingByRoutes.get(routes);
  if (cached) return cached;
  const incoming = new Map<string, string[]>();
  // A trunk (to === from) is drawing shared by routes, not an edge.
  for (const route of routes) if (endpointKey(route.from) !== endpointKey(route.to)) incoming.set(endpointKey(route.to), [...(incoming.get(endpointKey(route.to)) ?? []), endpointKey(route.from)]);
  incomingByRoutes.set(routes, incoming);
  return incoming;
}

/** Node endpoints from which some route chain reaches `child`. */
export function sourcesReaching(plan: Pick<JunctionPlan, "routes">, child: NodeKey): Set<NodeKey> {
  const incoming = incomingEdges(plan.routes);
  const seen = new Set<string>();
  const pending = [`node:${child}`];
  const sources = new Set<NodeKey>();
  while (pending.length) {
    const id = pending.pop()!;
    for (const from of incoming.get(id) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      if (from.startsWith("node:")) sources.add(from.slice(5)); else pending.push(from);
    }
  }
  return sources;
}

type Point = { x: number; y: number };
/** Samples an SVG path made of M, L and C commands. */
export function samplePath(path: string, steps = 24): Point[] {
  const tokens = path.match(/[MLC]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  const points: Point[] = [];
  let current: Point = { x: 0, y: 0 };
  let index = 0;
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === "M" || command === "L") {
      const target = { x: next(), y: next() };
      if (command === "L") for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        points.push({ x: current.x + (target.x - current.x) * t, y: current.y + (target.y - current.y) * t });
      } else points.push(target);
      current = target;
    } else if (command === "C") {
      const c1 = { x: next(), y: next() }, c2 = { x: next(), y: next() }, end = { x: next(), y: next() };
      for (let step = 1; step <= steps; step++) {
        const t = step / steps, u = 1 - t;
        points.push({
          x: u * u * u * current.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * current.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        });
      }
      current = end;
    } else throw new Error(`Unexpected path token ${command}`);
  }
  return points;
}

function bounds(points: readonly Point[]) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { x, y } of points) {
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  }
  return box;
}

/** Route points that fall inside a tile other than the route's own endpoints. */
export function routeCollisions(layout: GraphLayout): string[] {
  const problems: string[] = [];
  for (const route of layout.routes) {
    const own = new Set([route.from.kind === "node" ? route.from.id : "", route.to.kind === "node" ? route.to.id : ""]);
    const points = samplePath(route.path);
    // Only tiles whose box meets the route's bounding box can contain a sample.
    const box = bounds(points);
    const tiles = [...layout.nodes.values()].filter((tile) => !own.has(tile.key) && tile.x < box.maxX && tile.x + tile.width > box.minX && tile.y < box.maxY && tile.y + tile.height > box.minY);
    for (const point of points) {
      for (const tile of tiles) {
        if (point.x > tile.x + 0.5 && point.x < tile.x + tile.width - 0.5 && point.y > tile.y + 0.5 && point.y < tile.y + tile.height - 0.5) {
          problems.push(`${route.id} crosses ${tile.key} at ${point.x.toFixed(1)},${point.y.toFixed(1)}`);
        }
      }
    }
  }
  return problems;
}

/** Routes passing within `distance` of a junction they neither start nor end at (reads as an extra input). */
export function foreignJunctionContacts(layout: GraphLayout, distance: number): string[] {
  const problems: string[] = [];
  for (const route of layout.routes) {
    const points = samplePath(route.path, 60);
    const box = bounds(points);
    for (const junction of layout.junctions.values()) {
      if (route.from.id === junction.id || route.to.id === junction.id) continue;
      // Beyond `distance` of the route's bounding box, no sample can be close enough.
      if (junction.x < box.minX - distance || junction.x > box.maxX + distance || junction.y < box.minY - distance || junction.y > box.maxY + distance) continue;
      const closest = points.reduce((best, point) => Math.min(best, Math.hypot(point.x - junction.x, point.y - junction.y)), Infinity);
      if (closest < distance) problems.push(`${route.id} passes ${closest.toFixed(1)}px from ${junction.id}`);
    }
  }
  return problems;
}

/**
 * Runs along the flow (vertical when generations run down, horizontal when
 * they run right) of routes with different sources and destinations that
 * share a lane (merged lanes). Coordinates below are flow-relative: `x`
 * across the flow, `y` along it.
 */
export function sharedLanes(layout: GraphLayout): string[] {
  const runs: { x: number; top: number; bottom: number; route: GraphLayout["routes"][number] }[] = [];
  const sideways = layout.orientation === "right";
  for (const route of layout.routes) {
    const tokens = route.path.match(/[MLC]|-?\d+(?:\.\d+)?/g) ?? [];
    let x = 0, y = 0;
    for (let index = 0; index < tokens.length;) {
      const command = tokens[index++];
      const values = tokens.slice(index, index + (command === "C" ? 6 : 2)).map(Number);
      index += values.length;
      const [first, second] = values.slice(-2);
      const [nextX, nextY] = sideways ? [second, first] : [first, second];
      if (command === "L" && Math.abs(nextX - x) < 0.01 && Math.abs(nextY - y) > 1) runs.push({ x, top: Math.min(y, nextY), bottom: Math.max(y, nextY), route });
      x = nextX; y = nextY;
    }
  }
  const problems: string[] = [];
  // Only runs less than 1 px apart across the flow can share a lane: sweep them in order of `x`.
  runs.sort((a, b) => a.x - b.x);
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length && runs[j].x - runs[i].x < 1; j++) {
    const a = runs[i], b = runs[j];
    if (endpointKey(a.route.from) === endpointKey(b.route.from) || endpointKey(a.route.to) === endpointKey(b.route.to)) continue;
    if (Math.abs(a.x - b.x) < 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4) problems.push(`${a.route.id} and ${b.route.id} share x=${a.x}`);
  }
  return problems;
}

export function tileOverlaps(layout: GraphLayout): string[] {
  const tiles = [...layout.nodes.values()];
  const problems: string[] = [];
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j];
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) problems.push(`${a.key} overlaps ${b.key}`);
  }
  return problems;
}

/** Deterministic pseudo-random generator for property tests. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

/** Position along the flow (y running down, x running right) and across it. */
const along = (layout: GraphLayout, point: Point) => layout.orientation === "right" ? point.x : point.y;
const across = (layout: GraphLayout, point: Point) => layout.orientation === "right" ? point.y : point.x;

/** The last two points of a path and the command that joins them. */
function finalSegment(path: string): { command: string; from: Point; to: Point } | null {
  const commands = [...path.matchAll(/([MLC])([^MLC]*)/g)].map(([, command, body]) => {
    const numbers = (body.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    return { command, end: { x: numbers.at(-2)!, y: numbers.at(-1)! } };
  });
  if (commands.length < 2) return null;
  return { command: commands.at(-1)!.command, from: commands.at(-2)!.end, to: commands.at(-1)!.end };
}

/**
 * Terminal routes whose end is not a straight stem for the arrowhead: the
 * path must end in a straight segment perpendicular to the target tile's
 * entry edge (vertical running down, horizontal running right), heading into
 * the tile, at least `arrow` long, and stop `arrow` short of that edge, level
 * with the edge's middle (so the arrowhead, `arrow` long, ends on it).
 */
export function arrowStemProblems(layout: GraphLayout, arrow: number): string[] {
  const problems: string[] = [];
  for (const route of layout.routes) {
    if (!route.terminal) continue;
    const tile = layout.nodes.get(route.to.id);
    const segment = finalSegment(route.path);
    if (!tile || !segment) { problems.push(`${route.id}: no target or final segment`); continue; }
    const { command, from, to } = segment;
    const edge = layout.orientation === "right" ? tile.x : tile.y;
    const middle = layout.orientation === "right" ? tile.y + tile.height / 2 : tile.x + tile.width / 2;
    const length = along(layout, to) - along(layout, from);
    if (command !== "L") problems.push(`${route.id}: ends in ${command}, not a straight segment`);
    if (Math.abs(across(layout, to) - across(layout, from)) > 0.01) problems.push(`${route.id}: final segment is not perpendicular to the tile edge`);
    if (length < arrow - 0.01) problems.push(`${route.id}: final segment is ${length.toFixed(2)} px, shorter than the ${arrow} px arrowhead`);
    if (Math.abs(along(layout, to) + arrow - edge) > 0.01) problems.push(`${route.id}: arrowhead tip lands at ${(along(layout, to) + arrow).toFixed(2)}, tile edge at ${edge}`);
    if (Math.abs(across(layout, to) - middle) > 0.01) problems.push(`${route.id}: arrives off the middle of the tile edge`);
  }
  return problems;
}

export interface Channel { readonly between: string; readonly gap: number; readonly betweenBands: boolean; readonly levels: number; readonly routes: number }

/**
 * Every channel between consecutive display rows, along the flow: its height,
 * whether it separates generations, how many junction levels it holds and how
 * many drawn routes run through it (each crosses a channel at most once, and
 * draws each stretch only once, so this bounds the bends it holds).
 */
export function channels(layout: GraphLayout): Channel[] {
  const sampled = layout.routes.map((route) => samplePath(route.path, 12));
  return layout.rows.slice(1).map((row, index) => {
    const above = layout.rows[index];
    const inside = (value: number) => value > above.bottom + 0.5 && value < row.top - 0.5;
    const levels = new Set([...layout.junctions.values()].map((junction) => along(layout, junction)).filter(inside).map((value) => Math.round(value)));
    const routes = sampled.filter((points) => points.some((point) => inside(along(layout, point)))).length;
    return { between: `rows ${above.index}-${row.index}`, gap: row.top - above.bottom, betweenBands: row.band !== above.band, levels: levels.size, routes };
  });
}
