import { describe, expect, it } from "vitest";
import { bandHistorySignature, grownLayout, historyFit } from "$lib/domain/trace-graph/band-history";
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedNode } from "$lib/domain/trace-graph/layout";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";

const item = (key: string, parents: string[] = [], order = 0, height = 100): LayoutItem => ({ key, width: 92, height, order, parents });
const request = (items: LayoutItem[], extra: Partial<LayoutRequest> = {}): LayoutRequest =>
  ({ items, maxWidth: 640, tileWidth: 92, pinned: { key: "root", x: 300 }, band: { key: "root", items }, ...extra });
const base = [item("root", [], 0, 116), item("a", ["root"], 1, 116), item("b", ["root"], 2)];

describe("historyFit", () => {
  it("recognises the same component", () => {
    expect(historyFit(bandHistorySignature(request(base)), request(base))).toEqual({ kind: "same" });
  });
  it("keeps history across growth, and reports a leaf that gained its first output", () => {
    const grown = [...base.slice(0, 2), item("b", ["root"], 2, 116), item("c", ["b"], 3)];
    expect(historyFit(bandHistorySignature(request(base)), request(grown))).toEqual({ kind: "grown", heights: new Map([["b", 116]]) });
  });
  it("keeps history when an image leaves (a discard) and the rest is unchanged", () => {
    expect(historyFit(bandHistorySignature(request(base)), request(base.slice(0, 2)))?.kind).toBe("grown");
  });
  it("expires on width, tile size, pin, relationship, order or shrinking changes", () => {
    const signature = bandHistorySignature(request(base));
    expect(historyFit(signature, request(base, { maxWidth: 900 }))).toBeNull();
    expect(historyFit(signature, request(base, { tileWidth: 108 }))).toBeNull();
    expect(historyFit(signature, request(base, { pinned: { key: "root", x: 200 } }))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["a"], 2)]))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 7)]))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 2, 90)]))).toBeNull();
    // A tile that already had an output never changes size: anything else is a different request.
    expect(historyFit(signature, request([item("root", [], 0, 130), ...base.slice(1)]))).toBeNull();
  });
  it("expires when nothing is shared, and treats malformed signatures as no history", () => {
    expect(historyFit(bandHistorySignature(request([item("x")])), request(base))).toBeNull();
    for (const bad of ["", "{", "[]", "null", JSON.stringify([640, 92, null, [["a"]]])]) expect(historyFit(bad, request(base))).toBeNull();
  });
});

const node = (key: string, x: number, y: number, height = 100, row = 0): PlacedNode => ({ key, x, y, width: 92, height, band: row, row });
const layout = (nodes: PlacedNode[], routes: GraphLayout["routes"] = [], orientation: GraphLayout["orientation"] = "down"): GraphLayout =>
  ({ orientation, width: 640, height: Math.max(...nodes.map(n => n.y + n.height)) + 14, nodes: new Map(nodes.map(n => [n.key, n])), junctions: new Map(), routes, rows: [], readingOrder: new Map() });
const route = (from: string, to: string, path: string) => ({ id: `${from}>${to}`, from: { kind: "node" as const, id: from }, to: { kind: "node" as const, id: to }, consumers: [{ parent: from, child: to }], terminal: true, path });

describe("grownLayout", () => {
  it("grows a tile in place and moves only what lies below it, by what it needs", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150), node("c", 100, 300)],
      [route("a", "c", "M146 250 L146 292")]);
    const after = grownLayout(before, new Map([["b", 116]]));
    expect(after.nodes.get("b")).toMatchObject({ x: 300, y: 150, height: 116 });
    expect(after.nodes.get("a")).toEqual(before.nodes.get("a"));
    expect(after.nodes.get("root")).toEqual(before.nodes.get("root"));
    expect(after.nodes.get("c")!.y).toBe(316);
    // The connector into c keeps its start on a's bottom and still ends at c's arrow.
    expect(pathNumbers(after.routes[0].path)).toEqual([146, 250, 146, 308]);
    expect(after.height).toBe(before.height + 16);
  });
  it("moves nothing when the row is already tall enough", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150, 116), node("b", 300, 150), node("c", 100, 300)]);
    const after = grownLayout(before, new Map([["b", 116]]));
    expect(after.nodes.get("c")).toEqual(before.nodes.get("c"));
    expect(after.height).toBe(before.height);
  });
  it("running right, an arrival at the tile's left side follows its new centre", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150)], [route("a", "b", "M192 200 L240 200 L240 200 L292 200")], "right");
    const after = grownLayout(before, new Map([["b", 116]]));
    expect(pathNumbers(after.routes[0].path).slice(-2)).toEqual([292, 208]);
    expect(pathNumbers(after.routes[0].path).slice(0, 2)).toEqual([192, 200]);
  });
  it("ignores unknown or shrinking tiles and never mutates its input", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150)]), copy = structuredClone(before);
    expect(grownLayout(before, new Map([["zzz", 200], ["a", 50]]))).toEqual(before);
    expect(before).toEqual(copy);
  });
});
