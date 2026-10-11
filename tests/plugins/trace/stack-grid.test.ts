import { describe, expect, it } from "vitest";
import { folderCells, attachBand, gridNeighbor, gridPins } from "$lib/plugins/trace/view/stack-grid";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { gridFlow } from "$lib/domain/trace-graph/grid-flow";
import { samplePathString } from "$lib/plugins/trace/view/path-sampling";
import type { FolderIndex } from "$lib/plugins/trace/view/folder-session.svelte";
import type { FileEntry } from "$lib/domain/file";
const entry = (path: string, kind: FileEntry["kind"] = "file") => ({ path, name: path, kind } as FileEntry);
const summary = (id: string, path: string | null) => ({ id, title: id, cover: path ? { path, present: true } : null, imageCount: 2, nodeCount: 2, active: false, unsaved: false });
const index: FolderIndex = { directory: "/p", token: "v1", components: [summary("c:a:1", "/p/a"), summary("c:a:4", "/p/b"), summary("c:o:8:0", null)],
  members: new Map([["/p/a", { key: "a:1", componentId: "c:a:1" }], ["/p/a-edit", { key: "o:2:0", componentId: "c:a:1" }], ["/p/b", { key: "a:4", componentId: "c:a:4" }]]) };

describe("folder grid rules", () => {
  it("collapses each lineage at its cover's host-sorted position, preserving folders and ordinary files", () => {
    const cells = folderCells([entry("/p/refs", "directory"), entry("/p/a-edit"), entry("/p/notes"), entry("/p/b"), entry("/p/a")], index);
    expect(cells.map(({ id, kind }) => [id, kind])).toEqual([["/p/refs", "folder"], ["/p/notes", "file"], ["a:4", "stack"], ["a:1", "stack"], ["o:8:0", "stack"]]);
  });
  it("retains cover identity across a merge that replaces component ids", () => {
    const merged = { ...index, components: [summary("c:new", "/p/a")], members: new Map([["/p/a", { key: "a:1", componentId: "c:new" }], ["/p/b", { key: "a:4", componentId: "c:new" }]]) };
    expect(folderCells([entry("/p/a"), entry("/p/b")], merged).map((cell) => cell.id)).toEqual(["a:1"]);
  });
  it("handles empty folders", () => { expect(folderCells([], { ...index, components: [], members: new Map() })).toEqual([]); });
  it("attaches several bands to the same pinned cover without changing any x or losing parentage", () => {
    const layout = layoutGraph({ items: [{ key: "cover", width: 92, height: 97, order: 0, parents: [] }, { key: "child", width: 92, height: 97, order: 1, parents: ["cover"] }], maxWidth: 700, pinned: { key: "cover", x: 650 } });
    const cover = layout.nodes.get("cover")!;
    const attached = attachBand(layout, "cover", 0, 500);
    expect(attached.nodes.get("cover")!.y).toBe(0);
    expect(attached.nodes.get("child")!.y).toBe(layout.nodes.get("child")!.y - cover.y - cover.height + 500);
    for (const [id, node] of attached.nodes) expect(node.x).toBe(layout.nodes.get(id)!.x);
    expect(attached.routes.map(({ from, to }) => [from, to])).toEqual(layout.routes.map(({ from, to }) => [from, to]));
    expect(attached.height).toBe(layout.height - cover.y - cover.height + 500);
    expect(layout.nodes.get("cover")).toBe(cover);
  });
  it("routes a later same-row cover around every earlier band's tiles", () => {
    const make = (key: string, x: number, count: number) => layoutGraph({ maxWidth: 400, pinned: { key, x }, items: [{ key, width: 92, height: 97, order: 0, parents: [] }, ...Array.from({ length: count }, (_, i) => ({ key: `${key}${i}`, width: 92, height: 97, order: i + 1, parents: [key] }))] });
    const first = attachBand(make("a", 47, 3), "a", 0, 97);
    const second = attachBand(make("b", 149, 1), "b", 0, first.height, { top: 99, gutter: 4 });
    const obstacles = [...first.nodes].filter(([key]) => key !== "a").map(([, node]) => node);
    for (const route of second.routes) for (const point of samplePathString(route.path, 150) ?? []) {
      expect(obstacles.some((node) => point.x > node.x && point.x < node.x + node.width && point.y > node.y && point.y < node.y + node.height)).toBe(false);
    }
  });
  it("pins only open stacks and includes just their own row's obstacles", () => {
    const flow = gridFlow([{ id: "a", kind: "stack" }, { id: "ordinary", kind: "file" }, { id: "b", kind: "stack" }], new Map(), 2, { cellWidth: 92, cellHeight: 97, columnGap: 8, rowGap: 8 });
    const pins = gridPins(flow, new Set(["a", "unknown"]));
    expect([...pins.keys()]).toEqual(["a"]);
    expect(pins.get("a")).toEqual({ key: "a", x: 46, obstacles: [{ x: 100, width: 92 }] });
  });
  it("navigates between covers, ordinary entries and band tiles by their displayed geometry", () => {
    const rects = new Map([["cover", { x: 100, y: 0, width: 90, height: 90 }], ["ordinary", { x: 200, y: 0, width: 90, height: 90 }], ["child", { x: 100, y: 200, width: 90, height: 90 }]]);
    expect(gridNeighbor(rects, "cover", "ArrowRight")).toBe("ordinary");
    expect(gridNeighbor(rects, "cover", "ArrowDown")).toBe("child");
    expect(gridNeighbor(rects, "child", "ArrowUp")).toBe("cover");
    const late = new Map([...rects, ["last", { x: 0, y: 500, width: 90, height: 90 }] as const]);
    expect(gridNeighbor(late, "cover", "End")).toBe("last");
    expect(gridNeighbor(late, "last", "Home")).toBe("cover");
    expect(gridNeighbor(rects, "cover", "ArrowLeft")).toBeNull();
    expect(gridNeighbor(rects, "missing", "ArrowDown")).toBeNull();
    expect(gridNeighbor(new Map(), "cover", "Home")).toBeNull();
  });
});
