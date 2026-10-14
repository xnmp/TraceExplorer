import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedRoute } from "$lib/domain/trace-graph/layout";
import { incrementalTree, INCREMENTAL_LIMIT } from "$lib/domain/trace-graph/band-incremental";
import { attachSingleBand, bandExtent } from "$lib/domain/trace-graph/band-geometry";
import { measure, segments } from "$lib/domain/trace-graph/layout-quality";
import { ARROW } from "$lib/domain/trace-graph/metrics";
import { random } from "./fixtures";
import secondChanceScene from "./second-chance-scene.json";

const item = (key: string, parents: string[] = [], order = 0): LayoutItem => ({ key, parents, order, width: 92, height: 97 });
const request = (items: readonly LayoutItem[], width = 640): LayoutRequest =>
  ({ items, maxWidth: width, tileWidth: 92, pinned: { key: "root", x: width / 2 }, band: { key: "root", items } });
/** The committed layout of `items`, as the view keeps it: attached to the band. */
const committed = (items: readonly LayoutItem[], width = 640) => { const r = request(items, width); return attachSingleBand(layoutGraph(r), r); };

/** Hard gates and the shared-lane length of `layout` drawn for `r`. */
function verdict(layout: GraphLayout, r: LayoutRequest) {
  const m = measure(attachSingleBand(layout, r), "root", r.maxWidth, r.items);
  return { sharedLanePx: m.sharedLanePx, gates: [m.tileIntersections, m.overlaps, m.missingEdges, m.extraEdges, m.missingNodes, m.extraNodes, m.invalidGeometry, m.invalidPaths, m.terminalViolations, m.disconnectedEdges, m.overflow] };
}
const clean = Array(11).fill(0);

/** The heading of a route's last drawn segment: the direction it arrives from. */
function arrivalHeading(route: PlacedRoute): "down" | "up" | "left" | "right" {
  const [a, b] = segments(route.path).at(-1)!;
  if (a.x === b.x) return b.y > a.y ? "down" : "up";
  return b.x > a.x ? "right" : "left";
}

/** Every new junction above `child`: the routes arriving at each, and the tail leaving the lowest. */
function joinsOf(layout: GraphLayout, child: string) {
  const ids = [...layout.junctions.keys()].filter(id => id.startsWith(`incremental-join:${child}`));
  return ids.map(id => ({ id, junction: layout.junctions.get(id)!, inputs: layout.routes.filter(r => r.to.kind === "junction" && r.to.id === id), outputs: layout.routes.filter(r => r.from.kind === "junction" && r.from.id === id) }));
}

const base = [item("root"), item("a", ["root"], 1), item("b", ["root"], 2), item("d", ["root"], 3), item("e", ["root"], 4)];

