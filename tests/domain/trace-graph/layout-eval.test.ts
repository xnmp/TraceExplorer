import { describe, expect, it } from "vitest";
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { packStackGroups } from "$lib/domain/trace-graph/stack-packing";
import { attachSingleBand, bandExtent, packedGridFlow, bandPlacements, attachPackedBand, estimatedBandExtent } from "$lib/domain/trace-graph/band-geometry";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { optimisticCost } from "$lib/domain/trace-graph/layout-cost-bound";
import { measure, cost, intersectsTile, crossing, overlapLength } from "$lib/domain/trace-graph/layout-quality";
import { handCases, corpus, requestFor, screenshot, chain, node } from "../../../layout-eval/corpus";

const placed = (request: LayoutRequest) => attachSingleBand(layoutGraph(request), request);
const history = (request: LayoutRequest) => { const layout = layoutGraph(request); return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) }; };
const safe = (request: LayoutRequest) => {
  const result = placed(request), metrics = measure(result, request.band!.key, request.maxWidth, request.items);
  expect([metrics.tileIntersections, metrics.overlaps, metrics.directionViolations, metrics.missingEdges, metrics.extraEdges,
    metrics.missingNodes, metrics.extraNodes, metrics.invalidGeometry, metrics.invalidPaths, metrics.terminalViolations, metrics.disconnectedEdges]).toEqual(Array(11).fill(0));
  return result;
};

