import { describe, expect, it } from "vitest";
import { packStackGroups } from "$lib/plugins/trace/view/stack-packing";
import { packedGridFlow, bandPlacements, attachPackedBand, bandExtent } from "$lib/plugins/trace/view/stack-grid";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { samplePathString } from "$lib/plugins/trace/view/path-sampling";

const group = (id: string, center: number, width = 100, height = 80) => ({ id, center, width, height });
describe("stack group packing", () => {
  it("centers a single group under its parent", () => { expect(packStackGroups([group("a", 200)], 400)[0]).toMatchObject({ x: 150, y: 0, line: 0 }); });
  it("shares a line when two centered groups fit", () => {
    expect(packStackGroups([group("a", 100), group("b", 300)], 400).map(({ x, y }) => [x, y])).toEqual([[50, 0], [250, 0]]);
  });
  it("resolves overlapping centers symmetrically, preserving order", () => {
    const packed = packStackGroups([group("a", 180), group("b", 220)], 400, 20);
    expect(packed.map(({ x, line }) => [x, line])).toEqual([[90, 0], [210, 0]]);
  });
  it("wraps only when the combined widths cannot fit, reserving the tallest group on each line", () => {
    const packed = packStackGroups([group("a", 100, 200, 90), group("b", 300, 200, 140)], 350, 16);
    expect(packed.map(({ x, y, line }) => [x, y, line])).toEqual([[0, 0, 0], [150, 106, 1]]);
    expect(packStackGroups([group("wide", 100, 500), group("b", 300)], 350).map(({ line, x }) => [line, x])).toEqual([[0, 0], [1, 250]]);
  });
  it("clamps at both edges without overlap or unnecessary wrapping", () => {
    expect(packStackGroups([group("a", -20), group("b", 500)], 400).map(({ x }) => x)).toEqual([0, 300]);
    const packed = packStackGroups([group("a", 390), group("b", 400)], 400, 20);
    expect(packed.map(({ x, line }) => [x, line])).toEqual([[180, 0], [300, 0]]);
  });
  it("handles empty input and rejects malformed dimensions, centers and duplicate identities", () => {
    expect(packStackGroups([], 0)).toEqual([]);
    for (const width of [-1, Infinity, NaN]) expect(() => packStackGroups([], width)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", 0)], 0)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", NaN)], 400)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", 0, Infinity)], 400)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", 0, 10, -1)], 400)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", 0), group("a", 100)], 400)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", 0, Number.MAX_VALUE)], Number.MAX_VALUE, Number.MAX_VALUE)).toThrow(RangeError);
    expect(() => packStackGroups([group("a", -Number.MAX_VALUE, Number.MAX_VALUE)], Number.MAX_VALUE)).toThrow(RangeError);
  });
});

describe("shared grid row band", () => {
  const metrics = { cellWidth: 100, cellHeight: 100, columnGap: 10, rowGap: 10 };
  const items = [{ id: "a", kind: "stack" as const }, { id: "b", kind: "stack" as const }, { id: "file", kind: "file" as const }];
  it("advances subsequent rows once by the shared band's maximum height", () => {
    const flow = packedGridFlow(items, new Map([["a", { width: 90, height: 80 }], ["b", { width: 90, height: 120 }]]), 2, metrics);
    expect(flow.bands.map(({ y }) => y)).toEqual([100, 100]);
    expect(flow.rowBands).toHaveLength(1);
    expect(flow.cells.get("file")?.y).toBe(230);
    expect(flow.height).toBe(330);
  });
  it("adds wrapped lines within that band without moving any cover horizontally", () => {
    const flow = packedGridFlow(items, new Map([["a", { width: 140, height: 80 }], ["b", { width: 140, height: 120 }]]), 2, metrics);
    expect(flow.bands.map(({ y }) => y)).toEqual([100, 196]);
    expect(flow.cells.get("b")?.x).toBe(110);
    expect(flow.rowBands[0].height).toBe(216);
    expect(flow.cells.get("file")?.y).toBe(326);
  });
  it("keeps a displaced parent's stem in its connector envelope and finds a nearby empty wrapped lane", () => {
    const flow = packedGridFlow(items, new Map([["a", { width: 140, height: 80 }], ["b", { width: 140, height: 120 }]]), 2, metrics);
    const placement = bandPlacements(flow, 100).get("b")!;
    expect(placement.bridge!.gutter).toBeGreaterThanOrEqual(flow.bands[0].x + flow.bands[0].width - 4);
    expect(placement.bridge!.gutter).toBeLessThan(flow.width);
    expect(placement.left).toBeLessThanOrEqual(placement.coverX);
    expect(placement.right).toBeGreaterThanOrEqual(placement.coverX);
    const graph = layoutGraph({ maxWidth: 210, pinned: { key: "b", x: 155 }, items: [{ key: "b", parents: [], width: 92, height: 97, order: 0 }, { key: "child", parents: ["b"], width: 92, height: 81, order: 1 }] });
    const attached = attachPackedBand(graph, "b", 196, placement);
    expect(attached.nodes.get("b")!.x + 46).toBe(160);
    expect(attached.nodes.get("b")!.height).toBe(100);
    expect(attached.nodes.get("child")!.x).toBe(placement.x + graph.nodes.get("child")!.x - bandExtent(graph, "b").left);
    for (const route of attached.routes) for (const point of samplePathString(route.path, 100) ?? []) {
      expect(point.x).toBeGreaterThanOrEqual(placement.left);
      expect(point.x).toBeLessThanOrEqual(placement.right);
    }
    const terminal = attached.routes.find((route) => route.terminal)!;
    const coordinates = terminal.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const end = coordinates.slice(-2), approach = coordinates.slice(-4, -2);
    // An arrowhead needs a straight final approach, not just a vertical tangent on a curve.
    expect(terminal.path).toMatch(/ L[^L]+$/);
    expect(approach[0]).toBe(end[0]);
    expect(end[1] - approach[1]).toBe(8);
  });
});
