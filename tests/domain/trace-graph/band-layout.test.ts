import { describe, expect, it } from "vitest";
import { bandWidthBudget, chooseBandArrangement } from "$lib/domain/trace-graph/band-layout";
import { layoutGraph, type LayoutItem, type GraphLayout } from "$lib/domain/trace-graph/layout";
import { bandExtent, attachPackedBand } from "$lib/plugins/trace/view/stack-grid";
import { samplePathString } from "$lib/plugins/trace/view/path-sampling";

const item = (key: string, parents: string[] = [], order = 0): LayoutItem => ({ key, parents, order, width: 92, height: 97 });
const deep = [item("root"), item("Cerulean", ["root"], 1), item("Saffron", ["root"], 2), item("Blastoise", ["Saffron"], 3), item("Ash", ["Saffron"], 4), item("Charizard", ["Ash"], 5)];
const band = (items: readonly LayoutItem[], maxWidth = 1150, visible = items) => layoutGraph({ items: visible, maxWidth, tileWidth: 92, pinned: { key: "root", x: Math.max(46, maxWidth - 80) }, band: { key: "root", items } });
const attached = (graph: GraphLayout) => attachPackedBand(graph, "root", 100, { x: 0, coverX: 700, coverHeight: 100, width: 1150, left: 0, right: 1150 });
const assertClear = (graph: GraphLayout) => {
  for (const [id, a] of graph.nodes) for (const [other, b] of graph.nodes) if (id < other) {
    expect(a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height, `${id} / ${other}`).toBe(true);
  }
  const collisions = graph.routes.flatMap((route) => [...graph.nodes].filter(([, node]) => (samplePathString(route.path, 300) ?? []).some((point) =>
    point.x > node.x + .5 && point.x < node.x + node.width - .5 && point.y > node.y + .5 && point.y < node.y + node.height - .5)).map(([id]) => `${route.id} through ${id}`));
  expect(collisions).toEqual([]);
};

describe("compact band choice", () => {
  it("minimises height, then ink, then distance with a deterministic tie", () => {
    const down = layoutGraph({ items: [item("root")], maxWidth: 400 });
    const right = { ...down, orientation: "right" as const };
    const candidate = (layout: GraphLayout, height: number, connectorLength: number, coverDistance: number) => ({ layout, height, connectorLength, coverDistance });
    expect(chooseBandArrangement([candidate(down, 100, 1, 1), candidate(right, 90, 1000, 1000)])).toBe(right);
    expect(chooseBandArrangement([candidate(down, 100, 10, 1), candidate(right, 100, 9, 100)])).toBe(right);
    expect(chooseBandArrangement([candidate(down, 100, 10, 2), candidate(right, 100, 10, 1)])).toBe(right);
    expect(chooseBandArrangement([candidate(right, 100, 10, 1), candidate(down, 100, 10, 1)])).toBe(down);
    expect(chooseBandArrangement([])).toBeNull();
    expect(chooseBandArrangement([candidate(down, NaN, 0, 0)])).toBeNull();
  });
  it("uses width for deep branches without running the cover stem through its first column", () => {
    const graph = band(deep);
    expect(graph.orientation).toBe("right");
    expect(bandExtent(graph, "root").height).toBeLessThanOrEqual(260);
    assertClear(attached(graph));
    for (const child of ["Cerulean", "Saffron"]) {
      const route = attached(graph).routes.find((route) => route.to.id === child)!;
      expect(samplePathString(route.path, 1)![0]).toEqual({ x: 700, y: 100 });
    }
  });
  it("retains visible tile positions and arrangement across focus neighborhoods", () => {
    const first = band(deep, 1150, deep.slice(0, 3)), second = band(deep, 1151, deep.slice(0, 5));
    expect(second.orientation).toBe(first.orientation);
    for (const [id, node] of first.nodes) expect(second.nodes.get(id)).toEqual(node);
    expect(bandWidthBudget(1150)).toBe(bandWidthBudget(1151));
  });
  it("handles a single child, thirty children, fifteen generations, narrow and invalid panes, and no descendants", () => {
    const chain = [item("root"), ...Array.from({ length: 15 }, (_, i) => item(`c${i}`, [i ? `c${i - 1}` : "root"], i + 1))];
    const fan = [item("root"), ...Array.from({ length: 30 }, (_, i) => item(`f${i}`, ["root"], i + 1))];
    for (const items of [[item("root")], [item("root"), item("child", ["root"])], fan, chain, []]) for (const width of [1150, 420, 140, 50, 0, NaN, Infinity]) {
      const graph = band(items, width);
      expect(Number.isFinite(graph.width) && Number.isFinite(graph.height)).toBe(true);
      expect(graph.nodes.size).toBe(items.length);
      assertClear(graph);
      for (const route of graph.routes) expect(route.consumers.every(({ parent, child }) => items.find((item) => item.key === child)?.parents.includes(parent))).toBe(true);
    }
    const graph = band(chain, 420);
    expect(graph.orientation).toBe("right");
    expect(bandExtent(graph, "root").height).toBeLessThan(1000);
    expect(bandExtent(band([item("root")]), "root").height).toBe(0);
  });
  it("keeps junctions and all parents for multi-input DAGs", () => {
    const items = [item("root"), item("a", ["root"]), item("b", ["root"]), item("c", ["a", "b"])];
    const graph = band(items, 640);
    expect(graph.orientation).toBe("down");
    expect(graph.junctions.size).toBeGreaterThan(0);
    assertClear(graph);
  });
});

