/**
 * A scene's media (docs/scene-transactions.md, "Native re-run fixes"): the thumbnails its tiles
 * draw are part of the scene. The controller makes the ones a new scene shows near the viewport a
 * dependency of preparing it, so the first frame that draws a tile draws its image.
 *
 * Pure: which thumbnail a record draws (the renderers use the same rules), and which records a
 * scene mounts at its commit, from the scene, the scene it replaces and the viewport.
 */
import type { FileEntry } from "$lib/domain/file";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import type { FolderScene, SceneRecord } from "$lib/domain/trace-graph/folder-scene";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { visibleBadges, type ReferenceBadge } from "$lib/domain/trace-graph/projection";
import { PARTICIPANT_MARGIN } from "./participants";
import { componentNodes } from "./scene-view";
import { UNMEASURED, type Span } from "./scene-window";

/** The image a tile draws for `node`, or null when it draws a spinner or a placeholder (`TileVisual`). */
export function nodeThumbnail(node: TraceNode): string | null {
  return node.state === "present" && !node.earlierRevision && !node.discarded && node.path ? node.path : null;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
/** The image an ordinary file tile draws (`OrdinaryTile`), or null for a folder or another file's icon. */
export function entryThumbnail(entry: FileEntry): string | null {
  return entry.kind !== "directory" && IMAGE.test(entry.name) ? entry.path : null;
}

/**
 * The thumbnails `record` draws: a tile's image and its drawn reference badges' (`visibleBadges`
 * with the overflow closed, as a tile mounts; `ReferenceBadge`), an ordinary file's.
 */
export function recordThumbnails(scene: FolderScene, record: SceneRecord, hostEntries: boolean): string[] {
  if (record.kind === "entry") {
    // A host file tile loads its own image; the plugin cannot prepare it.
    const path = hostEntries ? null : entryThumbnail(record.entry);
    return path ? [path] : [];
  }
  if (record.kind !== "tile") return [];
  const own = nodeThumbnail(record.tile.node);
  const nodes = record.badges.length && record.graphId !== null ? componentNodes(scene, record.graphId) : undefined;
  const badges = badgeThumbnails(visibleBadges(record.badges, scene.inputs.styling.selectedKeys), nodes);
  return own ? [own, ...badges] : badges;
}

/**
 * The images `badges` draw (`ReferenceBadge`): a badge whose node is known draws its image only
 * while the node is present; one without a path draws nothing. Opening a tile's "+n" prepares the
 * same images (`ReferenceBadges`, `media-gate.ts`).
 */
export function badgeThumbnails(badges: readonly ReferenceBadge[], nodes?: ReadonlyMap<string, TraceNode>): string[] {
  return badges.filter((badge) => {
    const node = nodes?.get(badge.key);
    return !!badge.path && (!node || node.state === "present");
  }).map((badge) => badge.path);
}

export interface MediaInput {
  readonly next: FolderScene;
  /** The scene on screen (null for a first scene): a record moving from where it is drawn now is mounted from there. */
  readonly previous: FolderScene | null;
  /** The visible area in folder coordinates; null before one is measured. */
  readonly viewport: GridRect | null;
  /** Whether ordinary files are drawn by the host's file tile (`ui/file-tile`). */
  readonly hostEntries: boolean;
  readonly margin?: number;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

/**
 * The thumbnails of the records `next` mounts at its commit: those whose target, or the place the
 * scene on screen draws them, lies within `margin` (the grid's windowing margin) of the viewport,
 * vertically. That covers a record carried into view by the commit's motion. Without a viewport,
 * the span the grid mounts before measuring one (`UNMEASURED`). Records mounted later (scrolled
 * to) load when they mount, within the same margin, before they are visible.
 */
export function sceneThumbnails({ next, previous, viewport, hostEntries, margin = PARTICIPANT_MARGIN }: MediaInput): ReadonlySet<string> {
  const view: Span = viewport && finite(viewport.y, viewport.height) && viewport.height >= 0 ? { top: viewport.y, bottom: viewport.y + viewport.height } : UNMEASURED;
  const pad = Number.isFinite(margin) && margin > 0 ? margin : 0;
  const top = view.top - pad, bottom = view.bottom + pad;
  const near = (rect: GridRect | undefined) => !!rect && finite(rect.y, rect.height) && rect.y <= bottom && rect.y + rect.height >= top;
  const paths = new Set<string>();
  for (const [id, record] of next.records) {
    if (record.kind !== "tile" && record.kind !== "entry") continue;
    if (!near(record.rect) && !near(previous?.records.get(id)?.rect)) continue;
    for (const path of recordThumbnails(next, record, hostEntries)) paths.add(path);
  }
  return paths;
}
