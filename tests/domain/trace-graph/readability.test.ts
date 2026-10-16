import { geometryGate } from "$lib/domain/trace-graph/geometry-gate";
import { describe, expect, it } from "vitest";
import { layoutGraph, layoutLayered, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedRoute } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { buildShelves, columnsFor, partitions } from "$lib/domain/trace-graph/band-shelves";
import { cost, measure, routePlan, sharedLaneLength, validateLayout, CROSSING_HEIGHT_TILES, CROSSING_WEIGHT, HEIGHT_WEIGHT } from "$lib/domain/trace-graph/layout-quality";
import { spacingFor } from "$lib/domain/trace-graph/metrics";
import { corpus, node, requestFor, rng, screenshot } from "../../../layout-eval/corpus";
import { profiles, provenanceSession, sessionComponents } from "../../../layout-eval/provenance-model";
import { axisOf, shallowRun, SHALLOW_RUN, TILE_GRAZE } from "$lib/domain/trace-graph/route-contacts";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const route = (id: string, from: string, to: string, path: string): PlacedRoute =>
  ({ id, from: { kind: "node", id: from }, to: { kind: "node", id: to }, consumers: [{ parent: from, child: to }], terminal: true, path });
const layoutOf = (routes: PlacedRoute[]): GraphLayout => ({ orientation: "down", width: 400, height: 400, nodes: new Map(), routes, junctions: new Map(), rows: [], readingOrder: new Map() });
const placed = (request: LayoutRequest) => attachSingleBand(layoutGraph(request), request);
const history = (request: LayoutRequest) => { const layout = layoutGraph(request); return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) }; };
/** Every shared lane a production layout may show is an explicit fallback: no lane-free candidate, or malformed input. */
const explained = (layout: GraphLayout) => layout.decision?.fallback === "lane-infeasible" || (layout.decision?.fallback === "gate-infeasible" && layout.pinnedViolation !== undefined);

describe("shared lanes between sources", () => {
  it("measures the stretch two sources' connectors run along together, and nothing else", () => {
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M10 40 L10 140")]))).toBeCloseTo(60, 6);
    // One source's connectors form a trunk; they may share.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "p", "y", "M10 40 L10 140")]))).toBe(0);
    // Meeting at a point or crossing is not a shared lane.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M10 100 L10 200")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M0 50 L20 50")]))).toBe(0);
  });

  it("counts lines closer than LANE_SEPARATION as one lane once they run together further than an arrowhead", () => {
    // A pixel apart, the two lines read as one for their common 100 px; so do a horizontal pair.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M11 0 L11 100")]))).toBeCloseTo(100, 6);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M0 10 L50 10 L50 30"), route("b", "q", "y", "M20 12.5 L90 12.5")]))).toBeCloseTo(30, 6);
    // A run split into collinear pieces is one run.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 5 L10 12"), route("b", "q", "y", "M12 0 L12 12")]))).toBeCloseTo(12, 6);
    // LANE_SEPARATION apart, or alongside for no more than an arrowhead, they read as two.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M13 0 L13 100")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M11 92 L11 200")]))).toBe(0);
    // One source's connectors, and inputs of one junction (which meet at its dot), may run together.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "p", "y", "M11 0 L11 100")]))).toBe(0);
    const join = (id: string, parent: string, path: string) => ({ ...route(id, parent, "j", path), to: { kind: "junction" as const, id: "j" }, terminal: false });
    expect(sharedLaneLength(layoutOf([join("a", "p", "M10 0 L10 100"), join("b", "q", "M11 0 L11 100")]))).toBe(0);
  });

  it("ignores empty, unparsable and degenerate routes rather than failing", () => {
    expect(sharedLaneLength(layoutOf([]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "nonsense"), route("b", "q", "y", "M10 0 L10 100")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 10 L10 10"), route("b", "q", "y", "M10 0 L10 100")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M1e6 0 L1e6 100"), route("b", "q", "y", "M1e6 50 L1e6 300")]))).toBeCloseTo(50, 3);
  });

  it("is a hard gate of the objective, priced only when asked to be", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), result = placed(request);
    const metrics = measure(result, request.band!.key, 454, request.items);
    expect(metrics.sharedLanePx).toBe(0);
    const shared = { ...metrics, sharedLanePx: 12 };
    expect(cost(shared, 92)).toBe(Infinity);
    expect(cost(shared, 92, { stability: 1.5, sharedLanes: "priced" })).toBeCloseTo(cost(metrics, 92) + 4 * 12 / 92, 9);
    // A hard gate elsewhere is never priced away.
    expect(cost({ ...shared, overlaps: 1 }, 92, { stability: 1.5, sharedLanes: "priced" })).toBe(Infinity);
  });

  it("is exact in hard-gate validation, which ranks nothing else", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), result = placed(request);
    const copy = { ...result, routes: [...result.routes, { ...result.routes[0], id: "copy", from: { kind: "node" as const, id: "elsewhere" } }] };
    const full = measure(copy, request.band!.key, 454, request.items), gates = validateLayout(copy, request.band!.key, 454, request.items);
    expect(full.sharedLanePx).toBeGreaterThan(0);
    expect(gates.sharedLanePx).toBe(full.sharedLanePx);
    expect(gates.crossings).toBe(0);
  });
});

