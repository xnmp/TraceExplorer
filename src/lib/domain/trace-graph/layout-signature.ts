/** Exact layout request identity: equal signatures mean equal layouts (`layoutGraph` is deterministic). */
import type { GraphLayout, LayoutRequest } from "./layout";

const geometrySignature = (layout: GraphLayout) => [layout.orientation, layout.width, layout.height, layout.bandBounds, layout.preferredX, layout.anchorX, layout.anchorY, layout.decision,
  [...layout.nodes], [...layout.junctions], layout.routes, layout.rows, [...layout.readingOrder]];

export function layoutSignature(request: LayoutRequest): string {
  // Width is normalised exactly as the engine does, so equal keys mean equal
  // layouts. Running right the engine ignores the width (generations never
  // wrap), so resizing must not recompute an identical layout.
  const width = request.band ? request.maxWidth : request.orientation !== "right" && Number.isFinite(request.maxWidth) && request.maxWidth > 0 ? Math.floor(request.maxWidth) : null;
  return JSON.stringify([width, request.items.map((item) => [item.key, item.width, item.height, item.order, item.parents]), request.hint ? [...request.hint] : null, request.orientation ?? "down", request.orientation === "right" ? request.extent ?? null : null, request.tileWidth ?? null, request.pinned ? [request.pinned.key, request.pinned.x, request.pinned.obstacles ?? []] : null, request.band ? [request.band.key, request.band.items] : null, request.anchorKey ?? null,
    request.history ? [request.history.signature, geometrySignature(request.history.layout), geometrySignature(request.history.placed), request.history.attachment] : null]);
}
