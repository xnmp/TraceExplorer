/** Pure one-stack adapter: exercise the production attachment with a deterministic packing position. */
import type { GraphLayout, LayoutRequest } from "./layout";
import { attachPackedBand, bandExtent } from "./band-geometry";
export function attached(layout: GraphLayout, request: LayoutRequest): GraphLayout {
    const key = request.band!.key, cover = layout.nodes.get(key);
    if (!cover)
        return layout;
    const extent = bandExtent(layout, key), x = Math.max(0, Math.min(request.maxWidth - extent.width, (request.pinned?.x ?? request.maxWidth / 2) - extent.width / 2));
    const placed = attachPackedBand(layout, key, cover.height, { x, coverX: request.pinned?.x ?? request.maxWidth / 2, coverHeight: cover.height, width: Math.max(request.maxWidth, extent.width), left: 0, right: Math.max(request.maxWidth, extent.width) });
    if (!layout.bandBounds) return placed;
    const child = [...layout.nodes.values()].find(node => node.key !== key);
    const after = child && placed.nodes.get(child.key);
    return child && after ? { ...placed, bandBounds: { ...layout.bandBounds,
        left: layout.bandBounds.left + after.x - child.x,
        top: layout.bandBounds.top + after.y - child.y } } : placed;
}
