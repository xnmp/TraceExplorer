/** Conservative deterministic work budget for synchronous layout dispatch. */
import type { LayoutRequest } from "./layout";

export function layoutWorkload(request: LayoutRequest): { tiles: number; edges: number; pathBytes: number } {
  const history = request.history?.layout;
  return { tiles: request.items.length + (history?.nodes.size ?? 0),
    edges: request.items.reduce((sum, n) => sum + n.parents.length, 0) + (history?.routes.length ?? 0),
    pathBytes: history?.routes.reduce((sum,r)=>sum+2*r.path.length,0) ?? 0 };
}

/** Certification is part of the budget, including retained path parsing. */
export function canLayoutInline(request: LayoutRequest): boolean {
  return withinInlineBudget(layoutWorkload(request));
}

export const withinInlineBudget = (work: ReturnType<typeof layoutWorkload>): boolean =>
  work.tiles <= 20 && work.edges <= 20 && work.pathBytes <= 16_384;

/**
 * The scene on screen: how far it reaches horizontally, and the width it was laid out for. Both are
 * measured the same way, inside the grid's padding (the layout input's width), as is the next width.
 */
export interface DisplayedExtent {
  readonly extent: number;
  readonly width: number;
}

/**
 * Whether a folder layout must run before the next paint whatever its workload
 * (docs/scene-transactions.md, "Native findings fixes"). `width` is the width the next layout is
 * for. A scene on screen that the pane narrowed past (it reaches beyond the new width, which is
 * narrower than the one it was laid out for) would be drawn overflowing the pane while a heavy
 * layout runs off the main thread, so its replacement is computed at once instead. Otherwise the
 * scene on screen stays, unchanged and whole, until the worker's layout commits: one that still
 * fits, and one already wider than its own pane (it scrolls sideways now as it did before).
 * Nothing on screen (null), or a measure that is not a finite number, never forces it.
 */
export function mustLayoutBeforePaint(displayed: DisplayedExtent | null, width: number): boolean {
  return displayed !== null && [displayed.extent, displayed.width, width].every(Number.isFinite)
    && width < displayed.width && displayed.extent > width;
}
