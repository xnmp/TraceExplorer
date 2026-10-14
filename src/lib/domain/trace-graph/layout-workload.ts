/** Conservative deterministic work budget for synchronous layout dispatch. */
import type { LayoutRequest } from "./layout";

export function canLayoutInline(request: LayoutRequest): boolean {
  const history = request.history?.layout;
  return request.items.length + (history?.nodes.size ?? 0) <= 30
    && request.items.reduce((sum, n) => sum + n.parents.length, 0) + (history?.routes.length ?? 0) <= 40;
}