describe("lane-free production layouts", () => {
  // One test per corpus case. This is a correctness check, not a timing budget: the slowest
  // case (random-dag-200-9102) takes 0.8 s locally but over 5 s on the macOS x86_64 runner,
  // so each case gets 30 s. Layout latency is measured by layout:eval, not here.
  it.each(corpus().map(c => [c.id, c] as const))("never shows a shared lane in %s unless it says why", (_, c) => {
    const unexplained: string[] = [];
    for (const width of [360, 900]) {
      let previous: ReturnType<typeof history> | undefined;
      for (const focus of c.focuses) {
        const request = requestFor(c, focus, width, 96);
        const layout = layoutGraph({ ...request, anchorKey: focus ?? undefined, history: previous ? { ...previous, signature: previous.signature } : undefined });
        const shared = measure(attachSingleBand(layout, request), request.band!.key, width, request.items).sharedLanePx;
        if (shared > 0 && !explained(layout)) unexplained.push(`${c.id} ${width}px focus ${focus}: ${shared.toFixed(1)} px`);
        previous = { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
      }
    }
    expect(unexplained).toEqual([]);
  }, 30_000);

  it("brings every input of a junction to its dot along its own line", () => {
    for (const c of corpus().filter(c => c.id.startsWith("random-dag-12") || c.id.includes("merges"))) {
      const request = requestFor({ ...c, full: true }, null, 454, 96);
      const layout = layoutLayered({ ...request, band: undefined, history: undefined, orientation: "down" });
      for (const junction of layout.junctions.values()) {
        const inputs = layout.routes.filter(r => r.to.kind === "junction" && r.to.id === junction.id);
        const finals = inputs.map(r => routePlan(r).segments.at(-1)!);
        for (const [a, b] of finals.flatMap((a, i) => finals.slice(i + 1).map(b => [a, b] as const))) {
          // Distinct directions into the dot: never the same final line.
          const cross = (a[1].x - a[0].x) * (b[1].y - b[0].y) - (a[1].y - a[0].y) * (b[1].x - b[0].x);
          expect(Math.abs(cross), `${c.id} ${junction.id}`).toBeGreaterThan(.001);
        }
      }
      expect(sharedLaneLength(layout), c.id).toBe(0);
    }
  });

  it("keeps a stacked shelf's arrivals off the exits beside them", () => {
    // A column of three: the first child's child arrives at the height the second child leaves from.
    const items: LayoutItem[] = [
      { key: "root", parents: [], order: 0, width: 92, height: 120 },
      { key: "a", parents: ["root"], order: 1, width: 92, height: 120 },
      { key: "b", parents: ["root"], order: 2, width: 92, height: 120 },
      { key: "a1", parents: ["a"], order: 3, width: 92, height: 120 },
      { key: "a2", parents: ["a"], order: 4, width: 92, height: 120 },
      { key: "b1", parents: ["b"], order: 5, width: 92, height: 120 },
    ];
    const request: LayoutRequest = { items, maxWidth: 1400, tileWidth: 92, band: { key: "root", items } };
    const columns = columnsFor(items, "root", spacingFor(92).column)!;
    for (const ends of partitions(columns, request)) {
      const shelves = buildShelves(request, columns, ends);
      if (shelves) expect(sharedLaneLength(shelves), ends.join(",")).toBe(0);
    }
  });

  it("does not keep unchanged geometry that shares a lane", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), previous = history(request);
    const [first] = previous.layout.routes, [placedFirst] = previous.placed.routes;
    // The same visible set, but a committed layout whose connectors from two sources overlap.
    const overlapping = (layout: GraphLayout, original: PlacedRoute) => ({ ...layout, routes: [...layout.routes, { ...original, id: "intruder", from: { kind: "node" as const, id: "elsewhere" }, consumers: [] }] });
    const result = layoutGraph({ ...request, anchorKey: "Saffron", history: { ...previous, layout: overlapping(previous.layout, first), placed: overlapping(previous.placed, placedFirst) } });
    expect(result.decision?.candidate).not.toBe("unchanged-visible");
    expect(measure(attachSingleBand(result, request), "root", 454, request.items).sharedLanePx).toBe(0);
  });
});

