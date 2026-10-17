import { describe, expect, it } from "vitest";
import { packStackGroups } from "$lib/plugins/trace/view/stack-packing";
import { packedGridFlow, bandPlacements, attachPackedBand, bandExtent } from "$lib/plugins/trace/view/stack-grid";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { ARROW, LANE_SEPARATION, STACK_STEM_ROOM, TRACK_HEIGHT } from "$lib/domain/trace-graph/metrics";
import { samplePathString } from "$lib/domain/trace-graph/path-sampling";

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
  it("attaches side-by-side groups whose lanes cannot meet as lone bands, aligned and unmoved by the other opening", () => {
    const lone = bandPlacements(packedGridFlow(items, new Map([["a", { width: 90, height: 80 }]]), 2, metrics), 100).get("a")!;
    const both = bandPlacements(packedGridFlow(items, new Map([["a", { width: 90, height: 80 }], ["b", { width: 90, height: 120 }]]), 2, metrics), 100);
    for (const id of ["a", "b"]) expect({ track: both.get(id)!.track, stemRoom: both.get(id)!.stemRoom }).toEqual({ track: lone.track, stemRoom: lone.stemRoom });
    expect(lone.stemRoom).toBe(STACK_STEM_ROOM);
  });
  it("keeps separate, separated tracks when one group's lane passes another's", () => {
    const flow = packedGridFlow(items, new Map([["a", { width: 140, height: 80 }], ["b", { width: 140, height: 120 }]]), 2, metrics);
    const [a, b] = ["a", "b"].map((id) => bandPlacements(flow, 100).get(id)!);
    expect(b.track! - a.track!).toBeGreaterThanOrEqual(TRACK_HEIGHT + LANE_SEPARATION + 1);
    expect(b.stemRoom!).toBeGreaterThanOrEqual(b.track! + 2 * ARROW.length);
  });
  it("adds wrapped lines within that band without moving any cover horizontally", () => {
    const flow = packedGridFlow(items, new Map([["a", { width: 140, height: 80 }], ["b", { width: 140, height: 120 }]]), 2, metrics);
    expect(flow.bands.map(({ y }) => y)).toEqual([100, 186]);
    expect(flow.cells.get("b")?.x).toBe(110);
    expect(flow.rowBands[0].height).toBe(222);
    expect(flow.cells.get("file")?.y).toBe(332);
  });
  for (const childX of [20, 155, 160, 260]) {
    it(`leaves only bend room before routing to a child at ${childX}`, () => {
      const graph = layoutGraph({ maxWidth: 400, pinned: { key: "cover", x: 160 }, items: [
        { key: "cover", parents: [], width: 92, height: 97, order: 0 },
        { key: "child", parents: ["cover"], width: 92, height: 81, order: 1 },
      ] });
      const originalChild = graph.nodes.get("child")!, cover = graph.nodes.get("cover")!;
      const x = bandExtent(graph, "cover").left + childX - originalChild.x - originalChild.width / 2;
      const attached = attachPackedBand(graph, "cover", 100, { x, coverX: 160, coverHeight: 100, width: 400, left: 0, right: 400 });
      const route = attached.routes.find((route) => route.from.kind === "node" && route.from.id === "cover")!;
      const samples = samplePathString(route.path, 600)!;
      expect(samples[0]).toEqual({ x: 160, y: 100 });
      for (const point of samples.filter((point) => point.y < 100 + 6)) expect(point.x).toBeCloseTo(160, 5);
      expect(samples.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      expect(samples.at(-1)!.x).toBeCloseTo(childX, 5);
      expect(samples.at(-1)!.y).toBeLessThan(attached.nodes.get("child")!.y);
      expect(attached.nodes.get("child")!.y).toBe(100 + STACK_STEM_ROOM);
      expect(attached.height).toBe(graph.height - originalChild.y + 100 + STACK_STEM_ROOM);
      // The header is reserved in packing as well as attachment, so later rows cannot overlap it.
      expect(bandExtent(graph, "cover").height).toBe(graph.height - originalChild.y + STACK_STEM_ROOM);
    });
  }
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
      if (point.y < 100 + 6) expect(point.x).toBeCloseTo(placement.coverX, 5);
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

describe("skyline compaction", () => {
  it("raises a wrapped group into the space beside a shorter group", () => {
    const packed = packStackGroups([group("tall", 50, 100, 300), group("short", 200, 100, 80), group("later", 300, 180, 80)], 350);
    const later = packed.find((group) => group.id === "later")!;
    expect(later.y).toBe(96);
    expect(later.x).toBeGreaterThanOrEqual(116);
    expect(Math.max(...packed.map((group) => group.y + group.height))).toBe(300);
  });
  it("keeps earlier placements stable as a later group opens, and leaves every rectangle disjoint", () => {
    const initial = [group("a", 50, 100, 300), group("b", 200, 100, 80)];
    const before = packStackGroups(initial, 350), after = packStackGroups([...initial, group("c", 300, 180, 80)], 350);
    expect(after.slice(0, 2)).toEqual(before);
    for (const a of after) for (const b of after) if (a.id < b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  });
});

describe("independent cover stems", () => {
  it("allocates distinct bend tracks and bypass lanes for seven wrapped groups", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, kind: "stack" as const }));
    const flow = packedGridFlow(items, new Map(items.map(({ id }) => [id, { width: 648, height: 130 }])), 7, { cellWidth: 100, cellHeight: 100, columnGap: 0, rowGap: 0 });
    const placements = [...bandPlacements(flow, 100).values()];
    expect(new Set(placements.map((placement) => placement.track)).size).toBe(7);
    const gutters = placements.flatMap((placement) => placement.bridge ? [placement.bridge.gutter] : []);
    for (const a of gutters) for (const b of gutters) if (a < b) expect(b - a).toBeGreaterThanOrEqual(3.5);
    expect(new Set(gutters).size).toBe(gutters.length);
  });
  it("packs a single child footprint, thirty fan-out groups, a fifteen-deep footprint and a sub-tile pane without overlaps", () => {
    for (const groups of [[group("one", 46, 108, 115)], Array.from({ length: 30 }, (_, i) => group(`${i}`, i * 100, 108, 115)), [group("chain", 46, 108, 1500)]]) {
      for (const width of [50, 140, 1150]) {
        const packed = packStackGroups(groups, width);
        expect(packed.length).toBe(groups.length);
        for (const a of packed) for (const b of packed) if (a.id < b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
  });
});

it("keeps skyline bridge bends outside a taller neighbour's routing rectangle", async () => {
  const { coverGutters } = await import("$lib/plugins/trace/view/stack-packing");
  const groups = [
    { ...group("wide", 250, 650, 130), x: 0, y: 0, line: 0 },
    { ...group("tall-right", 600, 502, 300), x: 286, y: 130, line: 1 },
    { ...group("later-left", 740, 216, 157), x: 54, y: 250, line: 2 },
  ];
  const gutters = coverGutters(groups, 842)!;
  expect(gutters).not.toBeNull();
  expect(gutters.get("later-left")).toBeLessThanOrEqual(290);
});

it("keeps a displaced child's approach off another cover's initial stem", async () => {
  const { sharedLanes } = await import("../../domain/trace-graph/fixtures");
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `g${i}root`, kind: "stack" as const }));
  const graphs = items.map(({ id }, i) => {
    const nodes = [{ key: id, parents: [], width: 92, height: 81, order: 0 }, ...Array.from({ length: i ? 1 : 3 }, (_, j) => ({ key: `g${i}c${j}`, parents: [j ? `g${i}c${j - 1}` : id], width: 92, height: 81, order: j + 1 }))];
    return layoutGraph({ items: nodes, maxWidth: 602, tileWidth: 92, pinned: { key: id, x: (i + .5) * 602 / 6 }, band: { key: id, items: nodes } });
  });
  const flow = packedGridFlow(items, new Map(graphs.map((graph, i) => [items[i].id, bandExtent(graph, items[i].id)])), 6, { cellWidth: 602 / 6 - 10, cellHeight: 100, columnGap: 10, rowGap: 10 });
  const placements = bandPlacements(flow, 100);
  const attached = graphs.map((graph, i) => attachPackedBand(graph, items[i].id, flow.bands.find((band) => band.id === items[i].id)!.y, placements.get(items[i].id)!));
  const merged = { ...attached[0], nodes: new Map(attached.flatMap((graph) => [...graph.nodes])), routes: attached.flatMap((graph) => graph.routes) };
  expect(sharedLanes({ ...merged, orientation: "down" })).toEqual([]);
  expect(sharedLanes({ ...merged, orientation: "right" })).toEqual([]);
});
