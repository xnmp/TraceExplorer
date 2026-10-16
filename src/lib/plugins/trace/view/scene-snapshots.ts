/**
 * Committed scenes kept across Trace view mounts (docs/scene-transactions.md §7, "restoration"):
 * one per pane and folder, beside the folder data snapshots (`folder-session.svelte.ts`), in an
 * independent LRU of `SCENE_SNAPSHOT_LIMIT` entries and `SCENE_SNAPSHOT_BYTES` estimated bytes
 * (`createSceneStore`).
 *
 * A saved scene is immutable and holds no request history: each open band's plan drops the
 * history reference its layout request carried (the committed layout before it), so saved scenes
 * never chain earlier layouts. Everything a later layout reads from it (each band's raw layout,
 * attachment and reading order) stays.
 *
 * Restoring is decided by `restoredInput`: a returning pane starts from its *current* intent
 * (selection, focus, badge hover, open stacks, listing, width and metrics) laid out on the saved
 * coherent data. The saved layout is reused only when that input's layout basis is the saved one;
 * otherwise it is laid out again (see the controller's `restore`). A scene of another folder or
 * pane is never restored, whatever its component ids.
 */
import type { FolderScene, FolderSceneGraph, GraphId } from "$lib/domain/trace-graph/folder-scene";
import type { FolderGraph, FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import type { ComponentData, FolderIndex } from "$lib/domain/trace-graph/folder-data";
import { estimateFolderLayoutBytes } from "$lib/domain/trace-graph/folder-layout/bounded-cache";
import { folderItems, fresh, prepareLayoutInput, requiredComponents, type HeldHistory, type PreparedLayoutInput, type SceneData,
  type SceneIntent } from "./scene-inputs";
import { createSceneStore, type SceneStore } from "./folder-snapshots";

/** A committed scene with what the controller committed it from. */
export interface SavedScene {
  readonly paneId: string;
  readonly scene: FolderScene;
  readonly intent: SceneIntent;
  readonly data: SceneData;
  readonly history: HeldHistory;
  /** The layout basis the scene was laid out from (`layoutBasis`). */
  readonly basis: string;
}

/** The same plan without its request's history reference. */
function withoutHistory<G extends FolderGraph>(graph: G, plans: Map<object, FolderGraph["plan"]>): G {
  const hasCanonicalHistory = graph.canonical && "history" in graph.canonical.request;
  if (!("history" in graph.plan.request) && !hasCanonicalHistory) return graph;
  let plan = plans.get(graph.plan);
  if (!plan) {
    const { history: _history, ...request } = graph.plan.request;
    plan = { ...graph.plan, request };
    plans.set(graph.plan, plan);
  }
  let canonical = graph.canonical;
  if (canonical && hasCanonicalHistory) {
    const { history: _history, ...request } = canonical.request;
    canonical = { ...canonical, request };
  }
  return { ...graph, plan, ...(canonical ? { canonical } : {}) };
}

/** `scene` without request-history references; the scene itself is never changed. */
export function stripHistory(scene: FolderScene): FolderScene {
  const plans = new Map<object, FolderGraph["plan"]>();
  const graphs = new Map<GraphId, FolderSceneGraph>([...scene.graphs].map(([id, graph]) => [id, withoutHistory(graph, plans)]));
  const layoutGraphs = new Map([...scene.layout.graphs].map(([id, graph]) => [id, withoutHistory(graph, plans)]));
  const layout: FolderLayout = { ...scene.layout, graphs: layoutGraphs };
  return { ...scene, graphs, layout, inputs: { ...scene.inputs, layoutInput: { ...scene.inputs.layoutInput, previous: null } } };
}

export interface CommittedSnapshot {
  readonly intent: SceneIntent;
  readonly data: SceneData;
  readonly history: HeldHistory;
  readonly basis: string;
}

/** The copy of a committed scene to keep. */
export const savedScene = (paneId: string, scene: FolderScene, committed: CommittedSnapshot): SavedScene =>
  ({ paneId, scene: stripHistory(scene), intent: committed.intent, data: committed.data, history: committed.history, basis: committed.basis });

const OBJECT = 64, RECORD = 4 * OBJECT;
const text = (value: string | undefined | null) => 2 * (value?.length ?? 0);

/**
 * Rough heap bytes a saved scene keeps alive: its layout, records, listing, and the complete
 * component data it was built from (shared with the folder snapshot while that keeps it, counted
 * here so an evicted folder snapshot cannot leave it unbounded).
 */
export function estimateSavedSceneBytes(saved: SavedScene): number {
  const { scene } = saved;
  let total = estimateFolderLayoutBytes(scene.layout) + RECORD * (scene.records.size + scene.edges.size + scene.navigation.size);
  for (const route of scene.routes.values()) total += text(route.route.path);
  for (const entry of saved.intent.listing) total += OBJECT + text(entry.path) + text(entry.name);
  total += OBJECT * (saved.data.index.members.size + saved.data.index.components.length);
  for (const component of saved.data.components.values()) for (const node of component.nodes) total += RECORD + text(node.key) + text(node.path) + text(node.prompt);
  return total;
}

/** What the session knows of the folder now: its index (null until read) and loaded components. */
export interface CurrentData {
  readonly index: FolderIndex | null;
  readonly components: ReadonlyMap<string, ComponentData>;
  isStale(id: string): boolean;
}

/** A returning pane's first scene: its current intent on the saved data, and whether the saved layout fits it. */
export interface RestoredInput {
  readonly saved: SavedScene;
  /** The intent the scene is built from: the pane's current one. */
  readonly intent: SceneIntent;
  readonly data: SceneData;
  readonly prepared: PreparedLayoutInput;
  /** The saved layout is this input's layout (same layout basis): nothing is laid out again. */
  readonly reuse: boolean;
}

/**
 * The scene a pane showing `intent` starts from when it returns to a folder, from what it saved
 * there: the current intent laid out on the saved coherent data (any component the session has
 * fresher under the same index stands in for the saved one), so the first frame shows the pane's
 * selection, focus, hover, open stacks and size as they are now.
 *
 * A requested stack whose data is in neither the saved scene nor the session is laid out closed,
 * as a cold open is until its data is read (it was drawn so when the scene was saved).
 *
 * The saved data is used even when the session already knows a newer index, or the listing
 * changed: the return shows the last coherent scene at once, and the newer data commits after it
 * (a refresh, which snaps). Components are merged only under the saved index.
 *
 * Null (nothing is restored; the folder is prepared as a first scene) when the scene is another
 * pane's or folder's, or malformed; or before the pane has a width.
 */
export function restoredInput(saved: SavedScene | undefined, paneId: string, intent: SceneIntent, current: CurrentData): RestoredInput | null {
  if (!saved || saved.paneId !== paneId || !(intent.width > 0)) return null;
  const directory = intent.directory, base = saved.data.index;
  if (saved.scene.scope.directory !== directory || saved.intent.directory !== directory || base.directory !== directory) return null;
  if (saved.history.directory !== directory || saved.scene.scope.paneId !== paneId) return null;
  const { cells } = folderItems(intent.listing, base, intent.claimed, new Set());
  const requested = requiredComponents(cells, intent.open, new Set());
  const components = new Map(saved.data.components);
  for (const id of requested.values()) {
    const loaded = current.components.get(id);
    if (fresh(loaded, base, (other) => current.isStale(other), id)) components.set(id, loaded);
  }
  // A requested stack whose data is not here yet stays closed, as a cold open does, until it is read.
  const open = new Map([...requested].filter(([, id]) => components.has(id)));
  const data: SceneData = { index: base, components };
  const prepared = prepareLayoutInput(intent, data, open, saved.history, saved.scene.layout, current.components);
  return { saved, intent, data, prepared, reuse: prepared.basis === saved.basis };
}

/** Shared by every pane; cleared with the folder snapshots (`forgetFolderSnapshots`). */
export const sceneSnapshots: SceneStore<SavedScene> = createSceneStore<SavedScene>(estimateSavedSceneBytes);
