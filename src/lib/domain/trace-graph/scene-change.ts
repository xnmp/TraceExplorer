/** Motion policy for committed graph scenes; no renderer or IO dependencies. */
import type { GraphLayout, PinnedCover } from './layout';
import { sameGraphGeometry } from './layout-geometry';
import type { TileMetrics } from './metrics';
import type { ScenePlan } from './scene';

export type SceneChange = 'reveal' | 'restyle' | 'reflow';
export interface CommittedGraph {
  readonly plan: ScenePlan;
  readonly layout: GraphLayout;
  /** Identity of the complete component DAG, never the filtered visible graph. */
  readonly data: object;
  readonly componentId: string;
  readonly revision: number;
  readonly tile: TileMetrics;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validPin = (pin: PinnedCover | undefined): boolean => pin === undefined || !!pin
  && typeof pin.key === 'string' && finite(pin.x)
  && (pin.obstacles === undefined || Array.isArray(pin.obstacles)
    && pin.obstacles.every(obstacle => !!obstacle && finite(obstacle.x) && finite(obstacle.width) && obstacle.width >= 0));
const valid = (scene: CommittedGraph | null | undefined): scene is CommittedGraph => !!scene
  && typeof scene.data === 'object' && scene.data !== null && typeof scene.componentId === 'string' && finite(scene.revision)
  && finite(scene.tile?.width) && scene.tile.width > 0 && finite(scene.tile.image) && scene.tile.image > 0
  && !!scene.plan?.lineage && (scene.plan.lineage.focus === null || typeof scene.plan.lineage.focus === 'string') && scene.plan.tiles instanceof Map
  && Array.isArray(scene.plan.request?.items) && finite(scene.plan.request.maxWidth) && scene.plan.request.maxWidth >= 0
  && validPin(scene.plan.request.pinned)
  && scene.plan.request.items.every(item => !!item && typeof item.key === 'string' && [item.width, item.height, item.order].every(finite) && item.width > 0 && item.height > 0 && Array.isArray(item.parents))
  && !!scene.layout && finite(scene.layout.width) && scene.layout.width >= 0 && finite(scene.layout.height) && scene.layout.height >= 0
  && (scene.layout.orientation === 'down' || scene.layout.orientation === 'right')
  && scene.layout.nodes instanceof Map && scene.layout.junctions instanceof Map && Array.isArray(scene.layout.routes)
  && [...scene.layout.nodes.values()].every(n => !!n && [n.x, n.y, n.width, n.height].every(finite) && n.width > 0 && n.height > 0)
  && [...scene.layout.junctions.values()].every(n => !!n && [n.x, n.y].every(finite))
  && scene.layout.routes.every(r => !!r && typeof r.id === 'string' && typeof r.path === 'string');

const samePin = (a: PinnedCover | undefined, b: PinnedCover | undefined): boolean => {
  if (!a || !b) return a === b;
  const aa = a.obstacles ?? [], bb = b.obstacles ?? [];
  return a.key === b.key && a.x === b.x && aa.length === bb.length
    && aa.every((obstacle, i) => obstacle.x === bb[i].x && obstacle.width === bb[i].width);
};

/** Invalid or first inputs conservatively reflow. Geometry equality keeps travelling motion alive. */
export function classifySceneChange(previous: CommittedGraph | null | undefined, next: CommittedGraph | null | undefined): SceneChange {
  if (!valid(previous) || !valid(next)) return 'reflow';
  if (sameGraphGeometry(previous.layout, next.layout)) return 'restyle';
  const a = previous.plan.request, b = next.plan.request;
  const sameInputs = previous.data === next.data && previous.componentId === next.componentId && previous.revision === next.revision
    && a.maxWidth === b.maxWidth && samePin(a.pinned, b.pinned)
    && previous.tile.width === next.tile.width && previous.tile.image === next.tile.image
    && a.tileWidth === b.tileWidth && a.orientation === b.orientation && a.extent === b.extent
    && a.band?.key === b.band?.key && previous.layout.orientation === next.layout.orientation;
  const visibilityChanged = previous.plan.tiles.size !== next.plan.tiles.size
    || [...previous.plan.tiles.keys()].some(key => !next.plan.tiles.has(key));
  return sameInputs && (previous.plan.lineage.focus !== next.plan.lineage.focus || visibilityChanged) ? 'reveal' : 'reflow';
}

/** Why a scene transaction committed (the controller's `SceneCause.kind`). */
export type SceneCauseKind =
  | 'startup' | 'restore' | 'selection' | 'expand' | 'collapse'
  | 'resize' | 'metrics' | 'listing' | 'refresh' | 'reveal' | 'retry';

/** Whether a geometry publication's spatial changes travel (`animate`) or are shown at once (`snap`). */
export type GeometryMotion = 'animate' | 'snap';

/**
 * The spatial changes the user asks for: opening or closing a stack, the reflow a selection causes,
 * and a reveal (Show image opens the image's stack and selects it; what the reveal itself displaces
 * already snaps, `classifySceneChange`).
 */
const USER_SPATIAL: ReadonlySet<string> = new Set<SceneCauseKind>(['expand', 'collapse', 'selection', 'reveal']);

/**
 * The motion policy for geometry (docs/scene-transactions.md, "Native findings fixes"). Motion is
 * kept for spatial changes the user initiated in the view; every other geometry change snaps,
 * whatever moved: arriving in a folder (`arrival`: the first scene of a lifetime, a startup or a
 * restore), a resize or a scrollbar, tile metrics, the listing, a backend refresh and a retry. An
 * unknown cause snaps. Restyles (no geometry change) are not governed here: they keep
 * whatever motion is running.
 */
export function geometryMotion(cause: SceneCauseKind, { arrival }: { readonly arrival: boolean }): GeometryMotion {
  return !arrival && USER_SPATIAL.has(cause) ? 'animate' : 'snap';
}
