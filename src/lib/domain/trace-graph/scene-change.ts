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

/** Why a scene transaction committed (the controller's `SceneCause.kind`): instrumentation and anchoring only, never motion. */
export type SceneCauseKind =
  | 'startup' | 'restore' | 'selection' | 'expand' | 'collapse'
  | 'resize' | 'metrics' | 'listing' | 'refresh' | 'reveal' | 'retry';

/** Whether a geometry publication's spatial changes travel (`animate`) or are shown at once (`snap`). */
export type GeometryMotion = 'animate' | 'snap';

/** Where an open stack's layout came from: the component, its revision and its data object. */
export interface OpenStackSource {
  readonly componentId: string;
  readonly revision: number;
  readonly data: object;
}

/**
 * What a scene's geometry was laid out from, as the motion policy compares it (`geometryMotion`).
 * Each field is either something the pane or the backend changes (width, metrics, the items, the
 * data) or something the user changes in the view (the requested open stacks, the focus).
 */
export interface GeometryInputs {
  /**
   * Whether the scene was laid out for what it shows. False for a saved scene shown on a return as
   * it was laid out before, until the pane's own layout commits: that commit completes the arrival.
   */
  readonly current: boolean;
  /** Width available to the grid (inside its padding), and the padding itself. */
  readonly width: number;
  readonly padding: number;
  readonly tile: { readonly width: number; readonly image: number };
  readonly grid: { readonly cellWidth: number; readonly cellHeight: number; readonly gap: number };
  /** The grid items in order, by kind and id: the listing as laid out (held history included). */
  readonly items: readonly string[];
  /** The index token the scene's data was read under. */
  readonly token: string;
  /** The stacks laid out open, with their data. */
  readonly open: ReadonlyMap<string, OpenStackSource>;
  /** The stacks the user asks to be open (laid out open, or not yet: loading or failed). */
  readonly requested: ReadonlySet<string>;
  /**
   * Requested stacks the pane's arrival has not opened yet (`arrivingStacks`): a return whose saved
   * data lacked them. Their opening completes the arrival; it is not something the user just did.
   */
  readonly arriving: ReadonlySet<string>;
  /** The focus the scene was laid out for. */
  readonly focus: string | null;
}

/** Every measure is a finite number: anything else is not comparable, so it counts as a change. */
const measurable = (inputs: GeometryInputs): boolean => [inputs.width, inputs.padding, inputs.tile.width, inputs.tile.image,
  inputs.grid.cellWidth, inputs.grid.cellHeight, inputs.grid.gap].every(Number.isFinite);
const sameSource = (a: OpenStackSource, b: OpenStackSource) => a.componentId === b.componentId && a.revision === b.revision && a.data === b.data;
const sameItems = (a: readonly string[], b: readonly string[]) => a === b || (a.length === b.length && a.every((item, index) => item === b[index]));

/**
 * The requested stacks an arrival has not opened yet: on arriving (no `previous`), every requested
 * stack laid out closed that has not failed; afterwards, those of them still requested, closed and
 * not failed. A stack the user requests later, or that failed and is retried, is never arriving.
 */
export function arrivingStacks(previous: GeometryInputs | null, requested: ReadonlySet<string>, open: ReadonlyMap<string, unknown>, failed: ReadonlySet<string>): ReadonlySet<string> {
  const pending = (id: string) => requested.has(id) && !open.has(id) && !failed.has(id);
  return new Set([...(previous ? previous.arriving : requested)].filter(pending));
}

/**
 * Whether a stack opening is the user's doing: it is requested, and not as part of the arrival (a
 * return opening a stack its saved data lacked). An expand, a cold open completing (also after
 * other commits in between), Retry and Show image are.
 */
const openedByUser = (previous: GeometryInputs, next: GeometryInputs, id: string): boolean => next.requested.has(id) && !previous.arriving.has(id);

/**
 * Whether anything other than the user changed the geometry inputs: the width, padding, tile or grid
 * metrics, the items, the index token, the data of a stack open in both, a stack opening that the
 * user did not just ask for (`openedByUser`), or one closing while still requested (it failed in its
 * cover). A measure that is not a finite number counts as a change.
 */
function outsideChange(previous: GeometryInputs, next: GeometryInputs): boolean {
  if (!previous.current || !measurable(previous) || !measurable(next)) return true;
  if (previous.width !== next.width || previous.padding !== next.padding || previous.tile.width !== next.tile.width || previous.tile.image !== next.tile.image
    || previous.grid.cellWidth !== next.grid.cellWidth || previous.grid.cellHeight !== next.grid.cellHeight || previous.grid.gap !== next.grid.gap) return true;
  if (previous.token !== next.token || !sameItems(previous.items, next.items)) return true;
  for (const [id, source] of next.open) {
    const was = previous.open.get(id);
    if (was ? !sameSource(was, source) : !openedByUser(previous, next, id)) return true;
  }
  for (const id of previous.open.keys()) if (!next.open.has(id) && next.requested.has(id)) return true;
  return false;
}

/** Whether the user changed what the layout depends on: a stack opened or closed (Retry and Show image included), or the focus. */
const userChange = (previous: GeometryInputs, next: GeometryInputs): boolean => previous.focus !== next.focus
  || previous.open.size !== next.open.size || [...next.open.keys()].some((id) => !previous.open.has(id));

/**
 * The motion policy for geometry (docs/scene-transactions.md, "Review fixes (dc33274)"), decided
 * from what changed between the scene on screen (`previous`) and the one committing, never from
 * which transaction commits it. Motion is only for spatial changes the user makes in the view:
 *
 * - **snap** on arriving (nothing on screen) or completing an arrival (`previous.current` false);
 * - **snap** when any input the user does not drive changed (`outsideChange`): the old positions
 *   are no longer comparable, so a user change committing with it snaps too;
 * - **animate** when only user inputs changed: opening or closing a stack (an expand, a collapse,
 *   a cold open completing, Retry, Show image) or the focus (a selection);
 * - **snap** otherwise (geometry changed although no input did).
 *
 * Restyles (no geometry change) are not governed here: they keep whatever motion is running.
 */
export function geometryMotion(previous: GeometryInputs | null, next: GeometryInputs): GeometryMotion {
  if (!previous || outsideChange(previous, next)) return 'snap';
  return userChange(previous, next) ? 'animate' : 'snap';
}
