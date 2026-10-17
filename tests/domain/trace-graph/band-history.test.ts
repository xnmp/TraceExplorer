import { describe, expect, it } from "vitest";
import { expectArrivalPinned } from "./arrival-contract";
import { bandHistorySignature, historyFit, resizedLayout, resizedTiles } from "$lib/domain/trace-graph/band-history";
import type { GraphLayout, LayoutItem, LayoutRequest, PlacedNode } from "$lib/domain/trace-graph/layout";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";
import { intersectsTile, overlapLength, segments } from "$lib/domain/trace-graph/layout-quality";

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
  it("keeps history when a tile loses its last output (a failed placeholder, a discard), reporting it shrunk back", () => {
    const withOutput = [...base.slice(0, 2), item("b", ["root"], 2, 116), item("c", ["b"], 3)];
    expect(historyFit(bandHistorySignature(request(withOutput)), request(base))).toEqual({ kind: "grown", heights: new Map([["b", 100]]) });
  });
  it("expires on width, tile size, pin, relationship, order or other size changes", () => {
    const signature = bandHistorySignature(request(base));
    expect(historyFit(signature, request(base, { maxWidth: 900 }))).toBeNull();
    expect(historyFit(signature, request(base, { tileWidth: 108 }))).toBeNull();
    expect(historyFit(signature, request(base, { pinned: { key: "root", x: 200 } }))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["a"], 2)]))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 7)]))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 2, 90)]))).toBeNull();
    // A tile that already had an output never changes size: anything else is a different request.
    expect(historyFit(signature, request([item("root", [], 0, 130), ...base.slice(1)]))).toBeNull();
    // Nor does one that keeps an output.
    const kept = [...base.slice(0, 2), item("b", ["root"], 2, 116), item("c", ["b"], 3), item("d", ["b"], 4)];
    expect(historyFit(bandHistorySignature(request(kept)), request([...kept.slice(0, 2), item("b", ["root"], 2, 100), kept[3]]))).toBeNull();
  });
  it("expires when a tile changes height by anything but the hint", () => {
    const signature = bandHistorySignature(request(base));
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 2, 130), item("c", ["b"], 3)]))).toBeNull();
    expect(historyFit(signature, request([...base.slice(0, 2), item("b", ["root"], 2, 101), item("c", ["b"], 3)]))).toBeNull();
    const withOutput = [...base.slice(0, 2), item("b", ["root"], 2, 116), item("c", ["b"], 3)];
    expect(historyFit(bandHistorySignature(request(withOutput)), request([...base.slice(0, 2), item("b", ["root"], 2, 109)]))).toBeNull();
    expect(historyFit(bandHistorySignature(request(withOutput)), request([...base.slice(0, 2), item("b", ["root"], 2, 1)]))).toBeNull();
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