describe("routes trading columns", () => {
  /** Layers of two to four images, mostly from the layer above, sometimes from further up (a long edge passing rows). */
  function layered(seed: number): TraceNode[] {
    const random = rng(seed), layers = 3 + Math.floor(random() * 3), nodes = [node("root")];
    let above = ["root"], i = 1;
    for (let l = 0; l < layers; l++) {
      const count = 2 + Math.floor(random() * 3), layer: string[] = [];
      for (let k = 0; k < count; k++) {
        const pick = () => random() < .6 ? above[Math.floor(random() * above.length)] : nodes[Math.floor(random() * nodes.length)].key;
        const parents = new Set([pick()]);
        if (random() < .4) parents.add(pick());
        nodes.push(node(`n${i}`, [...parents], i)); layer.push(`n${i}`); i++;
      }
      above = layer;
    }
    return nodes;
  }
  /** Each route's vertical runs, consecutive collinear pieces merged: [x, top, bottom]. */
  const verticals = (r: PlacedRoute) => {
    const runs: [number, number, number][] = [];
    for (const [a, b] of routePlan(r).segments) if (Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) > .01) {
      const x = (a.x + b.x) / 2, top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y), last = runs.at(-1);
      if (last && Math.abs(last[0] - x) < .01 && Math.abs(last[2] - top) < .01) last[2] = bottom; else runs.push([x, top, bottom]);
    }
    return runs;
  };
  /**
   * Pairs of sources whose lines meet end to end on one column (one ends where the other starts, or
   * they overlap by no more than an arrowhead): one line seems to continue as the other. A
   * junction's inputs meet each other and its output at its dot by design.
   */
  function continuations(layout: GraphLayout): string[] {
    const source = (r: PlacedRoute) => `${r.from.kind}:${r.from.id}`, out: string[] = [];
    const joined = (a: PlacedRoute, b: PlacedRoute) => a.to.kind === "junction" && (b.from.kind === "junction" && b.from.id === a.to.id || b.to.kind === "junction" && b.to.id === a.to.id);
    const runs = layout.routes.map(r => ({ r, runs: verticals(r) }));
    for (const [i, a] of runs.entries()) for (const b of runs.slice(i + 1)) {
      if (source(a.r) === source(b.r) || joined(a.r, b.r) || joined(b.r, a.r)) continue;
      for (const [xa, ta, ba] of a.runs) for (const [xb, tb, bb] of b.runs) {
        const gap = Math.max(ta, tb) - Math.min(ba, bb);
        if (Math.abs(xa - xb) < .01 && gap < .5 && gap > -8) out.push(`${a.r.id} | ${b.r.id} at x=${xa}`);
      }
    }
    return out;
  }

  // Seeds whose layered layout once had two routes trade columns in one bend zone, in slices one
  // after the other: one left a column exactly where the other arrived, so the two lines met end to end.
  it.each([6, 12, 23, 25, 52, 76, 81, 110, 123, 132, 135, 144])("cross rather than meet end to end (seed %i)", seed => {
    const request = requestFor({ id: `layered-${seed}`, nodes: layered(seed), focuses: [null], full: true }, null, 454, 128);
    const layout = layoutGraph(request), drawn = attachSingleBand(layout, request);
    expect(continuations(drawn)).toEqual([]);
    const gates = validateLayout(drawn, request.band!.key, 454, request.items);
    expect([gates.tileIntersections, gates.overlaps, gates.missingEdges, gates.extraEdges, gates.invalidGeometry, gates.invalidPaths, gates.terminalViolations, gates.disconnectedEdges]).toEqual(Array(8).fill(0));
    if (!explained(layout)) expect(gates.sharedLanePx).toBe(0);
  });

  // Seeds whose layered layout once had a cycle of turn orders in one bend zone (each bend leaving
  // a column beside where the next arrives), broken by turning one bend early: it then ran a pixel
  // or two beside another source's line for a slice or two, and the layout was flagged lane-infeasible.
  it.each([80, 93, 118, 230, 235, 493, 744])("break a cycle of turn orders with a dogleg, not a shared lane (seed %i)", seed => {
    const request = requestFor({ id: `layered-${seed}`, nodes: layered(seed), focuses: [null], full: true }, null, 454, 128);
    const layout = layoutGraph(request), drawn = attachSingleBand(layout, request);
    const gates = validateLayout(drawn, request.band!.key, 454, request.items);
    expect(geometryGate(drawn, request.items, request.band!.key, request.maxWidth)).toBeNull();
    expect(gates.sharedLanePx).toBe(0);
    expect(continuations(drawn)).toEqual([]);
    expect([gates.tileIntersections, gates.overlaps, gates.missingEdges, gates.extraEdges, gates.invalidGeometry, gates.invalidPaths, gates.terminalViolations, gates.disconnectedEdges]).toEqual(Array(8).fill(0));
  });
});

