/**
 * Motion participants (docs/scene-transactions.md §7): which records of a new scene may move at
 * its commit. Pure: the controller passes the viewport the presentation adapter reported, in
 * folder coordinates.
 *
 * A record participates when its target or its displayed pose lies within `margin` of the
 * viewport, when it is focused or selected, or when it is still moving (a track that has not
 * ended at the sampled time). Records displayed but leaving the scene participate on the same
 * terms, by their displayed pose, and a record coming back while its retiree is still shown
 * participates (it takes over the retiree's pose). Every other record takes its target pose: it is offscreen, so
 * snapping it shows nothing, and a later viewport mount draws it where the model says it is.
 *
 * Without a viewport (none measured yet, or one that is not a finite rectangle) every record
 * participates.
 */
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { EntityId, FolderScene, SceneRecord } from "$lib/domain/trace-graph/folder-scene";
import type { NodeKey } from "$lib/domain/trace-graph/model";
import { PAINTED, trackEnd, type DisplayedPresentation } from "./presentation";

/** The grid's windowing margin (StackGrid), which also covers a large graph's smaller one (TraceGraph). */
export const PARTICIPANT_MARGIN = 1200;

const finite = (...values: number[]) => values.every(Number.isFinite);
const validRect = (rect: GridRect | null | undefined): rect is GridRect =>
  !!rect && finite(rect.x, rect.y, rect.width, rect.height) && rect.width >= 0 && rect.height >= 0;
/** Closed intersection, so a zero-size record on the margin's edge (a junction) counts. */
const intersects = (a: GridRect, b: GridRect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Whether the selection or focus names a record, so it moves wherever it is. */
function chosen(record: SceneRecord, focus: NodeKey | null): boolean {
  if (record.kind === "entry") return record.selected;
  if (record.kind !== "tile") return false;
  return record.selected || (focus !== null && record.tile.key === focus);
}

export interface ParticipantInput {
  readonly next: FolderScene;
  /** What the published presentation displays now (null for a first scene). */
  readonly displayed: DisplayedPresentation | null;
  /** The visible area in folder coordinates, or null when unknown. */
  readonly viewport: GridRect | null;
  readonly margin?: number;
}

/** The records that may move at this commit, or null when every record may. */
export function motionParticipants({ next, displayed, viewport, margin = PARTICIPANT_MARGIN }: ParticipantInput): ReadonlySet<EntityId> | null {
  if (!validRect(viewport)) return null;
  const pad = Number.isFinite(margin) && margin > 0 ? margin : 0;
  const area: GridRect = { x: viewport.x - pad, y: viewport.y - pad, width: viewport.width + 2 * pad, height: viewport.height + 2 * pad };
  const near = (rect: GridRect | null | undefined) => validRect(rect) && intersects(area, rect);
  const focus = next.inputs.styling.focus;
  const shown = displayed?.poses;
  const ids = new Set<EntityId>();
  for (const [id, record] of next.records) {
    if (near(record.rect) || near(shown?.get(id)?.rect) || chosen(record, focus)) ids.add(id);
  }
  if (displayed) for (const [id, presented] of displayed.presentation.live) {
    if (ids.has(id)) continue;
    const moving = presented.track !== null && displayed.at < trackEnd(presented.track);
    if (moving || near(shown?.get(id)?.rect) || (!next.records.has(id) && chosen(presented.record, focus))) ids.add(id);
  }
  // A record coming back while its retiree is still shown takes over the retiree's displayed pose (its motion is running).
  if (displayed) for (const retiree of displayed.presentation.retiring.values()) {
    const id = retiree.record.id;
    if (retiree.reason === "exit" && retiree.record.kind !== "band" && next.records.has(id) && (shown?.get(retiree.renderId)?.opacity ?? 0) > PAINTED) ids.add(id);
  }
  return ids;
}