describe("band routing regressions", () => {
  it("preserves the engine's bypass for a wrapped cover child", () => {
    const items = [item("root"), ...Array.from({ length: 3 }, (_, i) => ({ ...item(`child-${i}`, ["root"], i + 1), width: 140, height: 119 }))];
    items[0] = { ...items[0], width: 140, height: 119 };
    const graph = layoutGraph({ items, maxWidth: 448, tileWidth: 140, pinned: { key: "root", x: 378 }, band: { key: "root", items } });
    assertClear(attachPackedBand(graph, "root", 100, { x: 0, coverX: 378, coverHeight: 100, width: 448, left: 0, right: 448 }));
  });
  it("enters each wrapped horizontal column through a side gutter, clearing source and target siblings", () => {
    for (const [width, edges] of [
      [438, [["a", "root"], ["b", "a"], ["c", "a"], ["d", "b"], ["e", "d"], ["f", "c"]]],
      [256, [["a", "root"], ["b", "root"], ["c", "a"], ["d", "b"], ["e", "c"], ["f", "d"], ["g", "e"], ["h", "f"]]],
    ] as const) {
      const items = [item("root"), ...edges.map(([child, parent], i) => ({ ...item(child, [parent], i + 1), height: 81 }))];
      const graph = band(items, width);
      assertClear(graph); assertClear(attached(graph));
    }
  });
  it("retains the packed origin as descendants appear", () => {
    const items = [item("root"), item("a", ["root"], 1), item("c", ["root"], 2), item("b", ["a"], 3), item("d", ["b"], 4)];
    const first = attached(band(items, 448, items.slice(0, 3))), next = attached(band(items, 448, items.slice(0, 4)));
    for (const [id, node] of first.nodes) expect(next.nodes.get(id)).toEqual(node);
  });
});

it("retains the shelf's vertical origin when a descendant lies above its parent", () => {
  const items = [item("root"), item("a", ["root"], 1), item("b", ["root"], 2), item("c", ["b"], 3), item("e", ["a"], 4), item("d", ["b"], 5), item("f", ["e"], 6)].map((node) => ({ ...node, height: 81 }));
  const first = attached(band(items, 640, items.slice(0, 3))), next = attached(band(items, 640, [items[0], items[1], items[2], items[4]]));
  for (const [id, node] of first.nodes) expect(next.nodes.get(id)).toEqual(node);
});
