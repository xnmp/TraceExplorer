import { describe, expect, it } from "vitest";
import { gridFlow } from "$lib/domain/trace-graph/grid-flow";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { sameGraphGeometry, sameGridGeometry } from "$lib/domain/trace-graph/layout-geometry";

describe("motion geometry equality", () => {
  const items = [{ id: "a", kind: "stack" as const }, { id: "b", kind: "file" as const }];
  const grid = (height = 100) => gridFlow(items, new Map([["a", height]]), 1, { cellWidth: 92, cellHeight: 97, columnGap: 8, rowGap: 8 });
  it("ignores refreshed grid objects, but detects resized bands and replaced cells", () => {
    expect(sameGridGeometry(grid(), grid())).toBe(true);
    expect(sameGridGeometry(grid(), grid(101))).toBe(false);
    const next = grid();
    expect(sameGridGeometry(grid(), { ...next, cells: new Map([...next.cells].map(([id, rect]) => [id === "b" ? "c" : id, rect])) })).toBe(false);
  });
  const request = { maxWidth: 400, items: [{ key: "a", parents: [], width: 92, height: 97, order: 0 }, { key: "b", parents: ["a"], width: 92, height: 81, order: 1 }] };
  it("ignores cache identity and equivalent ordering hints, but detects moved tiles and routes", () => {
    const layout = layoutGraph(request);
    expect(sameGraphGeometry(layout, layoutGraph({ ...request, hint: layout.readingOrder }))).toBe(true);
    expect(sameGraphGeometry(layout, { ...layout, nodes: new Map(layout.nodes).set("b", { ...layout.nodes.get("b")!, x: 1 }) })).toBe(false);
    expect(sameGraphGeometry(layout, { ...layout, routes: layout.routes.map((route) => ({ ...route, path: "M0 0 L1 1" })) })).toBe(false);
    expect(sameGraphGeometry(layout, { ...layout, junctions: new Map([["j", { id: "j", x: 1, y: 1, parents: [] }]]) })).toBe(false);
  });
});