describe("lines alongside curves", () => {
  /**
   * Pairs of routes of different sources where an axis-parallel piece of one runs within
   * LANE_SEPARATION of the other's curve for more than SHALLOW_RUN (`shallowRun`): the two read
   * as one line. A junction's inputs meet at its dot by design.
   */
  function alongCurves(layout: GraphLayout): string[] {
    const source = (r: PlacedRoute) => `${r.from.kind}:${r.from.id}`, out: string[] = [];
    const pieces = layout.routes.map(r => ({ r, ss: routePlan(r).segments }));
    for (const a of pieces) for (const b of pieces) {
      if (a === b || source(a.r) === source(b.r) || (a.r.to.kind === "junction" && a.r.to.kind === b.r.to.kind && a.r.to.id === b.r.to.id)) continue;
      let run = 0;
      for (const sa of a.ss) if (axisOf(sa)) for (const sb of b.ss) if (!axisOf(sb)) run += shallowRun(sa, sb);
      if (run > SHALLOW_RUN) out.push(`${a.r.id} along ${b.r.id}: ${run.toFixed(1)} px`);
    }
    return out;
  }

  // A variations session's click tour (seed 1) whose incremental embedding once drew a new route
  // through another source's fan, along the flat middle of its curves, when no route avoided
  // every touch: a route alongside a curve is a shared lane, never a tolerated touch.
  it("keeps every incremental route off other sources' curves along a click tour", () => {
    const component = sessionComponents(provenanceSession(profiles.variations, 1))[0];
    const shown = new Set(component.flatMap(n => n.parents));
    const focuses = [null, ...component.filter(n => n.scope === "current" && shown.has(n.key)).map(n => n.key).reverse().slice(0, 8), null];
    for (const [width, imagePx] of [[640, 48], [454, 64]] as const) {
      let previous: { signature: string; layout: GraphLayout; placed: GraphLayout } | undefined;
      for (const focus of focuses) {
        const request = requestFor({ id: "variations-1", nodes: component, focuses: [] }, focus, width, imagePx, previous?.layout.readingOrder);
        const layout = layoutGraph({ ...request, anchorKey: focus ?? undefined, history: previous });
        const placed = attachSingleBand(layout, request);
        expect(alongCurves(placed).filter(pair => pair.startsWith("incremental"))).toEqual([]);
        previous = { signature: bandHistorySignature(request), layout, placed };
      }
    }
  });
});

