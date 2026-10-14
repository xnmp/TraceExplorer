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
 * Restoring is decided by `restoration`: a scene laid out at the pane's width and metrics is
 * presented as it was ("present"); otherwise its coherent data is laid out again ("recompose").
 * A scene of another folder or pane is never restored, whatever its component ids.
 */
import type { FolderScene, FolderSceneGraph, GraphId } from "$lib/domain/trace-graph/folder-scene";
import type { FolderGraph, FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { estimateFolderLayoutBytes } from "$lib/domain/trace-graph/folder-layout/bounded-cache";
import { sameGeometry, type HeldHistory, type SceneData, type SceneIntent } from "./scene-inputs";
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
  if (!("history" in graph.plan.request)) return graph;
  let plan = plans.get(graph.plan);
  if (!plan) {
    const { history: _history, ...request } = graph.plan.request;
    plan = { ...graph.plan, request };
    plans.set(graph.plan, plan);
  }
  return { ...graph, plan };
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

/** `scene` bound to another pane lifetime (scope is compared separately from content). */
export const rebind = (scene: FolderScene, scope: FolderScene["scope"]): FolderScene =>
  ({ ...scene, scope, inputs: { ...scene.inputs, scope } });

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

export type Restoration = "present" | "recompose";

/**
 * How a pane showing `intent` may start from `saved`: "present" when the scene was laid out for
 * this folder at this width and metrics, "recompose" when only the width or metrics differ (its
 * data is laid out again), null when it is another folder's or pane's, or malformed.
 */
export function restoration(saved: SavedScene | undefined, paneId: string, intent: SceneIntent): Restoration | null {
  if (!saved || saved.paneId !== paneId || !(intent.width > 0)) return null;
  const directory = intent.directory;
  if (saved.scene.scope.directory !== directory || saved.intent.directory !== directory || saved.data.index.directory !== directory) return null;
  if (saved.history.directory !== directory || saved.scene.scope.paneId !== paneId) return null;
  return sameGeometry(saved.intent, intent) ? "present" : "recompose";
}

/** Shared by every pane; cleared with the folder snapshots (`forgetFolderSnapshots`). */
export const sceneSnapshots: SceneStore<SavedScene> = createSceneStore<SavedScene>(estimateSavedSceneBytes);
