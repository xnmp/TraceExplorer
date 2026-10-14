/** Conservative deterministic work budget for synchronous layout dispatch. */
import type { LayoutRequest } from "./layout";

export function canLayoutInline(request: LayoutRequest): boolean {
  const history = request.history?.layout;
  return request.items.length + (history?.nodes.size ?? 0) <= 30
    && request.items.reduce((sum, n) => sum + n.parents.length, 0) + (history?.routes.length ?? 0) <= 40;
}

/** The scene on screen: how far it reaches horizontally, and the pane width it was laid out for. */
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
