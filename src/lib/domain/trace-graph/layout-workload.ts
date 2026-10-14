/** Conservative deterministic work budget for synchronous layout dispatch. */
import type { LayoutRequest } from "./layout";

export function canLayoutInline(request: LayoutRequest): boolean {
  const history = request.history?.layout;
  return request.items.length + (history?.nodes.size ?? 0) <= 30
    && request.items.reduce((sum, n) => sum + n.parents.length, 0) + (history?.routes.length ?? 0) <= 40;
}

/**
 * Whether a folder layout must run before the next paint whatever its workload
 * (docs/scene-transactions.md, "Native findings fixes"). `displayedExtent` is how far the scene on
 * screen reaches horizontally, in folder coordinates; `width` is the width the next layout is for.
 * A scene that still fits stays on screen, unchanged and whole, while a heavy layout runs off the
 * main thread; one that no longer fits (the pane narrowed) would be cut at the pane's edge
 * meanwhile, so its replacement is computed at once instead. Nothing on screen (null), or a
 * measure that is not a finite number, never forces it.
 */
export function mustLayoutBeforePaint(displayedExtent: number | null, width: number): boolean {
  return displayedExtent !== null && Number.isFinite(displayedExtent) && Number.isFinite(width) && displayedExtent > width;
}