describe("production band contracts", () => {
  it("compacts the reported band and leaves exactly the cover header before its first child", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), result = safe(request);
    expect(bandExtent(result, "root").height).toBeLessThanOrEqual(350);
    const first = Math.min(...[...result.nodes.values()].filter(n => n.key !== "root").map(n => n.y));
    expect(first - result.nodes.get("root")!.height).toBe(34);
    expect(measure(result, "root", 454, request.items).whitespace).toBeLessThan(.45);
  });
  it("uses complete topology only for captions, never slots, orientation or geometry", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96);
    expect(layoutGraph(request)).toEqual(layoutGraph({ ...request, band: { ...request.band!, items: request.items } }));
  });
  it("preserves the clicked tile and its ancestors for a real reveal in attached coordinates", () => {
    const first = requestFor(screenshot, null, 454, 96), previous = history(first);
    const next = requestFor(screenshot, "Saffron", 454, 96);
    const result = safe({ ...next, anchorKey: "Saffron", history: previous });
    for (const key of ["root", "Saffron"]) expect([result.nodes.get(key)!.x, result.nodes.get(key)!.y]).toEqual([previous.placed.nodes.get(key)!.x, previous.placed.nodes.get(key)!.y]);
    expect(measure(result, "root", 454, next.items, previous.placed, "Saffron").maxDisplacement).toBeLessThanOrEqual(140);
  });
  it("keeps unchanged visible sets stationary even when focus styling changes", () => {
    const first = requestFor(screenshot, "Saffron", 900, 96), previous = history(first);
    const result = placed({ ...first, anchorKey: "Blastoise", history: previous });
    expect([...result.nodes]).toEqual([...previous.placed.nodes]);
    expect(bandExtent(result, "root")).toMatchObject({ width: bandExtent(previous.placed, "root").width, height: bandExtent(previous.placed, "root").height });
  });
  it("reports a height-for-stability choice even when a shorter embedding was pruned", () => {
    for (const [id, clicks] of [["mixed-depth", ["long0"]], ["random-tree-40-7402", ["n2", "n10"]]] as const) {
      const fixture = { ...corpus().find(c => c.id === id)!, full: false };
      let request = requestFor(fixture, null, 900, 96), previous = history(request);
      let result = previous.placed;
      for (const focus of clicks) {
        request = requestFor(fixture, focus, 900, 96);
        const raw = layoutGraph({ ...request, history: previous, anchorKey: focus });
        result = attachSingleBand(raw, request);
        expect(result.nodes.get(focus)).toMatchObject({ x: previous.placed.nodes.get(focus)!.x, y: previous.placed.nodes.get(focus)!.y });
        previous = { signature: bandHistorySignature(request), layout: raw, placed: result };
      }
      expect(bandExtent(result, "root").height).toBeGreaterThan(bandExtent(placed(request), "root").height * 1.1);
      expect(result.decision?.stability).toBe(true);
    }
  });
  it("expires incompatible history on width, metric and relationship changes", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), previous = history(request);
    const stale = { ...previous, signature: "incompatible", attachment: { bandTop: 500, placement: { x: 0, coverX: 10, coverHeight: 30, width: 20, left: 0, right: 20, bridge: { top: -500, gutter: -100 }, stemRoom: 1 } } };
    expect(layoutGraph({ ...request, history: stale })).toEqual(layoutGraph(request));
    const rewired = (items: readonly LayoutRequest["items"][number][]) => items.map(n => n.key === "Ash" ? { ...n, parents: ["Cerulean"] } : n);
    for (const next of [{ ...request, maxWidth: 900 }, { ...request, tileWidth: 172 }, { ...request, band: { ...request.band!, items: rewired(request.band!.items) } }]) {
      expect(layoutGraph({ ...next, history: previous })).toEqual(layoutGraph(next));
    }
  });
  it("keeps history while the component grows: the selected input and every visible tile stay put", () => {
    // Each output arrives below its selected input (docs/trace-view-layout.md, "Growth").
    const nodes = screenshot.nodes;
    let yields = 0;
    for (const width of [360, 454, 900]) for (let k = 3; k < nodes.length; k++) {
      const input = nodes[k].parents[0], before = { ...screenshot, nodes: nodes.slice(0, k) }, after = { ...screenshot, nodes: nodes.slice(0, k + 1) };
      const first = requestFor(before, input, width, 96), previous = history(first);
      const next = { ...requestFor(after, input, width, 96), anchorKey: input, history: previous };
      const result = safe(next), decision = layoutGraph(next).decision;
      // Anchors yield only to the height or crossing caps, and say so.
      if (decision?.fallback !== "anchor-yield") expect(measure(result, "root", width, next.items, previous.placed, input).anchorDisplacement).toBe(0);
      else yields++;
    }
    expect(yields).toBeLessThanOrEqual(1);
  });
  it("does not hold the selected input still by moving every other tile", () => {
    // A batch of eight from the cover with one of them selected, then a batch of eight from that
    // one. Holding it still takes a repack of every other tile around it (hundreds of pixels); the
    // fresh layout moves every tile, the selected one included, by less than a lane. The calmer
    // layout is shown, and since the anchor moved, the decision says so (docs/trace-view-layout.md, "Growth").
    const batch = [node("root"), ...Array.from({ length: 8 }, (_, i) => node(`c${i}`, ["root"], i + 1))];
    for (const [width, px] of [[640, 48], [900, 96]] as const) {
      const before = { id: "batch-under-batch", nodes: batch, focuses: ["c3"] };
      const after = { ...before, nodes: [...batch, ...Array.from({ length: 8 }, (_, i) => node(`g${i}`, ["c3"], i + 9))] };
      const previous = history(requestFor(before, "c3", width, px));
      const next = { ...requestFor(after, "c3", width, px), anchorKey: "c3", history: previous };
      const metrics = measure(safe(next), "root", width, next.items, previous.placed, "c3");
      expect(metrics.maxDisplacement).toBeLessThan(32);
      if (metrics.anchorDisplacement > 0) expect(layoutGraph(next).decision?.fallback).toBe("anchor-yield");
    }
  });
  it("is deterministic under input permutation and does not mutate request or prior geometry", () => {
    const request = requestFor(screenshot, null, 640, 96), previous = history(request);
    const next = { ...requestFor(screenshot, "Saffron", 640, 96), history: previous };
    const before = structuredClone(next), first = layoutGraph(next);
    expect(layoutGraph({ ...next, items: [...next.items].reverse() })).toEqual(first);
    expect(next).toEqual(before);
    expect(layoutGraph(next)).toEqual(first);
  });
  it("preserves shared-trunk source connections while anchoring a merge reveal", () => {
    const fixture = handCases.find(c => c.id === "merges-3")!;
    const first = requestFor(fixture, null, 360, 96), previous = history(first);
    const request = { ...requestFor(fixture, "c", 360, 96), anchorKey: "c", history: previous };
    const result = safe(request);
    expect(measure(result, "root", 360, request.items, previous.placed, "c").anchorDisplacement).toBe(0);
  });
  it("keeps tiles, arrows, routes and parentage safe on hand cases and seeded DAGs", () => {
    for (const c of [...handCases.filter(c => !["fan-80", "fan-200", "chain-80", "chain-200"].includes(c.id)), ...corpus().filter(c => c.id.startsWith("random-") && c.nodes.length === 12)])
      for (const width of [360, 900]) safe(requestFor(c, c.focuses[1] ?? null, width, 96));
  });
  it("keeps an active packed group fixed when moving its neighbour can fit the reveal", () => {
    const result = packStackGroups([
      { id: "click", center: 150, width: 400, height: 200, preferredX: 50, anchorX: 50 },
      { id: "other", center: 400, width: 200, height: 200, preferredX: 300 },
    ], 700, 16);
    expect(result.find(g => g.id === "click")!.x).toBe(50);
    expect(result.find(g => g.id === "other")!.x).toBeGreaterThanOrEqual(466);
    expect(result.every(g => g.x >= 0 && g.x + g.width <= 700)).toBe(true);
    const edges = packStackGroups([{ id: "edge", center: 200, width: 100, height: 100, preferredX: 150, anchorX: 0 }, { id: "other", center: 350, width: 100, height: 100, preferredX: 300 }], 700, 16);
    expect(edges[0].x).toBe(0);
    const reserved = packStackGroups([{ id: "other", center: 200, width: 400, height: 100, preferredX: 0 },
      { id: "click", center: 600, width: 400, height: 100, preferredX: 300, anchorX: 300, anchorY: 0 }], 700, 16, 0);
    expect(reserved.find(g => g.id === "click")).toMatchObject({ x: 300, y: 0 });
    expect(reserved.find(g => g.id === "other")!.y).toBeGreaterThanOrEqual(100);
  });
  it("does not squeeze a committed band beside an unmeasured newly opened stack", () => {
    const items = ["a", "b", "new"].map(id => ({ id, kind: "stack" as const }));
    const open = new Map([
      ["a", { width: 180, height: 200, preferredX: 0, anchorX: 0, anchorY: 0 }],
      ["b", { width: 216, height: 200, preferredX: 84 }],
    ]);
    const metrics = { cellWidth: 120, cellHeight: 128, columnGap: 12, rowGap: 12 };
    const before = packedGridFlow(items, open, 3, metrics).bands.find(b => b.id === "b")!;
    const pending = packedGridFlow(items, new Map([...open, ["new", estimatedBandExtent(tileMetrics())]]), 3, metrics);
    expect(pending.bands.find(b => b.id === "b")).toMatchObject({ x: before.x, y: before.y });
    expect(pending.bands.find(b => b.id === "new")!.y).toBeGreaterThanOrEqual(before.y + before.height);
  });
  it("places an unmeasured stack after the committed bands, even when its cover comes first in the row", () => {
    const items = ["new", "spacer", "b"].map(id => ({ id, kind: id === "spacer" ? "file" as const : "stack" as const }));
    const open = new Map([["b", { width: 216, height: 145, preferredX: 136 }]]);
    const metrics = { cellWidth: 108, cellHeight: 128, columnGap: 12, rowGap: 12 };
    const before = packedGridFlow(items, open, 3, metrics).bands.find(b => b.id === "b")!;
    const pending = packedGridFlow(items, new Map([...open, ["new", estimatedBandExtent(tileMetrics())]]), 3, metrics);
    expect(pending.bands.find(b => b.id === "b")).toMatchObject({ x: before.x, y: before.y });
    expect(pending.bands.find(b => b.id === "new")!.y).toBeGreaterThanOrEqual(before.y + before.height);
  });
  it("anchors a reveal in a later packed line without applying its row offset twice", () => {
    const requests = [0, 1].map(i => {
      const prefix = `g${i}:`;
      const c = { ...screenshot, nodes: screenshot.nodes.map(n => ({ ...n, key: prefix + n.key, parents: n.parents.map(p => prefix + p) })) };
      return { ...requestFor(c, null, 448, 96), pinned: { key: prefix + "root", x: i * 154 + 70 } };
    });
    const initial = requests.map(layoutGraph), items = requests.map(r => ({ id: r.band!.key, kind: "stack" as const }));
    const compose = (layouts: ReturnType<typeof layoutGraph>[]) => {
      const flow = packedGridFlow(items, new Map(layouts.map((l, i) => [items[i].id, bandExtent(l, items[i].id)])), 3, { cellWidth: 140, cellHeight: 128, columnGap: 14, rowGap: 14 });
      const placements = bandPlacements(flow, 128);
      return { flow, placements, placed: layouts.map((l, i) => attachPackedBand(l, items[i].id, flow.bands.find(b => b.id === items[i].id)!.y, placements.get(items[i].id)!)) };
    };
    const before = compose(initial), c = { ...screenshot, nodes: screenshot.nodes.map(n => ({ ...n, key: "g1:" + n.key, parents: n.parents.map(p => "g1:" + p) })) };
    const reveal = { ...requestFor(c, "g1:Saffron", 448, 96), pinned: requests[1].pinned,
      history: { signature: bandHistorySignature(requests[1]), layout: initial[1], placed: before.placed[1],
        attachment: { bandTop: before.flow.bands.find(b => b.id === items[1].id)!.y, placement: before.placements.get(items[1].id)! } } };
    const after = compose([initial[0], layoutGraph(reveal)]);
    expect(after.placed[1].nodes.get("g1:Saffron")).toMatchObject({ x: before.placed[1].nodes.get("g1:Saffron")!.x, y: before.placed[1].nodes.get("g1:Saffron")!.y });
    expect(after.placed[1].decision?.fallback).toBeUndefined();
  });
  it("keeps a near-edge pinned cover separate from other forest roots", () => {
    const request: LayoutRequest = { maxWidth: 400, tileWidth: 92, pinned: { key: "cover", x: 354 }, band: { key: "cover", items: [] }, items: [
      { key: "cover", width: 92, height: 97, parents: [], order: 0 },
      { key: "source", width: 92, height: 97, parents: [], order: 1 },
      { key: "output", width: 92, height: 81, parents: ["cover", "source"], order: 2 },
    ] };
    const result = safe(request);
    expect(result.nodes.get("cover")!.x + 46).toBe(354);
    expect(result.nodes.get("source")!.y).toBeGreaterThanOrEqual(131);
  });
  it("preserves a clicked merge and both retained roots while revealing its child", () => {
    const items = [
      { key: "root", width: 92, height: 97, parents: [], order: 0 },
      { key: "source", width: 92, height: 97, parents: [], order: 1 },
      { key: "merge", width: 92, height: 97, parents: ["root", "source"], order: 2 },
      { key: "edit", width: 92, height: 81, parents: ["merge"], order: 3 },
    ];
    const first = { maxWidth: 454, tileWidth: 92, pinned: { key: "root", x: 340 }, band: { key: "root", items }, items: items.slice(0, 3) };
    const previous = history(first), request = { ...first, items, anchorKey: "merge", history: previous };
    const result = safe(request);
    for (const key of ["root", "source", "merge"]) expect(result.nodes.get(key)).toMatchObject({ x: previous.placed.nodes.get(key)!.x, y: previous.placed.nodes.get(key)!.y });
    expect(result.decision?.fallback).toBeUndefined();
  });
  it("translates the allocation envelope with direct grid attachment", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), layout = layoutGraph(request);
    const before = bandExtent(layout, "root");
    const result = attachPackedBand(layout, "root", 304, { x: 5, coverX: 100, coverHeight: layout.nodes.get("root")!.height, width: 454, left: 0, right: 454 });
    expect(bandExtent(result, "root")).toMatchObject({ left: 5, width: before.width, height: before.height });
    expect(Math.min(...[...result.nodes.values()].filter(n => n.key !== "root").map(n => n.y))).toBe(338);
  });
  it("handles empty, single, a 200-child fan and an iterative 2,000-node chain", () => {
    for (const id of ["empty", "single", "fan-200"]) safe(requestFor(handCases.find(c => c.id === id)!, null, 454, 96));
    const request = requestFor({ id: "deep", nodes: chain(2000), focuses: [null], full: true }, null, 900, 96);
    expect(layoutGraph(request).nodes.size).toBe(2000);
    const single = requestFor(handCases.find(c => c.id === "single")!, null, 50, 96);
    const narrow = safe({ ...single, pinned: undefined });
    expect(narrow.nodes.get("root")!.x).toBeGreaterThanOrEqual(0);
    expect(narrow.nodes.get("root")!.x + narrow.nodes.get("root")!.width).toBeLessThanOrEqual(narrow.width);
  }, 30_000);
  it("ignores unknown and duplicate parents and rejects raw cycles, duplicates and malformed nodes", () => {
    const request = requestFor(screenshot, null, 454, 96);
    expect(layoutGraph({ ...request, items: request.items.map(n => ({ ...n, parents: [...n.parents, ...n.parents, "unknown"] })) })).toEqual(layoutGraph(request));
    for (const malformed of [null, undefined]) expect(() => layoutGraph(malformed as unknown as LayoutRequest)).toThrow(RangeError);
    for (const items of [null, [null], Array(3), [...request.items, request.items[0]], request.items.map(n => ({ ...n, parents: n.key === "root" ? ["Saffron"] : n.parents }))])
      expect(() => layoutGraph({ ...request, items } as unknown as LayoutRequest)).toThrow(RangeError);
  });
  it("handles narrow, invalid and huge widths and out-of-range pins, rejecting invalid tile metrics", () => {
    const request = requestFor(screenshot, null, 454, 96);
    for (const width of [0, 1, 150, NaN, Infinity, 1e30]) for (const x of [-1e20, 1e20, NaN]) {
      const result = layoutGraph({ ...request, maxWidth: width, pinned: { ...request.pinned!, x } });
      expect([result.width, result.height, ...[...result.nodes.values()].flatMap(n => [n.x, n.y])].every(Number.isFinite)).toBe(true);
    }
    for (const tileWidth of [0, -1, NaN, Infinity, 1e30]) expect(() => layoutGraph({ ...request, tileWidth })).toThrow(RangeError);
    expect(() => layoutGraph({ ...request, items: request.items.map(n => ({ ...n, width: 1e30 })) })).toThrow(RangeError);
    const oversized = { ...request, items: request.items.map(n => ({ ...n, width: 1000, height: 1000 })) };
    expect(layoutGraph(oversized).nodes.size).toBe(request.items.length);
  });
  it("shows a cover with a visible parent as a flagged downward layout instead of failing", () => {
    const item = (key: string, parents: string[], order: number) => ({ key, parents, order, width: 92, height: 97 });
    const items = [item("x", [], 0), item("root", ["x"], 1), item("a", ["root"], 2)];
    const result = layoutGraph({ maxWidth: 640, tileWidth: 92, pinned: { key: "root", x: 300 }, band: { key: "root", items }, items });
    expect([...result.nodes.keys()].sort()).toEqual(["a", "root", "x"]);
    expect(result.pinnedViolation).toBe("not-a-root");
    expect(result.decision?.fallback).toBe("gate-infeasible");
  });
  it("treats non-finite history, or history without its visible cover, as no history", () => {
    const request = requestFor(screenshot, null, 454, 96), reveal = requestFor(screenshot, "Saffron", 454, 96);
    const committed = history(request), cold = layoutGraph({ ...reveal, history: undefined });
    const broken = (n: { x: number }) => ({ ...n, x: NaN });
    for (const bad of [
      { ...committed, placed: { ...committed.placed, nodes: new Map([...committed.placed.nodes].map(([k, n]) => [k, broken(n)])) } },
      { ...committed, layout: { ...committed.layout, routes: committed.layout.routes.map(r => ({ ...r, path: r.path + " L NaN 4" })) } },
      { ...committed, attachment: { bandTop: NaN, placement: { x: 0, coverX: 0, coverHeight: 97, width: 454, left: 0, right: 454 } } },
    ]) expect(layoutGraph({ ...reveal, history: bad })).toEqual(cold);
    const coverless = { ...reveal, items: reveal.items.filter(n => n.key !== reveal.band!.key) };
    expect(() => layoutGraph({ ...coverless, history: { ...committed, signature: bandHistorySignature(coverless) } })).not.toThrow();
  });
});