describe("resizedLayout", () => {
  it("grows a tile in place while retaining tiles in other columns", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150), node("c", 100, 300)],
      [route("a", "c", "M146 250 L146 292")]);
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("b")).toMatchObject({ x: 300, y: 150, height: 116 });
    expect(after.nodes.get("a")).toEqual(before.nodes.get("a"));
    expect(after.nodes.get("root")).toEqual(before.nodes.get("root"));
    expect(after.nodes.get("c")!.y).toBe(300);
    expectArrivalPinned(before, after);
    // The connector into c keeps its start on a's bottom and still ends at c's arrow.
    expect(pathNumbers(after.routes[0].path)).toEqual([146, 250, 146, 292]);
    expect(after.height).toBe(before.height);
  });
  it("moves only the column below a new hint by exactly 16, even when 8 pixels would suffice", () => {
    const before = layout([node("root", 300, 0), node("b", 300, 150), node("below", 300, 258), node("beside", 500, 258)]);
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("below")!.y).toBe(274);
    expect(after.nodes.get("beside")).toEqual(before.nodes.get("beside"));
    expect(after.nodes.get("root")).toEqual(before.nodes.get("root"));
    expectArrivalPinned(before, after);
  });
  it("keeps a partly shifted row's bounds around both moved and pinned members", () => {
    const before = { ...layout([node("root", 300, 0), node("b", 300, 150), node("below", 300, 258), node("beside", 500, 258)]),
      rows: [{ index: 0, band: 0, top: 258, bottom: 358, keys: ["below", "beside"] }] };
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("below")!.y).toBe(274);
    expect(after.nodes.get("beside")!.y).toBe(258);
    expect(after.rows[0]).toEqual({ ...before.rows[0], top: 258, bottom: 374 });
    expectArrivalPinned(before, after);
  });
  it("moves nothing when the row is already tall enough", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150, 116), node("b", 300, 150), node("c", 100, 300)]);
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("c")).toEqual(before.nodes.get("c"));
    expect(after.height).toBe(before.height);
  });
  it("running right, an arrival at the tile's left side follows its new centre", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150)], [route("a", "b", "M192 200 L240 200 L240 200 L292 200")], "right");
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(pathNumbers(after.routes[0].path).slice(-2)).toEqual([292, 208]);
    expect(pathNumbers(after.routes[0].path).slice(0, 2)).toEqual([192, 200]);
  });
  it("moves a connector passing under the tile within its row below it, with everything under the tile", () => {
    // a is taller than b, so b's row already has the room b needs; but a connector curves under b through it.
    const before = layout([node("root", 300, 0), node("a", 100, 150, 116), node("b", 300, 150), node("c", 300, 300)],
      [route("root", "c", "M400 100 L400 250 C400 259,346 259,346 268 L346 292")]);
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("a")).toEqual(before.nodes.get("a"));
    expect(after.nodes.get("c")!.y).toBe(316);
    expect(pathNumbers(after.routes[0].path)).toEqual([400, 100, 400, 266, 400, 275, 346, 275, 346, 284, 346, 308]);
    expect(segments(after.routes[0].path).some(s => intersectsTile(s, after.nodes.get("b")!))).toBe(false);
  });
  it("keeps a connector's start on the tile it leaves, bridging down to what moved", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150), node("d", 300, 300)],
      [route("a", "d", "M146 250 C146 259,346 259,346 268 L346 292")]);
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(pathNumbers(after.routes[0].path)).toEqual([146, 250, 146, 266, 146, 275, 346, 275, 346, 284, 346, 308]);
    expect(segments(after.routes[0].path).some(s => intersectsTile(s, after.nodes.get("b")!))).toBe(false);
  });
  it("running right, an arrival that would run along another source's line steps across before the arrow instead", () => {
    const arrival = route("a", "b", "M192 180 L240 180 L240 200 L292 200"), other = { ...route("e", "f", "M150 208 L250 208 L250 400"), id: "other" };
    const alone = resizedLayout(layout([node("root", 300, 0), node("a", 100, 130), node("b", 300, 150)], [arrival], "right"), new Map([["b", 116]]))!;
    expect(pathNumbers(alone.routes[0].path)).toEqual([192, 180, 240, 180, 240, 208, 292, 208]);
    const after = resizedLayout(layout([node("root", 300, 0), node("a", 100, 130), node("b", 300, 150)], [arrival, other], "right"), new Map([["b", 116]]))!;
    expect(pathNumbers(after.routes[0].path).slice(-2)).toEqual([292, 208]);
    const shared = segments(after.routes[0].path).reduce((sum, s) => sum + segments(other.path).reduce((t, o) => t + overlapLength(s, o), 0), 0);
    expect(shared).toBe(0);
  });
  it("shrinking a hint keeps retained positions and reuses that space on the next arrival", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150), node("d", 300, 300)],
      [route("a", "d", "M146 250 C146 259,346 259,346 268 L346 292")]);
    const grown = resizedLayout(before, new Map([["b", 116]]))!;
    const back = resizedLayout(grown, new Map([["b", 100]]))!;
    for (const [key, tile] of back.nodes) expect(tile).toEqual({ ...grown.nodes.get(key)!, ...(key === "b" ? { height: 100 } : {}) });
    expect(resizedLayout(back, new Map([["b", 116]]))).toEqual(grown);
    expectArrivalPinned(before, grown);
    const right = layout([node("root", 300, 0), node("a", 100, 144), node("b", 300, 150)], [route("a", "b", "M192 194 L240 194 L240 200 L292 200")], "right");
    const restored = resizedLayout(resizedLayout(right, new Map([["b", 112]]))!, new Map([["b", 100]]))!;
    expect(pathNumbers(restored.routes[0].path)).toEqual(pathNumbers(right.routes[0].path));
  });
  it("running right, a hint may consume existing column space while all tiles remain pinned", () => {
    // b's column stacks c 16 px under b; e, in the next column, ends exactly where c starts.
    const before = layout([node("root", 300, 0), node("b", 300, 150), node("c", 300, 266), node("e", 500, 140, 126), node("f", 500, 282)], [], "right");
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("c")!.y).toBe(266);
    expect(after.nodes.get("f")).toEqual(before.nodes.get("f"));
    expectArrivalPinned(before, after);
    expect(after.nodes.get("e")).toEqual(before.nodes.get("e"));
  });
  it("running right, keeps neighbour ports when a hint fits without a column shift", () => {
    // e reaches from above b's lower edge past c's top; its output leaves its right side at its centre, above b's edge.
    const leaving = route("e", "g", "M592 210 L640 210");
    const before = layout([node("root", 300, 0), node("b", 300, 150), node("c", 300, 266), node("e", 500, 140, 140), node("g", 648, 160)], [leaving], "right");
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.nodes.get("c")!.y).toBe(266);
    expectArrivalPinned(before, after);
    expect(after.nodes.get("e")).toEqual(before.nodes.get("e"));
    expect(after.routes[0].path).toBe(leaving.path);
  });
  it("running right, preserves unrelated lower ports and limits rerouting anchors to the hint column", () => {
    // As above, but e's output leaves below b's lower edge: a cut there would tear it off e.
    const before = layout([node("root", 300, 0), node("b", 300, 150), node("c", 300, 266), node("e", 500, 200, 120), node("g", 648, 220)],
      [route("e", "g", "M592 260 L640 260")], "right");
    const after = resizedLayout(before, new Map([["b", 116]]))!;
    expect(after.routes).toEqual(before.routes);
    expectArrivalPinned(before, after);
    const held = resizedTiles(before, new Map([["b", 116]]));
    expect(held.nodes.get("b")).toMatchObject({ y: 150, height: 116 });
    expect(held.nodes.get("c")!.y).toBe(282);
    expect(held.nodes.get("e")).toEqual(before.nodes.get("e"));
    expect(held.routes).toEqual([]);
  });
  it("running right, a shrink never pulls a tile closer to the one above it, and growing again reuses the space it left", () => {
    // b and c stack in one column, e and f in the next: f may not rise towards e because b shrank.
    const before = layout([node("root", 300, 0), node("b", 300, 150, 116), node("c", 300, 282), node("e", 500, 150), node("f", 500, 266)], [], "right");
    let current = before;
    for (let cycle = 0; cycle < 3; cycle++) {
      current = resizedLayout(current, new Map([["b", 100]]))!;
      expect(current.nodes.get("f")).toEqual(before.nodes.get("f"));
      expect(current.nodes.get("c")!.y).toBe(282);
      current = resizedLayout(current, new Map([["b", 116]]))!;
      expect(current.nodes.get("c")!.y).toBe(282);
    }
    expect([...current.nodes.values()]).toEqual([...before.nodes.values()]);
  });
  it("a tile growing towards a connector that passes under it keeps that connector clear of it", () => {
    // a is taller than b, so b's row has room; a connector crosses it 18 px under b.
    const passing = route("a", "c", "M146 270 L146 276 L250 276 L250 284 L346 284 L346 292");
    const after = resizedLayout(layout([node("root", 300, 0), node("a", 100, 150, 120), node("b", 300, 150), node("c", 300, 300)], [passing]), new Map([["b", 116]]))!;
    const b = after.nodes.get("b")!, ys = segments(after.routes[0].path).filter(([p, q]) => p.y === q.y && Math.max(p.x, q.x) > b.x).map(([p]) => p.y);
    expect(Math.min(...ys) - (b.y + b.height)).toBeGreaterThanOrEqual(3);
  });
  it("running right, declines rather than step an arrival along the edge of the tile it leaves", () => {
    // a's output runs straight into b, one arrowhead long: b's new centre can only be reached along a's edge.
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 208, 150)], [route("a", "b", "M192 200 L200 200")], "right");
    expect(resizedLayout(before, new Map([["b", 116]]))).toBeNull();
  });
  it("declines geometry it cannot read", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150), node("b", 300, 150), node("d", 300, 300)], [route("a", "d", "M146 250 l0 42")]);
    expect(resizedLayout(before, new Map([["b", 116]]))).toBeNull();
  });
  it("ignores unknown tiles and invalid heights, and never mutates its input", () => {
    const before = layout([node("root", 300, 0), node("a", 100, 150)]), copy = structuredClone(before);
    expect(resizedLayout(before, new Map([["zzz", 200], ["a", 0], ["root", NaN]]))).toEqual(before);
    resizedLayout(before, new Map([["a", 116]]));
    expect(before).toEqual(copy);
  });
});
