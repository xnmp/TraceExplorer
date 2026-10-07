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

/** Node endpoints from which some route chain reaches `child`. */
export function sourcesReaching(plan: Pick<JunctionPlan, "routes">, child: NodeKey): Set<NodeKey> {
  const incoming = new Map<string, string[]>();
  // A trunk (to === from) is drawing shared by routes, not an edge.
  for (const route of plan.routes) if (endpointKey(route.from) !== endpointKey(route.to)) incoming.set(endpointKey(route.to), [...(incoming.get(endpointKey(route.to)) ?? []), endpointKey(route.from)]);
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

/** Route points that fall inside a tile other than the route's own endpoints. */
export function routeCollisions(layout: GraphLayout): string[] {
  const problems: string[] = [];
  for (const route of layout.routes) {
    const own = new Set([route.from.kind === "node" ? route.from.id : "", route.to.kind === "node" ? route.to.id : ""]);
    for (const point of samplePath(route.path)) {
      for (const tile of layout.nodes.values()) {
        if (own.has(tile.key)) continue;
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
    for (const junction of layout.junctions.values()) {
      if (route.from.id === junction.id || route.to.id === junction.id) continue;
      const closest = points.reduce((best, point) => Math.min(best, Math.hypot(point.x - junction.x, point.y - junction.y)), Infinity);
      if (closest < distance) problems.push(`${route.id} passes ${closest.toFixed(1)}px from ${junction.id}`);
    }
  }
  return problems;
}

/** Vertical runs of routes with different sources and destinations that share an x (merged lanes). */
export function sharedLanes(layout: GraphLayout): string[] {
  const runs: { x: number; top: number; bottom: number; route: GraphLayout["routes"][number] }[] = [];
  for (const route of layout.routes) {
    const tokens = route.path.match(/[MLC]|-?\d+(?:\.\d+)?/g) ?? [];
    let x = 0, y = 0;
    for (let index = 0; index < tokens.length;) {
      const command = tokens[index++];
      const values = tokens.slice(index, index + (command === "C" ? 6 : 2)).map(Number);
      index += values.length;
      const [nextX, nextY] = values.slice(-2);
      if (command === "L" && Math.abs(nextX - x) < 0.01 && Math.abs(nextY - y) > 1) runs.push({ x, top: Math.min(y, nextY), bottom: Math.max(y, nextY), route });
      x = nextX; y = nextY;
    }
  }
  const problems: string[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (endpointKey(a.route.from) === endpointKey(b.route.from) || endpointKey(a.route.to) === endpointKey(b.route.to)) continue;
    if (Math.abs(a.x - b.x) < 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 10) problems.push(`${a.route.id} and ${b.route.id} share x=${a.x}`);
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
