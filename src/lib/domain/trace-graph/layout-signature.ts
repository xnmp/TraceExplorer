/** Exact layout request identity: equal signatures mean equal layouts (`layoutGraph` is deterministic). */
import type { GraphLayout, LayoutRequest } from "./layout";

const routeSignature = (layout: GraphLayout) => {
  const tables: unknown[] = [], ids = new Map<object, number>();
  const routes = layout.routes.map(route => {
    const c = route.consumers;
    if (Array.isArray(c)) return route;
    const range = c as import('./route-consumers').ConsumerSet & { entries: readonly unknown[]; start: number; end: number };
    let id = ids.get(range.entries);
    if (id === undefined) { id = tables.length; ids.set(range.entries, id); tables.push(range.entries); }
    return { ...route, consumers: [id, range.start, range.end] };
  });
  return [routes, tables];
};
export const geometrySignature = (layout: GraphLayout) => [layout.orientation, layout.width, layout.height, layout.bandBounds, layout.preferredX, layout.anchorX, layout.anchorY, layout.decision,
  [...layout.nodes], [...layout.junctions], routeSignature(layout), layout.rows, [...layout.readingOrder]];

export function layoutSignature(request: LayoutRequest): string {
  // Width is normalised exactly as the engine does, so equal keys mean equal
  // layouts. Running right the engine ignores the width (generations never
  // wrap), so resizing must not recompute an identical layout.
  const width = request.band ? request.maxWidth : request.orientation !== "right" && Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : null;
  return JSON.stringify([width, request.items.map((item) => [item.key, item.width, item.height, item.order, item.parents]), request.hint ? [...request.hint] : null, request.orientation ?? "down", request.orientation === "right" ? request.extent ?? null : null, request.tileWidth ?? null, request.pinned ? [request.pinned.key, request.pinned.x, request.pinned.obstacles ?? []] : null, request.band ? [request.band.key, request.band.items] : null, request.anchorKey ?? null,
    request.history ? [request.history.signature, geometrySignature(request.history.layout), geometrySignature(request.history.placed), request.history.attachment] : null]);
}