describe("incremental tree: lane-free junctions", () => {
  it("brings two parents into a new junction from distinct directions, the tail leaving downward", () => {
    const previous = committed(base.slice(0, 3)), next = request([...base.slice(0, 3), item("c", ["a", "b"], 5)]);
    const result = incrementalTree(next, previous);
    expect(result).not.toBeNull();
    expect(verdict(result!, next)).toEqual({ sharedLanePx: 0, gates: clean });
    const [join] = joinsOf(result!, "c");
    expect(join.inputs.map(r => r.from.id).sort()).toEqual(["a", "b"]);
    const headings = join.inputs.map(arrivalHeading);
    expect(new Set(headings).size).toBe(2);
    expect(headings).not.toContain("up");
    // The tail starts at the junction and runs straight down onto the tile's arrowhead.
    const [tail] = join.outputs, c = result!.nodes.get("c")!;
    expect(segments(tail.path)).toEqual([[{ x: join.junction.x, y: join.junction.y }, { x: c.x + c.width / 2, y: c.y - ARROW.length }]]);
  });

  it("brings three parents in from above, the left and the right", () => {
    const previous = committed(base.slice(0, 4)), next = request([...base.slice(0, 4), item("c", ["a", "b", "d"], 5)]);
    const result = incrementalTree(next, previous);
    expect(result).not.toBeNull();
    expect(verdict(result!, next)).toEqual({ sharedLanePx: 0, gates: clean });
    const joins = joinsOf(result!, "c"), inputs = joins.flatMap(j => j.inputs);
    expect(inputs.map(r => r.from.id).sort()).toEqual(["a", "b", "d"]);
    // Inputs of one junction never share an arrival direction.
    for (const join of joins) expect(new Set(join.inputs.map(arrivalHeading)).size).toBe(join.inputs.length);
  });

  it("nests a fourth parent into a junction above, or withholds the candidate; never shares a lane", () => {
    const previous = committed(base), next = request([...base, item("c", ["a", "b", "d", "e"], 5)]);
    const result = incrementalTree(next, previous);
    if (!result) return;
    expect(verdict(result, next)).toEqual({ sharedLanePx: 0, gates: clean });
    const joins = joinsOf(result, "c");
    expect(joins.flatMap(j => j.inputs).filter(r => r.from.kind === "node").map(r => r.from.id).sort()).toEqual(["a", "b", "d", "e"]);
    for (const join of joins) {
      expect(new Set(join.inputs.map(arrivalHeading)).size).toBe(join.inputs.length);
      expect(join.inputs.length).toBeLessThanOrEqual(3);
      // Each junction lists the parents that reach it, directly or through junctions above it.
      expect(join.junction.parents.length).toBeGreaterThanOrEqual(join.inputs.length);
    }
    expect(joins.find(j => j.outputs.some(r => r.to.kind === "node" && r.to.id === "c"))!.junction.parents).toEqual(["a", "b", "d", "e"]);
  });
});

