/**
 * The data a Trace pane holds for one folder, independent of how it was fetched.
 * Provenance (directory, index token, version) lets a consumer prove that a
 * component and the index it is shown with describe the same backend snapshot.
 */
import type { ComponentSummary, NodeKey, TraceNode } from "./model";
import type { TraceDag } from "./projection";

/** One completely loaded component; a partial page never becomes one. */
export interface ComponentData {
  readonly directory: string;
  /** The index token this data was read under. */
  readonly token: string;
  /** Increases on each accepted complete replacement (unique across sessions). */
  readonly version: number;
  readonly nodes: readonly TraceNode[];
  readonly dag: TraceDag;
  readonly members: readonly NodeKey[];
}

export interface Member { readonly componentId: string; readonly key: NodeKey }

export interface FolderIndex {
  readonly directory: string;
  readonly token: string;
  readonly components: readonly ComponentSummary[];
  readonly members: ReadonlyMap<string, Member>;
}

/** Whether `data` was read from the snapshot `index` describes. */
export const matchesIndex = (data: Pick<ComponentData, "directory" | "token">, index: Pick<FolderIndex, "directory" | "token">): boolean =>
  data.directory === index.directory && data.token === index.token;
