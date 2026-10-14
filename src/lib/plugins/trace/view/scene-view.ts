/**
 * Read-only views of a published folder scene for the renderers: records grouped by graph, and a
 * geometry stamp per graph. Pure; derived from one scene, never from DOM or live session data.
 */
import type { FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import type { FolderScene, JunctionRecord, RouteRecord, TileRecord } from "$lib/domain/trace-graph/folder-scene";
import type { GraphId } from "$lib/domain/trace-graph/folder-layout";
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
import type { TraceDag } from "$lib/domain/trace-graph/projection";

export interface GraphRecords {
  /** Band tiles (the cover excluded: it is its cell), in plan order. */
  readonly tiles: readonly TileRecord[];
  readonly routes: readonly RouteRecord[];
  readonly junctions: readonly JunctionRecord[];
}

const grouped = new WeakMap<FolderScene, ReadonlyMap<GraphId, GraphRecords>>();
/** Each open graph's records, computed once per scene. */
export function recordsByGraph(scene: FolderScene): ReadonlyMap<GraphId, GraphRecords> {
  const known = grouped.get(scene);
  if (known) return known;
  const groups = new Map<GraphId, { tiles: TileRecord[]; routes: RouteRecord[]; junctions: JunctionRecord[] }>();
  for (const id of scene.graphs.keys()) groups.set(id, { tiles: [], routes: [], junctions: [] });
  for (const record of scene.records.values()) {
    const group = record.graphId !== null ? groups.get(record.graphId) : undefined;
    if (!group) continue;
    if (record.kind === "tile" && !record.cover) group.tiles.push(record);
    else if (record.kind === "route") group.routes.push(record);
    else if (record.kind === "junction") group.junctions.push(record);
  }
  grouped.set(scene, groups);
  return groups;
}

const stamps = new WeakMap<object, string>();
type SceneGraph = FolderLayout["graphs"] extends ReadonlyMap<GraphId, infer G> ? G : never;
type Geometry = SceneGraph["layout"];
function geometryStamp(geometry: Geometry): string {
  const known = stamps.get(geometry);
  if (known !== undefined) return known;
  let hash = 0x811c9dc5;
  const mix = (text: string) => { for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } };
  mix(`${geometry.width},${geometry.height};`);
  for (const node of geometry.nodes.values()) mix(`n${node.key},${node.x},${node.y},${node.width},${node.height};`);
  for (const route of geometry.routes) mix(`r${route.id},${route.path};`);
  for (const junction of geometry.junctions.values()) mix(`j${junction.id},${junction.x},${junction.y};`);
  const stamp = hash.toString(36);
  stamps.set(geometry, stamp);
  return stamp;
}

/**
 * Stamps for the legacy grid motion (`playGrid`): `layout` changes only when the band's own raw
 * layout changes (a restyle or a kept layout leaves it alone), `attachment` when its packed,
 * attached geometry changes. A band whose stamps are both unchanged carries its running motion.
 */
export const graphStamps = (graph: SceneGraph): { readonly layout: string; readonly attachment: string } =>
  ({ layout: geometryStamp(graph.layout), attachment: geometryStamp(graph.attached) });

/** The cover a graph key or tile key belongs to among the scene's open graphs. */
export function graphOwning(scene: FolderScene, key: string): GraphId | undefined {
  for (const [id, stack] of scene.inputs.layoutInput.open) if (stack.graph.dag.nodes.has(key)) return id;
  return undefined;
}

/**
 * A stack's complete component nodes (references included, which the drawable projection
 * drops): what badges and tooltips name. The scene's source carries the component DAG it was
 * built from (`prepareLayoutInput`).
 */
export function componentNodes(scene: FolderScene, id: GraphId): ReadonlyMap<NodeKey, TraceNode> | undefined {
  const data = scene.inputs.sources.get(id)?.data as Partial<TraceDag> | undefined;
  return data?.nodes instanceof Map ? data.nodes : scene.inputs.layoutInput.open.get(id)?.graph.dag.nodes;
}

const badgeKeys = new WeakMap<FolderScene, ReadonlySet<NodeKey>>();
/** Whether a scene draws `key`: a navigable tile, or a reference badge on one of its tiles. */
export function presents(scene: FolderScene, key: NodeKey): boolean {
  if (scene.navigation.has(key)) return true;
  let badges = badgeKeys.get(scene);
  if (!badges) {
    badges = new Set([...scene.records.values()].flatMap((record) => record.kind === "tile" ? record.badges.map((badge) => badge.key) : []));
    badgeKeys.set(scene, badges);
  }
  return badges.has(key);
}
