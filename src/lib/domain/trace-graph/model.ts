/**
 * Trace view domain model. Every node is one image (artifact) or a stable
 * placeholder for an output that is still being generated. Keys are derived
 * from provenance identity, never from filenames, so saving, moving or
 * renaming an image keeps its key and focus.
 */
export type NodeKey = string;

/** Where an image lives relative to the displayed folder (native classification). */
export type NodeScope = "current" | "subfolder" | "external";

export type NodeState = "present" | "missing" | "unavailable" | "running" | "uncertain";

export interface TraceNode {
  readonly key: NodeKey;
  /** null only for a placeholder whose output has not been recorded yet. */
  readonly artifactId: number | null;
  readonly runId: number | null;
  /** Direct parents (input images of the generating run), deduplicated. */
  readonly parents: readonly NodeKey[];
  readonly path: string | null;
  readonly scope: NodeScope;
  /** Display location: `./name.png`, `refs/name.png` or an outside path. */
  readonly location: string;
  readonly state: NodeState;
  readonly temporary: boolean;
  readonly discarded: boolean;
  readonly earlierRevision: boolean;
  /** Stable creation order used to break ties deterministically. */
  readonly order: number;
  readonly prompt: string;
}

export interface ComponentSummary {
  readonly id: string;
  readonly title: string;
  readonly cover: { readonly path: string; readonly present: boolean } | null;
  readonly imageCount: number;
  readonly nodeCount: number;
  readonly active: boolean;
  readonly unsaved: boolean;
}

export const nodeKeyForArtifact = (artifactId: number, runId: number | null, outputIndex: number): NodeKey =>
  runId === null ? `a:${artifactId}` : `o:${runId}:${outputIndex}`;
