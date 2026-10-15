import { NO_EXPANSION } from "$lib/domain/trace-graph/expansion";
import { describe, expect, it } from "vitest";
import { intentChange, changed, requiredComponents, resolveCover, sameStyling, sameListing, type SceneIntent } from "$lib/plugins/trace/view/scene-inputs";
import { folderCells, fallbackGridMetrics } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { FolderIndex } from "$lib/domain/trace-graph/folder-data";
import type { FileEntry } from "$lib/domain/file";

const entry = (name: string, modified = "2026-10-01"): FileEntry => ({ name, path: `/f/${name}`, kind: "file", size: 1, modified });
const summary = (id: string, coverKey: string, cover: string | null) => ({ id, title: id, cover: cover ? { path: cover, present: true } : null, coverKey, imageCount: 1, nodeCount: 1, active: false, unsaved: !cover });
const index: FolderIndex = {
  directory: "/f", token: "t",
  components: [summary("ca", "a1", "/f/a1.png"), summary("cb", "b1", "/f/b1.png")],
  members: new Map([["/f/a1.png", { componentId: "ca", key: "a1" }], ["/f/a2.png", { componentId: "ca", key: "a2" }], ["/f/b1.png", { componentId: "cb", key: "b1" }]]),
};
const tile = tileMetrics(96);
const intent: SceneIntent = {
  directory: "/f", listing: [entry("a1.png"), entry("b1.png")], claimed: new Set(), open: new Set(["a1"]), focus: null, selectedKeys: new Set(["a1"]),
  selectedPaths: new Set(), badgeHover: null, expansion: NO_EXPANSION, width: 900, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: "[]",
};

describe("scene inputs", () => {
  it("compares intents by contents, never by identity", () => {
    const rebuilt: SceneIntent = { ...intent, listing: intent.listing.map((e) => ({ ...e })), open: new Set(intent.open), selectedKeys: new Set(["a1"]), grid: { ...intent.grid }, cover: { ...intent.cover } };
    expect(changed(intentChange(intent, rebuilt))).toBe(false);
  });

  it("classifies what changed", () => {
    expect(intentChange(intent, { ...intent, width: 910 })).toMatchObject({ resize: true, metrics: false, other: false });
    expect(intentChange(intent, { ...intent, tile: tileMetrics(64) })).toMatchObject({ resize: false, metrics: true });
    expect(intentChange(intent, { ...intent, listing: [entry("a1.png", "2026-10-02"), entry("b1.png")] })).toMatchObject({ listing: true });
    expect(intentChange(intent, { ...intent, hostChoice: "[\"/f/b1.png\"]" })).toMatchObject({ hostChoice: true, other: false });
    expect(intentChange(intent, { ...intent, open: new Set() })).toMatchObject({ other: true, listing: false });
    expect(intentChange(null, intent)).toMatchObject({ directory: true });
  });

  it("compares listings by entry contents and order", () => {
    expect(sameListing(intent.listing, intent.listing.map((e) => ({ ...e })))).toBe(true);
    expect(sameListing(intent.listing, [...intent.listing].reverse())).toBe(false);
  });

  it("requires the components of requested open stacks that are grid items, except blocked ones", () => {
    const cells = folderCells(intent.listing, index);
    expect([...requiredComponents(cells, new Set(["a1", "b1", "gone"]), new Set())]).toEqual([["a1", "ca"], ["b1", "cb"]]);
    expect([...requiredComponents(cells, new Set(["a1", "b1"]), new Set(["b1"]))]).toEqual([["a1", "ca"]]);
  });

  it("resolves a stable key to the cover now holding it, after a merge", () => {
    expect(resolveCover(index, "a1")).toBe("a1");
    expect(resolveCover(index, "a2")).toBe("a1");
    const merged: FolderIndex = { ...index, components: [summary("cab", "a1", "/f/a1.png")], members: new Map([["/f/b1.png", { componentId: "cab", key: "b1" }], ["/f/a1.png", { componentId: "cab", key: "a1" }]]) };
    expect(resolveCover(merged, "b1")).toBe("a1");
    expect(resolveCover(merged, "missing")).toBeNull();
  });

  it("compares styling by contents, cover chrome included", () => {
    const styling = { focus: "a1", selectedKeys: new Set(["a1"]), selectedPaths: new Set<string>(), badgeHover: null, cover: { imagePx: null, small: false } };
    expect(sameStyling(styling, { ...styling, selectedKeys: new Set(["a1"]), cover: { imagePx: null, small: false } })).toBe(true);
    expect(sameStyling(styling, { ...styling, selectedKeys: new Set(["a1", "x"]) })).toBe(false);
    expect(sameStyling(styling, { ...styling, cover: { imagePx: 64, small: false } })).toBe(false);
    expect(sameStyling(styling, { ...styling, badgeHover: "r" })).toBe(false);
  });
});