describe("incremental tree: retained lanes", () => {
  /** A committed scene with `a` in the first row, and a retained route of another source laid along `lanes`. */
  function blocked(lanes: readonly string[]) {
    const items = [item("root"), item("a", ["root"], 1), item("z", ["root"], 2)];
    const previous = committed(items), a = previous.nodes.get("a")!, width = 640;
    const bx = a.x + a.width / 2, by = a.y + a.height, rx = a.x + a.width, ry = a.y + a.height / 2;
    const paths: Record<string, string> = { BOTTOM: `M${bx} ${by} L${bx} ${by + 400}`, RIGHT: `M${rx} ${ry} L${width - 8} ${ry}`, EDGE: `M${rx} ${a.y} L${rx} ${by + 400}` };
    const foreign: PlacedRoute[] = lanes.map((lane, i) => ({ id: `foreign-${i}`, from: { kind: "node", id: "z" }, to: { kind: "node", id: "z" }, consumers: [{ parent: "root", child: "z" }], terminal: false, path: paths[lane] }));
    return { previous: { ...previous, routes: [...previous.routes, ...foreign] }, next: request([...items, item("c", ["a"], 3)], width) };
  }
  /** The new route's segments that run along a retained route of another source. */
  function shared(result: GraphLayout, previous: GraphLayout) {
    const route = result.routes.find(r => r.id === "incremental:a:c")!;
    return segments(route.path).flatMap(s => previous.routes.filter(r => r.from.id !== "a").flatMap(r => segments(r.path).filter(t =>
      (s[0].x === s[1].x && t[0].x === t[1].x && s[0].x === t[0].x && Math.min(Math.max(s[0].y, s[1].y), Math.max(t[0].y, t[1].y)) > Math.max(Math.min(s[0].y, s[1].y), Math.min(t[0].y, t[1].y)))
      || (s[0].y === s[1].y && t[0].y === t[1].y && s[0].y === t[0].y && Math.min(Math.max(s[0].x, s[1].x), Math.max(t[0].x, t[1].x)) > Math.max(Math.min(s[0].x, s[1].x), Math.min(t[0].x, t[1].x))))));
  }

  it("leaves a source port another source's route runs along by its other port", () => {
    const { previous, next } = blocked(["BOTTOM"]);
    const result = incrementalTree(next, previous);
    expect(result).not.toBeNull();
    expect(shared(result!, previous)).toEqual([]);
    expect(segments(result!.routes.find(r => r.id === "incremental:a:c")!.path)[0][0]).toEqual({ x: previous.nodes.get("a")!.x + 92, y: previous.nodes.get("a")!.y + 97 / 2 });
  });

  it("withholds the candidate when every lane out of the source belongs to another source", () => {
    // Out of the bottom port, out of the right port, and down (or up) the right edge.
    const { previous, next } = blocked(["BOTTOM", "RIGHT", "EDGE"]);
    expect(incrementalTree(next, previous)).toBeNull();
  });

  it("takes another lane when another source's retained route holds the gutter lane it would use", () => {
    // A full row of children of s2 lies between s0 and the new g, so g's route detours by a gutter.
    const items = [item("root"), ...Array.from({ length: 5 }, (_, i) => item(`s${i}`, ["root"], i + 1)), ...Array.from({ length: 5 }, (_, i) => item(`t${i}`, ["s2"], 10 + i))];
    const previous = committed(items), next = request([...items, item("g", ["s0"], 30)]);
    const verticals = (layout: GraphLayout) => segments(layout.routes.find(r => r.id === "incremental:s0:g")!.path).filter(([p, q]) => p.x === q.x);
    const free = incrementalTree(next, previous)!;
    // The detour: the vertical run passing the row of t tiles.
    const t0 = previous.nodes.get("t0")!, [gutter] = verticals(free).filter(([p, q]) => Math.min(p.y, q.y) < t0.y && Math.max(p.y, q.y) > t0.y + t0.height);
    expect(gutter).toBeDefined();
    const x = gutter[0].x, held: PlacedRoute = { id: "held", from: { kind: "node", id: "t4" }, to: { kind: "node", id: "t4" }, consumers: [{ parent: "s2", child: "t4" }], terminal: false, path: `M${x} 0 L${x} 2000` };
    const result = incrementalTree(next, { ...previous, routes: [...previous.routes, held] });
    expect(result).not.toBeNull();
    expect(verticals(result!).filter(([p, q]) => Math.abs(p.x - x) < 0.5 && Math.min(q.y, p.y) < 2000)).toEqual([]);
    const m = measure(attachSingleBand(result!, next), "root", next.maxWidth, next.items);
    expect([m.sharedLanePx, m.tileIntersections, m.overlaps, m.terminalViolations, m.disconnectedEdges, m.missingEdges, m.overflow]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("incremental tree: compactness", () => {
  it("fills a hole in an existing row rather than adding a row below the scene", () => {
    // Rows: root; s0..s4 (full); c0..c4 under s0 (full); d0 alone. A new child of s1 fits beside d0.
    const items = [item("root"), ...Array.from({ length: 5 }, (_, i) => item(`s${i}`, ["root"], i + 1)), ...Array.from({ length: 5 }, (_, i) => item(`c${i}`, ["s0"], 10 + i)), item("d0", ["c0"], 20)];
    const previous = committed(items), next = request([...items, item("g", ["s1"], 30)]);
    const result = incrementalTree(next, previous)!;
    expect(result).not.toBeNull();
    expect(result.nodes.get("g")!.y).toBe(previous.nodes.get("d0")!.y);
    expect(bandExtent(result, "root").height).toBe(bandExtent(previous, "root").height);
    expect(verdict(result, next)).toEqual({ sharedLanePx: 0, gates: clean });
  });
});

describe("incremental tree: robustness", () => {
  it("is deterministic", () => {
    const previous = committed(base.slice(0, 4)), next = request([...base.slice(0, 4), item("c", ["a", "b", "d"], 5), item("f", ["c"], 6)]);
    expect(incrementalTree(next, previous)).toEqual(incrementalTree(next, previous));
  });

  it("withholds rather than throws on malformed history and requests", () => {
    const previous = committed(base.slice(0, 3)), next = request([...base.slice(0, 3), item("c", ["a", "b"], 5)]);
    const nan = { ...previous, nodes: new Map([...previous.nodes].map(([k, n]) => [k, k === "a" ? { ...n, x: NaN } : n])) };
    const garbage = { ...previous, routes: [...previous.routes, { ...previous.routes[0], id: "garbage", from: { kind: "node" as const, id: "b" }, path: "M nonsense L 1e400 x" }] };
    const cases: [LayoutRequest, GraphLayout][] = [
      [next, nan],
      [next, garbage],
      [request([...base.slice(0, 3), item("c", ["missing"], 5)]), previous],
      [request([...base.slice(0, 3), item("c", ["a", "b"], 5)], 0), previous],
      [request([...base.slice(0, 3), item("c", ["a", "b"], 5)], NaN), previous],
      [request(base.slice(0, 3)), previous],
      [request([...base.slice(0, 3), ...Array.from({ length: INCREMENTAL_LIMIT }, (_, i) => item(`x${i}`, ["a"], 10 + i))]), previous],
    ];
    for (const [r, p] of cases) {
      let result: GraphLayout | null = null;
      expect(() => { result = incrementalTree(r, p); }).not.toThrow();
      if (result && r.maxWidth > 0) expect(verdict(result, r).sharedLanePx).toBe(0);
    }
  });

  it("keeps every result lane-free across a long reveal of a dense DAG", () => {
    const next = random(7);
    const items = [item("root"), ...Array.from({ length: 24 }, (_, i) => {
      if (i < 3) return item(`n${i}`, ["root"], i + 1);
      const parents = new Set(Array.from({ length: 1 + Math.floor(next() * 3) }, () => `n${Math.floor(next() * i)}`));
      return item(`n${i}`, [...parents], i + 1);
    })];
    let previous = committed(items.slice(0, 4)), placed = 0;
    expect(verdict(previous, request(items.slice(0, 4))).sharedLanePx).toBe(0);
    for (let visible = 6; visible <= items.length; visible += 2) {
      const r = request(items.slice(0, visible)), result = incrementalTree(r, previous);
      if (!result) break;
      expect(verdict(result, r)).toEqual({ sharedLanePx: 0, gates: clean });
      previous = attachSingleBand(result, r);
      placed = visible;
    }
    expect(placed).toBeGreaterThan(4);
  });
});

describe("incremental tree: second chance", () => {
  // A bench reveal (random-dag-40-7502, 900 px, 64 px images, step 3) whose crowded scene leaves
  // the new tile no placement on the normal grain and grid; only the finer second chance finds one.
  const scene = secondChanceScene as unknown as { request: LayoutRequest; previous: GraphLayout & { nodes: unknown; junctions: unknown } };
  const request = scene.request;
  const previous = { ...scene.previous, nodes: new Map(scene.previous.nodes as [string, never][]), junctions: new Map(scene.previous.junctions as [string, never][]) } as GraphLayout;

  it("places a tile the normal search cannot, lane-free and within the hard gates", () => {
    const result = incrementalTree(request, previous);
    expect(result).not.toBeNull();
    const m = measure(attachSingleBand(result!, request), request.band!.key, request.maxWidth, request.items);
    expect(m.sharedLanePx).toBe(0);
    expect([m.tileIntersections, m.overlaps, m.missingEdges, m.extraEdges, m.missingNodes, m.extraNodes, m.invalidGeometry, m.invalidPaths, m.terminalViolations, m.disconnectedEdges, m.overflow]).toEqual(clean);
    // Retained tiles keep their places.
    for (const [key, node] of previous.nodes) if (result!.nodes.has(key)) expect(result!.nodes.get(key)).toMatchObject({ x: node.x, y: node.y });
  });

  it("is deterministic, also for a fresh copy of the same request", () => {
    expect(incrementalTree(structuredClone(request), previous)).toEqual(incrementalTree(request, previous));
  });
});