describe("lines kept off tiles", () => {
  type P = { readonly x: number; readonly y: number };
  const toSegment = (p: P, a: P, b: P) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
  };
  /** Distance from segment ab to a tile's rectangle: zero where they meet (an independent check, not `distanceToTile`). */
  function toTile(a: P, b: P, t: { x: number; y: number; width: number; height: number }): number {
    const inside = (p: P) => p.x >= t.x && p.x <= t.x + t.width && p.y >= t.y && p.y <= t.y + t.height;
    if (inside(a) || inside(b)) return 0;
    const c = [{ x: t.x, y: t.y }, { x: t.x + t.width, y: t.y }, { x: t.x + t.width, y: t.y + t.height }, { x: t.x, y: t.y + t.height }];
    const side = (p: P, q: P, r: P) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const edges = c.map((p, i) => [p, c[(i + 1) % 4]] as const);
    if (edges.some(([p, q]) => side(a, b, p) * side(a, b, q) < 0 && side(p, q, a) * side(p, q, b) < 0)) return 0;
    return Math.min(...edges.flatMap(([p, q]) => [toSegment(a, p, q), toSegment(b, p, q), toSegment(p, a, b), toSegment(q, a, b)]));
  }
  /** Incremental routes drawn closer than TILE_GRAZE to a tile other than the two they connect: on its outline, they read as part of it. */
  function grazing(layout: GraphLayout): string[] {
    const out: string[] = [];
    for (const r of layout.routes) {
      if (!r.id.startsWith('["incremental')) continue;
      const ss = routePlan(r).segments;
      for (const t of layout.nodes.values()) {
        if (t.key === r.from.id || t.key === r.to.id) continue;
        const d = Math.min(...ss.map(([a, b]) => toTile(a, b, t)));
        if (d < TILE_GRAZE - 1e-6) out.push(`${r.id} ${d.toFixed(2)} px from ${t.key}`);
      }
    }
    return out;
  }

  // Variations sessions' click tours whose incremental embedding once ran new routes a pixel off
  // the borders of tiles they pass (sessions 3 and 6 at 454 px).
  it.each([[3, 454, 64], [6, 454, 64]] as const)("keeps every incremental route off the tiles it passes (session %i, %i px)", (seed, width, imagePx) => {
    const component = sessionComponents(provenanceSession(profiles.variations, seed))[0];
    const shown = new Set(component.flatMap(n => n.parents));
    const focuses = [null, ...component.filter(n => n.scope === "current" && shown.has(n.key)).map(n => n.key).reverse().slice(0, 8), null];
    let previous: { signature: string; layout: GraphLayout; placed: GraphLayout } | undefined, incremental = 0;
    for (const focus of focuses) {
      const request = requestFor({ id: `variations-${seed}`, nodes: component, focuses: [] }, focus, width, imagePx, previous?.layout.readingOrder);
      const layout = layoutGraph({ ...request, anchorKey: focus ?? undefined, history: previous });
      const placed = attachSingleBand(layout, request);
      incremental += placed.routes.filter(r => r.id.startsWith('["incremental')).length;
      expect(grazing(placed), `focus ${focus}`).toEqual([]);
      previous = { signature: bandHistorySignature(request), layout, placed };
    }
    expect(incremental).toBeGreaterThan(0);
  });

  /** Distance from a point to a tile's rectangle (zero inside). */
  const pointToTile = (q: P, t: { x: number; y: number; width: number; height: number }) =>
    Math.hypot(Math.max(t.x - q.x, 0, q.x - t.x - t.width), Math.max(t.y - q.y, 0, q.y - t.y - t.height));
  /** Points every half pixel along the route, from `from` px past its start. */
  function along(ss: readonly (readonly [P, P])[], from: number): P[] {
    const out: P[] = [];
    let walked = 0;
    for (const [a, b] of ss) {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = Math.max(0, from - walked); t <= length; t += .5) out.push({ x: a.x + (b.x - a.x) * t / length, y: a.y + (b.y - a.y) * t / length });
      walked += length;
    }
    return out;
  }
  /**
   * In a layout the incremental embedding made: lines closer than TILE_GRAZE to a tile it placed
   * (new or moved) that they neither leave nor enter, and its routes running on their own tile's
   * border past the port they leave by.
   */
  function onPlacedTiles(layout: GraphLayout, placed: GraphLayout, before: GraphLayout | undefined): string[] {
    const out: string[] = [];
    const fresh = [...layout.nodes.values()].filter(n => { const o = before?.nodes.get(n.key); return !o || o.x !== n.x || o.y !== n.y; }).map(n => placed.nodes.get(n.key)!);
    for (const r of placed.routes) {
      const ss = routePlan(r).segments;
      for (const t of fresh) {
        if (t.key === r.from.id || t.key === r.to.id) continue;
        const d = Math.min(...ss.map(([a, b]) => toTile(a, b, t)));
        if (d < TILE_GRAZE - 1e-6) out.push(`${r.id} ${d.toFixed(2)} px from placed ${t.key}`);
      }
      if (!r.id.startsWith('["incremental') || r.from.kind !== "node") continue;
      const own = placed.nodes.get(r.from.id)!, hugging = along(ss, TILE_GRAZE + .25).filter(q => pointToTile(q, own) < TILE_GRAZE - 1e-6);
      if (hugging.length) out.push(`${r.id} runs on ${own.key}'s border for ${hugging.length / 2} px`);
    }
    return out;
  }

  // Tours where tiles the embedding placed once sat on retained connectors (merge-k8 sessions 6 and
  // 8 at 640 px), and a route left its tile down the tile's own border (observed session 2).
  it.each([["merge-k8", 6, 640, 48], ["merge-k8", 8, 640, 48], ["observed", 2, 454, 64]] as const)("keeps lines off the tiles the embedding places, and off their own tile's border (%s session %i, %i px)", (profile, seed, width, imagePx) => {
    const component = sessionComponents(provenanceSession(profiles[profile], seed))[0];
    const shown = new Set(component.flatMap(n => n.parents));
    const focuses = [null, ...component.filter(n => n.scope === "current" && shown.has(n.key)).map(n => n.key).reverse().slice(0, 8), null];
    let previous: { signature: string; layout: GraphLayout; placed: GraphLayout } | undefined;
    for (const focus of focuses) {
      const request = requestFor({ id: `${profile}-${seed}`, nodes: component, focuses: [] }, focus, width, imagePx, previous?.layout.readingOrder);
      const layout = layoutGraph({ ...request, anchorKey: focus ?? undefined, history: previous });
      const placed = attachSingleBand(layout, request);
      expect(onPlacedTiles(layout, placed, previous?.layout), `focus ${focus}`).toEqual([]);
      previous = { signature: bandHistorySignature(request), layout, placed };
    }
    // The optimizer may choose a different certified candidate after routing changes.
    // Clearance is asserted above for every layout, regardless of candidate name.
  });
});

