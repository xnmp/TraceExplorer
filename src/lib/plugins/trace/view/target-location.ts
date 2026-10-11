/**
 * Where a pane's Preview target node is in the current folder index. A target
 * names a node key and the component it was issued from; refreshes can move
 * the node (its component merged with another), or remove it (a generation
 * failed, an unsaved output was deleted), possibly with its whole component.
 */
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";

export type TargetLocation = { readonly node: TraceNode; readonly componentId: string } | "gone" | "unknown";

export interface TargetIndex {
  /** Component IDs the current index lists; null while no index is loaded. */
  readonly listed: ReadonlySet<string> | null;
  /** Loaded component data by ID. */
  readonly components: ReadonlyMap<string, { readonly dag: { readonly nodes: ReadonlyMap<NodeKey, TraceNode> } }>;
  /** Whether a loaded component's data predates the current index. */
  readonly isStale: (componentId: string) => boolean;
}

/**
 * Found: in current data, in its own component or in the one it merged into.
 * Prefer the issued component when a badge has several copies. A saved ID
 * cannot prove disappearance after a merge or split: return Gone only after
 * all currently listed components are loaded fresh and none holds the key.
 */
export function locateTarget(key: NodeKey, componentId: string, index: TargetIndex): TargetLocation {
  if (!index.listed) return "unknown";
  const own = index.components.get(componentId)?.dag.nodes.get(key);
  if (own && index.listed.has(componentId) && !index.isStale(componentId)) return { node: own, componentId };
  for (const [id, data] of index.components) {
    const node = data.dag.nodes.get(key);
    if (node && index.listed.has(id) && !index.isStale(id)) return { node, componentId: id };
  }
  return [...index.listed].some((id) => !index.components.has(id) || index.isStale(id)) ? "unknown" : "gone";
}
