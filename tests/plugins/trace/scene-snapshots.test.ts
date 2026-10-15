import { NO_EXPANSION } from "$lib/domain/trace-graph/expansion";
import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, type FolderScene, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { fallbackGridMetrics } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { SceneIntent } from "$lib/plugins/trace/view/scene-inputs";
import { createSceneStore } from "$lib/plugins/trace/view/folder-snapshots";
import { estimateSavedSceneBytes, restoredInput, savedScene, stripHistory, type CurrentData, type SavedScene } from "$lib/plugins/trace/view/scene-snapshots";
import { prepareLayoutInput, stylingOf, type SceneData } from "$lib/plugins/trace/view/scene-inputs";
import type { ComponentData } from "$lib/domain/trace-graph/folder-data";
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
  badgeHover: null, expansion: NO_EXPANSION, width: 660, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: "[]", ...change,
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

});

describe("restoration", () => {
  // A pane that showed A and B open: complete data, laid out and saved as the controller commits it.
  const components = new Map<string, ComponentData>([...folder.stacks.values()].map((stack, i) =>
    [stack.componentId, { directory: "/f", token: "t1", version: i + 1, nodes: stack.nodes, dag: stack.graph.dag, members: stack.graph.dag.order }]));
  const data: SceneData = { index: folder.index, components };
  const openOf = (keys: string[]) => new Map(keys.map((key) => [key, folder.stacks.get(key)!.componentId]));
  const shownIntent = intent();
  const prepared = prepareLayoutInput(shownIntent, data, openOf([A, B]), null, null);
  const layout = engines.default(prepared.input);
  const shown = buildFolderScene({ scope, layoutInput: prepared.input, layout, sources: prepared.sources, styling: stylingOf(shownIntent), coverNodes: prepared.coverNodes });
  const saved = savedScene("p", shown, { intent: shownIntent, data, history: prepared.history, basis: prepared.basis });
  /** The session after a remount: the folder snapshot's index and components (or none read yet). */
  const session = (change: Partial<CurrentData> = {}): CurrentData => ({ index: folder.index, components, isStale: () => false, ...change });
  const [, second] = folder.stacks.get(A)!.graph.dag.order;

  it("reuses the saved layout for the pane's current selection, focus and hover outside the open stacks' layout", () => {
    const now = intent({ selectedPaths: new Set(["/f/file-1.png"]), badgeHover: "x", focus: null });
    const restored = restoredInput(saved, "p", now, session())!;
    expect(restored.reuse).toBe(true);
    expect(restored.intent).toBe(now);
    expect(restored.prepared.basis).toBe(saved.basis);
    // Without the index read yet, the saved coherent snapshot is all there is.
    expect(restoredInput(saved, "p", now, session({ index: null }))!.reuse).toBe(true);
  });

  it("lays out again when the current expansion, open stacks, width or metrics change the layout, never for the focus", () => {
    expect(restoredInput(saved, "p", intent({ focus: { key: second, componentId: folder.stacks.get(A)!.componentId } }), session())!.reuse).toBe(true);
    expect(restoredInput(saved, "p", intent({ expansion: { choices: new Map([[second, true]]), reveals: [] } }), session())!.reuse).toBe(false);
    expect(restoredInput(saved, "p", intent({ open: new Set([A]) }), session())!.reuse).toBe(false);
    expect(restoredInput(saved, "p", intent({ width: 900 }), session())!.reuse).toBe(false);
    expect(restoredInput(saved, "p", intent({ tile: tileMetrics(160) }), session())!.reuse).toBe(false);
    expect(restoredInput(saved, "p", intent({ grid: { ...fallbackGridMetrics(tile), gap: 20 } }), session())!.reuse).toBe(false);
  });

  it("uses a component the session holds fresher under the same index, and lays it out again", () => {
    const id = folder.stacks.get(A)!.componentId, newer = { ...components.get(id)!, version: 99 };
    const restored = restoredInput(saved, "p", intent(), session({ components: new Map(components).set(id, newer) }))!;
    expect(restored.data.components.get(id)).toBe(newer);
    expect(restored.reuse).toBe(false);
  });

  it("is used with its own data when the session knows a newer index or the listing changed: a return is never blank", () => {
    // A newer index: the saved coherent data is laid out (the newer index commits after it).
    const newer = restoredInput(saved, "p", intent(), session({ index: { ...folder.index, token: "t2" } }))!;
    expect(newer.data.index.token).toBe(folder.index.token);
    expect(newer.reuse).toBe(true);
    // A listing changed while the index is not known yet: the current listing on the saved index.
    const shortened = restoredInput(saved, "p", intent({ listing: folder.entries.slice(1) }), session({ index: null }))!;
    expect(shortened.prepared.cells.some((cell) => cell.id === folder.entries[0].path)).toBe(false);
    // With the same index known, the current listing is laid out instead.
    const shorter = folder.entries.filter((entry) => entry.path !== "/f/file-1.png");
    expect(restoredInput(saved, "p", intent({ listing: shorter }), session())!.prepared.cells.some((cell) => cell.id === "/f/file-1.png")).toBe(false);
  });

  it("lays out a requested stack whose data is not here closed, as a cold open is until it is read", () => {
    const partial = savedScene("p", shown, { intent: shownIntent, data: { index: folder.index, components: new Map([...components].slice(0, 1)) }, history: prepared.history, basis: prepared.basis });
    const pending = restoredInput(partial, "p", intent(), session({ components: new Map() }))!;
    expect([...pending.prepared.input.open.keys()]).toEqual([A]);
    expect(pending.reuse).toBe(false);
    // The session has read it meanwhile: it is drawn open.
    expect([...restoredInput(partial, "p", intent(), session())!.prepared.input.open.keys()].sort()).toEqual([A, B].sort());
  });

  it("never restores another folder's or pane's scene, or before the pane is measured", () => {
    expect(restoredInput(undefined, "p", intent(), session())).toBeNull();
    expect(restoredInput(saved, "p", intent({ directory: "/g" }), session())).toBeNull();
    expect(restoredInput(saved, "other", intent(), session())).toBeNull();
    expect(restoredInput(savedScene("other", shown, { intent: shownIntent, data, history: prepared.history, basis: prepared.basis }), "p", intent(), session())).toBeNull();
    expect(restoredInput(saved, "p", intent({ width: 0 }), session())).toBeNull();
    expect(restoredInput(saved, "p", intent({ width: NaN }), session())).toBeNull();
    // A saved scene whose parts disagree on the folder is malformed.
    expect(restoredInput(save(chained, "p", { directory: "/g" }), "p", intent({ directory: "/g" }), session({ index: null }))).toBeNull();
    expect(restoredInput({ ...saved, data: { ...saved.data, index: { ...folder.index, directory: "/g" } } }, "p", intent(), session({ index: null }))).toBeNull();
  });
});