describe("clicks that show nothing new", () => {
  // Chains session 4 at 640 px: clicking back up the chain hides tiles and shows none. The retained
  // band is within its height budget, so its tiles stay where they were; re-embedding them once moved
  // them 43–60 px on average for no less height.
  it("keep the retained tiles where they were when the band is within its height budget", () => {
    const component = sessionComponents(provenanceSession(profiles.chains, 4))[0];
    const shown = new Set(component.flatMap(n => n.parents));
    const focuses = [null, ...component.filter(n => n.scope === "current" && shown.has(n.key)).map(n => n.key).reverse().slice(0, 8), null];
    let previous: { signature: string; layout: GraphLayout; placed: GraphLayout } | undefined, checked = 0;
    for (const [step, focus] of focuses.entries()) {
      const request = requestFor({ id: "chains-4", nodes: component, focuses: [] }, focus, 640, 48, previous?.layout.readingOrder);
      const layout = layoutGraph({ ...request, anchorKey: focus ?? undefined, history: previous });
      if (step >= 6 && step <= 8) {
        expect(request.items.every(n => previous!.layout.nodes.has(n.key)), `step ${step} shows nothing new`).toBe(true);
        expect(request.items.length).toBeLessThan(previous!.layout.nodes.size);
        for (const n of request.items) expect(layout.nodes.get(n.key), `step ${step}: ${n.key}`).toMatchObject({ x: previous!.layout.nodes.get(n.key)!.x, y: previous!.layout.nodes.get(n.key)!.y });
        checked++;
      }
      previous = { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
    }
    expect(checked).toBe(3);
  });
});

describe("arrivals along a chain", () => {
  // Chains session 7 (26 images in one chain) at 454 px, 48 px images, edit by edit: the user selects
  // the latest image, its edit arrives. Each new edit is shorter than its parent (which now shows the
  // expand hint). Without room beside the parent for the jog between their ports, an edit went to the
  // row's far end, and the next arrivals re-laid the band, moving the image being edited.
  it("leave the image being edited where it was", () => {
    const component = sessionComponents(provenanceSession(profiles.chains, 7))[0];
    const byOrder = [...component].sort((a, b) => a.order - b.order);
    let previous: { signature: string; layout: GraphLayout; placed: GraphLayout } | undefined, checked = 0;
    const show = (nodes: readonly TraceNode[], input: string) => {
      const request = requestFor({ id: "chains-7", nodes, focuses: [] }, input, 454, 48, previous?.layout.readingOrder);
      const layout = layoutGraph({ ...request, anchorKey: input, history: previous });
      previous = { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
      return layout;
    };
    for (let k = 2; k <= byOrder.length; k++) {
      const input = byOrder[k - 1].parents[0];
      const before = show(byOrder.slice(0, k - 1), input).nodes.get(input)!;
      const after = show(byOrder.slice(0, k), input).nodes.get(input)!;
      // From the third edit on: the band has its rows.
      if (k >= 4) { expect({ x: after.x, y: after.y }, `edit ${k - 1} of ${input}`).toEqual({ x: before.x, y: before.y }); checked++; }
    }
    expect(checked).toBe(23);
  });
});

describe("calibrated crossings", () => {
  it("prices a crossing as the band height it must save", () => {
    expect(CROSSING_WEIGHT).toBeCloseTo(HEIGHT_WEIGHT * CROSSING_HEIGHT_TILES, 12);
    const request = requestFor(screenshot, "Saffron", 454, 96), metrics = measure(placed(request), "root", 454, request.items);
    // One more crossing costs exactly what CROSSING_HEIGHT_TILES tile widths of height cost.
    const crossing = cost({ ...metrics, crossings: metrics.crossings + 1 }, 92) - cost(metrics, 92);
    const height = cost({ ...metrics, height: metrics.height + CROSSING_HEIGHT_TILES * 92 }, 92) - cost(metrics, 92);
    expect(crossing).toBeCloseTo(height, 9);
  });
});