describe("grid packing", () => {
  it("never stacks a first-line group onto one an anchored reservation displaced", () => {
    const result = packStackGroups([
      { id: "A", center: 50, width: 100, height: 100 },
      { id: "B", center: 250, width: 100, height: 50 },
      { id: "C", center: 280, width: 100, height: 50, anchorX: 0, anchorY: 60 },
    ], 300, 16, 0);
    for (const a of result) for (const b of result) if (a.id < b.id)
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} and ${b.id} overlap`).toBe(true);
  });
  it("keeps unmeasured placeholders inside the grid width and committed bands in cover order", () => {
    const items = [0, 1, 2, 3, 4, 5].map(i => ({ id: `s${i}`, kind: "stack" as const }));
    const metrics = { cellWidth: 120, cellHeight: 140, columnGap: 8, rowGap: 8 };
    const committed = new Map([["s1", { width: 425, height: 166 }]]);
    const base = packedGridFlow(items, committed, 6, metrics);
    for (const count of [1, 2, 3, 4]) {
      const open = new Map<string, { width: number; height: number; pending?: true }>(committed);
      for (const id of ["s0", "s2", "s4", "s5"].slice(0, count)) open.set(id, estimatedBandExtent(tileMetrics()));
      const flow = packedGridFlow(items, open, 6, metrics);
      expect(flow.width).toBe(base.width);
      expect(flow.bands.every(b => b.x >= 0 && b.x + b.width <= flow.width)).toBe(true);
      expect(flow.bands.map(b => b.id)).toEqual([...open.keys()].sort());
      expect(() => bandPlacements(flow, 140)).not.toThrow();
    }
  });
});

describe("objective hard gates", () => {
  it("checks current path and consumer metadata after a prior geometry evaluation", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), result = placed(request);
    const route = { ...result.routes[0] }, copy = { ...result, routes: [route, ...result.routes.slice(1)] };
    expect(Number.isFinite(cost(measure(copy, "root", 454, request.items), request.tileWidth!))).toBe(true);
    const path = route.path;
    route.path = "invalid M0 0 L1 1";
    expect(measure(copy, "root", 454, request.items).invalidPaths).toBeGreaterThan(0);
    route.path = path;
    route.consumers = [];
    const changed = measure(copy, "root", 454, request.items);
    expect(changed.missingEdges + changed.disconnectedEdges).toBeGreaterThan(0);
  });
  it("never prices the optimistic bound above the complete sampled objective", () => {
    for (const c of corpus().filter(c => c.nodes.length <= 40)) for (const width of [360, 900]) {
      const request = requestFor(c, c.focuses[1] ?? null, width, 96), result = placed(request);
      const complete = cost(measure(result, request.band!.key, width, request.items), request.tileWidth!);
      expect(optimisticCost(result, request.band!.key, width, request.tileWidth!, request.items)).toBeLessThanOrEqual(complete + 1e-7);
    }
  });
  it("rejects a physical route gap even when a long segment makes its relative distance tiny", () => {
    const items = [
      { key: "root", width: 10, height: 10, order: 0, parents: [] },
      { key: "child", width: 10, height: 10, order: 1, parents: ["root"] },
    ];
    const result = { orientation: "down" as const, width: 100020, height: 10020,
      nodes: new Map(items.map((n, i) => [n.key, { ...n, x: i ? 100005 : 0, y: i ? 10000 : 0, row: i, band: i }])),
      junctions: new Map(), rows: [], readingOrder: new Map(), routes: [
        { id: "trunk", from: { kind: "node" as const, id: "root" }, to: { kind: "node" as const, id: "root" }, consumers: [{ parent: "root", child: "child" }], terminal: false, path: "M5 10 L5 9984 L100005 9984" },
        { id: "terminal", from: { kind: "node" as const, id: "root" }, to: { kind: "node" as const, id: "child" }, consumers: [{ parent: "root", child: "child" }], terminal: true, path: "M100010 9984 L100010 9992" },
      ] };
    const metrics = measure(result, "root", 100020, items);
    expect(metrics.disconnectedEdges).toBe(1);
    expect(cost(metrics, 10)).toBe(Infinity);
  });
  it("detects segment penetration between samples and distinguishes crossings from shared spans", () => {
    const tile = { key: "x", x: 40, y: 40, width: 20, height: 20, row: 0, band: 0 };
    expect(intersectsTile([{ x: 0, y: 50 }, { x: 100, y: 50 }], tile)).toBe(true);
    expect(crossing([{ x: 0, y: 50 }, { x: 100, y: 50 }], [{ x: 50, y: 0 }, { x: 50, y: 100 }])).toEqual({ x: 50, y: 50 });
    expect(overlapLength([{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 25, y: 0 }, { x: 75, y: 0 }])).toBe(50);
  });
  it("rejects missing nodes, invalid paths, wrong arrows, missing parentage and off-canvas geometry", () => {
    const request = requestFor(screenshot, "Saffron", 454, 96), result = placed(request);
    for (const invalid of [
      { ...result, nodes: new Map([...result.nodes].filter(([id]) => id !== "Ash")) },
      { ...result, routes: [] },
      { ...result, routes: result.routes.map(r => ({ ...r, path: "garbage M0 0 L10 10" })) },
      { ...result, nodes: new Map([...result.nodes].map(([id, n]) => [id, { ...n, x: -1000 }])) },
    ]) expect(cost(measure(invalid, "root", 454, request.items), 140)).toBe(Infinity);
  });
});
