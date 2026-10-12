import { describe, expect, it } from "vitest";
import { folderCells, pendingListingPaths, unlistedCovers, attachBand, gridNeighbor, gridPins, rovingStop } from "$lib/plugins/trace/view/stack-grid";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { gridFlow } from "$lib/domain/trace-graph/grid-flow";
import type { FolderIndex } from "$lib/plugins/trace/view/folder-session.svelte";
import type { FileEntry } from "$lib/domain/file";
const entry = (path: string, kind: FileEntry["kind"] = "file") => ({ path, name: path, kind } as FileEntry);
const summary = (id: string, path: string | null, coverKey = id.slice(2)) => ({ id, title: id, cover: path ? { path, present: true } : null, coverKey, imageCount: 2, nodeCount: 2, active: false, unsaved: false });
const index: FolderIndex = { directory: "/p", token: "v1", components: [summary("c:a:1", "/p/a"), summary("c:a:4", "/p/b"), summary("c:o:8:0", null)],
  members: new Map([["/p/a", { key: "a:1", componentId: "c:a:1" }], ["/p/a-edit", { key: "o:2:0", componentId: "c:a:1" }], ["/p/b", { key: "a:4", componentId: "c:a:4" }]]) };

describe("folder grid rules", () => {
  it("holds listing additions from any pane until the index can classify them", () => {
    const before = [entry("/p/a"), entry("/p/notes"), entry("/p/refs", "directory")];
    const indexedPaths = new Set(before.map((entry) => entry.path));
    const listing = [entry("/p/draft"), ...before, entry("/p/new-file")];
    const pending = pendingListingPaths(listing, index, indexedPaths);
    expect(pending).toEqual(new Set(["/p/draft", "/p/new-file"]));
    expect(folderCells(listing, index, new Set(), pending).map((cell) => cell.id))
      .toEqual(folderCells(before, index).map((cell) => cell.id));
    // A fresh read maps the save into its lineage, and admits an ordinary new file.
    const refreshed: FolderIndex = { ...index, members: new Map([...index.members, ["/p/draft", { key: "o:8:0", componentId: "c:o:8:0" }]]) };
    expect(pendingListingPaths(listing, refreshed, indexedPaths)).toEqual(new Set(["/p/new-file"]));
    const settled = pendingListingPaths(listing, refreshed, new Set(listing.map((entry) => entry.path)));
    expect(settled.size).toBe(0);
    expect(folderCells(listing, refreshed, new Set(), settled).map((cell) => cell.id))
      .toEqual(["a:1", "/p/notes", "/p/refs", "/p/new-file", "a:4", "o:8:0"]);
    expect(pendingListingPaths([], null, new Set())).toEqual(new Set());
  });
  it("never hides a listed file after the index read failed", () => {
    const before = [entry("/p/a"), entry("/p/notes")];
    const listing = [...before, entry("/p/new-file")];
    expect(pendingListingPaths(listing, index, new Set(before.map((entry) => entry.path)), true)).toEqual(new Set());
    expect(folderCells(listing, index, new Set(), new Set()).map((cell) => cell.id)).toContain("/p/new-file");
  });
  it("collapses each lineage at its cover's host-sorted position, preserving folders and ordinary files", () => {
    const cells = folderCells([entry("/p/refs", "directory"), entry("/p/a-edit"), entry("/p/notes"), entry("/p/b"), entry("/p/a")], index);
    expect(cells.map(({ id, kind }) => [id, kind])).toEqual([["/p/refs", "folder"], ["/p/notes", "file"], ["a:4", "stack"], ["a:1", "stack"], ["o:8:0", "stack"]]);
  });
  it("retains cover identity across a merge that replaces component ids", () => {
    const merged = { ...index, components: [summary("c:new", "/p/a", "a:1")], members: new Map([["/p/a", { key: "a:1", componentId: "c:new" }], ["/p/b", { key: "a:4", componentId: "c:new" }]]) };
    expect(folderCells([entry("/p/a"), entry("/p/b")], merged).map((cell) => cell.id)).toEqual(["a:1"]);
  });
  it("takes an unsaved cover's identity from the component's cover, not its id (which follows another member)", () => {
    const joined = { ...index, components: [summary("c:a:5", "/managed/draft.png", "o:7:0")], members: new Map([["/p/source", { key: "a:5", componentId: "c:a:5" }]]) };
    const [cell] = folderCells([entry("/p/source")], joined);
    expect([cell.id, cell.coverKey, cell.entry]).toEqual(["o:7:0", "o:7:0", undefined]);
  });
  it("keys an in-place edit's stack by its root revision, not the newest revision its path maps to", () => {
    const edited = { ...index, components: [summary("c:a:1", "/p/photo", "a:1")], members: new Map([["/p/photo", { key: "o:5:0", componentId: "c:a:1" }]]) };
    const [cell] = folderCells([entry("/p/photo")], edited);
    expect([cell.id, cell.coverKey, cell.entry?.path]).toEqual(["a:1", "a:1", "/p/photo"]);
  });
  describe("unlisted (unsaved) stacks", () => {
    const stacks = (...keys: string[]) => keys.map((key) => summary(`c:${key}`, null, key));
    const withComponents = (components: ReturnType<typeof stacks>): FolderIndex => ({ ...index, components, members: new Map() });
    const order = (components: ReturnType<typeof stacks>) => folderCells([], withComponents(components)).map((cell) => cell.id);
    it("keep creation order, oldest first, whatever order the index lists them in", () => {
      expect(order(stacks("o:9:0", "o:7:0", "o:8:0"))).toEqual(["o:7:0", "o:8:0", "o:9:0"]);
      expect(order(stacks("o:7:0", "o:9:0", "o:8:0"))).toEqual(["o:7:0", "o:8:0", "o:9:0"]);
    });
    it("never move another stack's cell when any stack gains a member", () => {
      // Gaining a member makes a stack the most recently active, which reorders the index.
      const before = ["o:7:0", "o:9:0", "o:12:0"];
      for (const grown of before) {
        const reordered = [grown, ...before.filter((key) => key !== grown)];
        const after = order(stacks(...reordered).map((s) => s.coverKey === grown ? { ...s, nodeCount: s.nodeCount + 1 } : s));
        expect(after).toEqual(order(stacks(...before)));
      }
    });
    it("order mixed artifact and run keys and tolerate keys of another shape", () => {
      expect(order(stacks("zzz", "o:3:1", "a:2", "o:3:0"))).toEqual(["a:2", "o:3:0", "o:3:1", "zzz"]);
    });
  });
  it("saving an unsaved stack's cover moves no cell when its place is held", () => {
    const draft = (cover: string) => summary("c:a:5", cover, "o:7:0");
    const unsaved: FolderIndex = { ...index, components: [summary("c:a:1", "/p/a"), draft("/managed/draft.png")], members: new Map([["/p/a", { key: "a:1", componentId: "c:a:1" }]]) };
    // Saved: the draft's file now sorts first in the listing, and is a member of its stack.
    const saved: FolderIndex = { ...index, components: [summary("c:a:1", "/p/a"), draft("/p/0-draft")], members: new Map([["/p/a", { key: "a:1", componentId: "c:a:1" }], ["/p/0-draft", { key: "o:7:0", componentId: "c:a:5" }]]) };
    const before = folderCells([entry("/p/a"), entry("/p/notes")], unsaved);
    const held = unlistedCovers(before, new Set());
    expect(held).toEqual(new Set(["o:7:0"]));
    const listing = [entry("/p/0-draft"), entry("/p/a"), entry("/p/notes")];
    expect(folderCells(listing, saved, held).map((cell) => cell.id)).toEqual(before.map((cell) => cell.id));
    // A fresh layout forgets the history and follows the listing.
    expect(folderCells(listing, saved).map((cell) => cell.id)).toEqual(["o:7:0", "a:1", "/p/notes"]);
  });
  it("treats a listed path the view knows belongs to a stack as part of it before the index maps it", () => {
    const listing = [entry("/p/a"), entry("/p/draft"), entry("/p/notes")];
    const ids = (claimed?: string[]) => folderCells(listing, index, new Set(), new Set(claimed)).map((cell) => cell.id);
    expect(ids()).toContain("/p/draft");
    expect(ids(["/p/draft"])).not.toContain("/p/draft");
    // Once the index maps it, it is a member and no claim is needed.
    const mapped: FolderIndex = { ...index, members: new Map([...index.members, ["/p/draft", { key: "a:1", componentId: "c:a:1" }]]) };
    expect(folderCells(listing, mapped, new Set(), new Set(["/p/draft"])).map((cell) => cell.id)).toEqual(folderCells(listing, mapped).map((cell) => cell.id));
  });
  describe("vertical navigation between tiles of different heights", () => {
    const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, row: 0, col: 0 }) as never;
    // evening and rain share a row; quiet hangs below rain only. rain is taller (it carries a hint).
    const rects = new Map<string, never>([["evening", box(0, 0, 90, 90)], ["rain", box(100, 0, 90, 130)], ["quiet", box(100, 140, 90, 90)], ["far", box(0, 400, 90, 90)]]);
    it("moves down to the next row, not sideways to a tile at the same height", () => {
      expect(gridNeighbor(rects, "evening", "ArrowDown")).toBe("quiet");
      expect(gridNeighbor(rects, "quiet", "ArrowUp")).toBe("rain");
    });
    it("then picks the nearest by x within that row", () => {
      const row = new Map<string, never>([["top", box(100, 0, 90, 90)], ["left", box(0, 100, 90, 90)], ["right", box(200, 100, 90, 90)], ["under", box(110, 100, 90, 90)]]);
      expect(gridNeighbor(row, "top", "ArrowDown")).toBe("under");
    });
    it("takes tiles starting inside the first candidate's extent as the same row", () => {
      const row = new Map<string, never>([["top", box(0, 0, 90, 90)], ["tall", box(300, 100, 90, 200)], ["short", box(0, 150, 90, 60)]]);
      expect(gridNeighbor(row, "top", "ArrowDown")).toBe("short");
    });
    it("stops at the first and last row", () => {
      expect(gridNeighbor(rects, "far", "ArrowDown")).toBeNull();
      expect(gridNeighbor(rects, "evening", "ArrowUp")).toBeNull();
    });
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
  it("pins only open stacks without treating neighboring covers as graph obstacles", () => {
    const flow = gridFlow([{ id: "a", kind: "stack" }, { id: "ordinary", kind: "file" }, { id: "b", kind: "stack" }], new Map(), 2, { cellWidth: 92, cellHeight: 97, columnGap: 8, rowGap: 8 });
    const pins = gridPins(flow, new Set(["a", "unknown"]));
    expect([...pins.keys()]).toEqual(["a"]);
    expect(pins.get("a")).toEqual({ key: "a", x: 46, obstacles: [] });
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

describe("roving tab stop", () => {
  const rendered = new Set(["a", "b", "tile"]);
  const owner = (key: string) => (key === "gone" ? "b" : undefined);
  it("keeps the last focused cell while it is rendered", () => { expect(rovingStop("tile", rendered, owner, "a")).toBe("tile"); });
  it("falls to the stack that held a cell that left", () => { expect(rovingStop("gone", rendered, owner, "a")).toBe("b"); });
  it("falls to the first cell when nothing is known, or the owner is also gone", () => {
    expect(rovingStop(null, rendered, owner, "a")).toBe("a");
    expect(rovingStop("unknown", rendered, owner, "a")).toBe("a");
    expect(rovingStop("gone", new Set(["a"]), owner, "a")).toBe("a");
  });
  it("names no stop for an empty grid", () => { expect(rovingStop("x", new Set(), () => undefined, null)).toBeNull(); });
});
