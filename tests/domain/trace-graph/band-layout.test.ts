import { routeConsumers } from "$lib/domain/trace-graph/route-consumers";
import { describe, expect, it } from "vitest";
import { bandWidthBudget, bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { layoutGraph, type LayoutItem, type GraphLayout } from "$lib/domain/trace-graph/layout";
import { bandExtent, attachPackedBand } from "$lib/plugins/trace/view/stack-grid";
import { samplePathString } from "$lib/domain/trace-graph/path-sampling";

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
  it("hidden topology never allocates positions or changes arrangement", () => {
    const visible = deep.slice(0, 3);
    expect(band(deep, 1150, visible)).toEqual(band(visible, 1150));
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
      for (const route of graph.routes) expect(routeConsumers(route).every(({ parent, child }) => items.find((item) => item.key === child)?.parents.includes(parent))).toBe(true);
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
  it("preserves arriving outputs' retained ancestry with an explicit attachment", () => {
    const request = { items: deep.slice(0, 3), maxWidth: 448, tileWidth: 92, pinned: { key: "root", x: 300 }, band: { key: "root", items: deep } };
    const first = layoutGraph(request);
    const placement = { x: 0, coverX: 300, coverHeight: 97, width: 448, left: 0, right: 448 };
    const placed = attachPackedBand(first, "root", 97, placement);
    const next = layoutGraph({ ...request, items: deep.slice(0, 5), anchorKey: "Saffron", history: { signature: bandHistorySignature(request), layout: first, placed, attachment: { bandTop: 97, placement } } });
    expect(next.decision?.fallback).toBeUndefined();
    assertClear(next);
  });
});
