import type { NodeKey } from "$lib/domain/trace-graph/model";
import type { ComponentData } from "./folder-session.svelte";

/** Identity captured when layout starts, never read from newer component props. */
export interface GraphScene {
  readonly data: ComponentData;
  readonly focus: NodeKey | null;
  readonly reveal: object | null;
  /** False when another plan/request has replaced this scene, even during motion. */
  readonly isCurrent: () => boolean;
}
