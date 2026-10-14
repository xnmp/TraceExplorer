/**
 * Presentation model types (docs/scene-transactions.md §2) and the controller's publication.
 * Step 4 publishes every record at its target pose with no tracks or retirees; the legacy grid
 * motion driver still animates the DOM after commit. Step 5 replaces it with tracks sampled on
 * one clock and keyed passive retirees.
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { FolderScene, SceneRecord } from "$lib/domain/trace-graph/folder-scene";

export type TransactionId = number;
export type RenderId = string;
export type Ease = "linear" | readonly [number, number, number, number];
export interface Pose {
  readonly rect: GridRect;
  /** Motion multiplier; settled = 1. */
  readonly opacity: number;
  /** Absolute folder-coordinate clip. */
  readonly clip: GridRect | null;
}
export interface PoseFrame {
  /** Milliseconds within the common epoch. */
  readonly at: number;
  readonly pose: Pose;
  /** Interpolation to the next frame. */
  readonly easing: Ease;
}
export interface Track { readonly frames: readonly PoseFrame[] }
export interface PresentedRecord {
  readonly renderId: RenderId;
  readonly record: SceneRecord;
  readonly initial: Pose;
  readonly track: Track | null;
}
export interface RetiringRecord extends PresentedRecord {
  readonly sourceTransaction: TransactionId;
  readonly group: RenderId | null;
  readonly reason: "exit" | "old-route";
}
export interface Presentation {
  readonly epoch: number;
  readonly duration: number;
  readonly live: ReadonlyMap<RenderId, PresentedRecord>;
  readonly retiring: ReadonlyMap<RenderId, RetiringRecord>;
  readonly pinned: ReadonlySet<RenderId>;
}
/** The controller's only drawable state: one complete scene and how it is presented. */
export interface Publication {
  readonly transactionId: TransactionId;
  /** Increases only when a commit changes geometry; restyle commits keep it. */
  readonly geometryVersion: number;
  readonly scene: FolderScene;
  readonly presentation: Presentation;
}

const settled = (record: SceneRecord): PresentedRecord => ({ renderId: record.id, record, initial: { rect: record.rect, opacity: 1, clip: null }, track: null });

/** Every record at its target pose, nothing retiring: a snapped (or legacy-animated) presentation. */
export function staticPresentation(scene: FolderScene, epoch = 0): Presentation {
  const live = new Map<RenderId, PresentedRecord>();
  for (const [id, record] of scene.records) live.set(id, settled(record));
  return { epoch, duration: 0, live, retiring: new Map(), pinned: new Set() };
}
