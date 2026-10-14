import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, type FolderScene, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { fallbackGridMetrics } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { SceneIntent } from "$lib/plugins/trace/view/scene-inputs";
import { createSceneStore } from "$lib/plugins/trace/view/folder-snapshots";
import { estimateSavedSceneBytes, rebind, restoration, savedScene, stripHistory, type SavedScene } from "$lib/plugins/trace/view/scene-snapshots";
import { folderInput, handCase, makeFolder, sourcesOf } from "../../domain/trace-graph/folder-layout-fixtures";

const scope = { paneId: "p", directory: "/f", generation: 3 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 6 });
const [A, B] = [...folder.stacks.keys()];

function sceneFor(open: string[], previous: FolderLayout | null = null, focus: string | null = null): FolderScene {
  const input = folderInput(folder, { open, focus, width: 640, tile, grid, previous });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: { ...plain, focus } });
}
/** A scene laid out after another, so its band requests carry the earlier layout as history. */
const first = sceneFor([A, B]);
const chained = sceneFor([A, B], first.layout, [...folder.stacks.get(A)!.graph.dag.order][1]);

const intent = (change: Partial<SceneIntent> = {}): SceneIntent => ({
  directory: "/f", listing: folder.entries, claimed: new Set(), open: new Set([A, B]), focus: null, selectedKeys: new Set(), selectedPaths: new Set(),
  badgeHover: null, width: 660, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: "[]", ...change,
});
const committed = (scene: FolderScene, change: Partial<SceneIntent> = {}) => ({
  intent: intent(change), data: { index: folder.index, components: new Map() }, history: { directory: "/f", columns: scene.columns, held: new Set<string>() }, basis: "b",
});
const save = (scene = chained, paneId = "p", change: Partial<SceneIntent> = {}) => savedScene(paneId, scene, committed(scene, change));

describe("saving a committed scene", () => {
  it("drops every band request's history reference and keeps everything else", () => {
    const histories = [...chained.graphs.values()].filter((graph) => graph.plan.request.history !== undefined);
    expect(histories.length).toBeGreaterThan(0);
    const stripped = stripHistory(chained);
    for (const graph of [...stripped.graphs.values(), ...stripped.layout.graphs.values()]) {
      expect("history" in graph.plan.request).toBe(false);
      const original = chained.graphs.get(graph.id)!;
      expect(graph.layout).toBe(original.layout);
      expect(graph.attached).toBe(original.attached);
      expect(graph.plan.tiles).toBe(original.plan.tiles);
      expect({ ...graph.plan.request, history: undefined }).toEqual({ ...original.plan.request, history: undefined });
    }
    expect(stripped.records).toBe(chained.records);
    expect(stripped.navigation).toBe(chained.navigation);
    expect(stripped.inputs.layoutInput.previous).toBeNull();
  });

  it("never changes the scene it saves", () => {
    const before = [...chained.graphs.values()].map((graph) => graph.plan.request.history);
    save();
    expect([...chained.graphs.values()].map((graph) => graph.plan.request.history)).toEqual(before);
  });

  it("shares one stripped plan between a graph and its layout's graph", () => {
    const stripped = stripHistory(chained);
    for (const [id, graph] of stripped.graphs) expect(stripped.layout.graphs.get(id)!.plan).toBe(graph.plan);
  });

  it("saves a scene without history as it is", () => {
    const plainScene = sceneFor([]);
    expect(stripHistory(plainScene).graphs.size).toBe(0);
    expect(stripHistory(plainScene).records).toBe(plainScene.records);
  });

  it("estimates more bytes for more drawn and more data, always finitely", () => {
    const small = estimateSavedSceneBytes(save(sceneFor([]))), large = estimateSavedSceneBytes(save());
    expect(Number.isFinite(small) && small > 0).toBe(true);
    expect(large).toBeGreaterThan(small);
    const withData = savedScene("p", chained, { ...committed(chained), data: { index: folder.index, components: new Map([[`c:${A}`, { directory: "/f", token: "t1", version: 1, nodes: folder.stacks.get(A)!.nodes, dag: folder.stacks.get(A)!.graph.dag, members: [] }]]) } });
    expect(estimateSavedSceneBytes(withData)).toBeGreaterThan(large);
  });

  it("fits the store's budget, which refuses an oversized scene", () => {
    const scenes = createSceneStore<SavedScene>(estimateSavedSceneBytes, { bytes: estimateSavedSceneBytes(save()) - 1 });
    scenes.remember("p", "/f", save());
    expect(scenes.recall("p", "/f")).toBeUndefined();
    scenes.remember("p", "/f", save(sceneFor([])));
    expect(scenes.recall("p", "/f")).toBeDefined();
  });

  it("rebinds a scene to a new lifetime without changing its content", () => {
    const next = { paneId: "p", directory: "/f", generation: 9 };
    const bound = rebind(chained, next);
    expect(bound.scope).toBe(next);
    expect(bound.inputs.scope).toBe(next);
    expect(bound.records).toBe(chained.records);
    expect(chained.scope).toBe(scope);
  });
});

describe("restoration", () => {
  it("presents a scene laid out at the same width and metrics", () => {
    expect(restoration(save(), "p", intent())).toBe("present");
    // Selection, focus and listing changes are revalidated afterwards, not reasons to lay out again.
    expect(restoration(save(), "p", intent({ selectedPaths: new Set(["/f/file-1.png"]), open: new Set() }))).toBe("present");
  });

  it("recomposes when the width or a metric differs", () => {
    expect(restoration(save(), "p", intent({ width: 900 }))).toBe("recompose");
    expect(restoration(save(), "p", intent({ tile: tileMetrics(160) }))).toBe("recompose");
    expect(restoration(save(), "p", intent({ grid: { ...fallbackGridMetrics(tile), gap: 20 } }))).toBe("recompose");
    expect(restoration(save(), "p", intent({ cover: { imagePx: 64, small: true } }))).toBe("recompose");
  });

  it("never restores another folder's or pane's scene, or before the pane is measured", () => {
    expect(restoration(undefined, "p", intent())).toBeNull();
    expect(restoration(save(), "p", intent({ directory: "/g" }))).toBeNull();
    expect(restoration(save(), "other", intent())).toBeNull();
    expect(restoration(save(chained, "other"), "p", intent())).toBeNull();
    expect(restoration(save(), "p", intent({ width: 0 }))).toBeNull();
    expect(restoration(save(), "p", intent({ width: NaN }))).toBeNull();
    // A saved scene whose parts disagree on the folder is malformed.
    expect(restoration(save(chained, "p", { directory: "/g" }), "p", intent({ directory: "/g" }))).toBeNull();
    expect(restoration({ ...save(), data: { ...save().data, index: { ...folder.index, directory: "/g" } } }, "p", intent())).toBeNull();
  });
});
