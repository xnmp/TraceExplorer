import { describe, expect, it } from "vitest";
import { layoutGraph, layoutLayered, type GraphLayout, type LayoutItem, type LayoutRequest, type PlacedRoute } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { buildShelves, columnsFor, partitions } from "$lib/domain/trace-graph/band-shelves";
import { cost, measure, routePlan, sharedLaneLength, validateLayout, CROSSING_HEIGHT_TILES, CROSSING_WEIGHT, HEIGHT_WEIGHT } from "$lib/domain/trace-graph/layout-quality";
import { spacingFor } from "$lib/domain/trace-graph/metrics";
import { corpus, requestFor, screenshot } from "../../../layout-eval/corpus";

const route = (id: string, from: string, to: string, path: string): PlacedRoute =>
  ({ id, from: { kind: "node", id: from }, to: { kind: "node", id: to }, consumers: [{ parent: from, child: to }], terminal: true, path });
const layoutOf = (routes: PlacedRoute[]): GraphLayout => ({ orientation: "down", width: 400, height: 400, nodes: new Map(), routes, junctions: new Map(), rows: [], readingOrder: new Map() });
const placed = (request: LayoutRequest) => attachSingleBand(layoutGraph(request), request);
const history = (request: LayoutRequest) => { const layout = layoutGraph(request); return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) }; };
/** Every shared lane a production layout may show is an explicit, flagged fallback. */
const explained = (layout: GraphLayout) => layout.decision?.fallback === "lane-infeasible" || layout.decision?.fallback === "gate-infeasible";

describe("shared lanes between sources", () => {
  it("measures the stretch two sources' connectors run along together, and nothing else", () => {
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M10 40 L10 140")]))).toBeCloseTo(60, 6);
    // One source's connectors form a trunk; they may share.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "p", "y", "M10 40 L10 140")]))).toBe(0);
    // Meeting at a point, crossing, or running parallel a pixel apart is not a shared lane.
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M10 100 L10 200")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M0 50 L20 50")]))).toBe(0);
    expect(sharedLaneLength(layoutOf([route("a", "p", "x", "M10 0 L10 100"), route("b", "q", "y", "M11 0 L11 100")]))).toBe(0);
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
  it("never shows a shared lane across the corpus unless it says why", () => {
    const unexplained: string[] = [];
    for (const c of corpus()) for (const width of [360, 900]) {
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
  });

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
