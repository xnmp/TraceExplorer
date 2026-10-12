import type { ClientArea, PointerPosition } from "$lib/domain/deselect-click";

export type MarqueeRect = ClientArea;
export interface MarqueeTile { readonly key: string; readonly rect: MarqueeRect }

/** All geometry is in viewport pixels: live DOM boxes already account for scrolling and zoom. */
export function normalizeRect(start: PointerPosition, end: PointerPosition): MarqueeRect {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function clampPoint(point: PointerPosition, area: ClientArea): PointerPosition {
  return { x: Math.max(area.left, Math.min(point.x, area.left + area.width)), y: Math.max(area.top, Math.min(point.y, area.top + area.height)) };
}

/** Strict overlap matches the host: touching edges and zero-area drags select nothing. */
export function intersectedTiles(rect: MarqueeRect, tiles: readonly MarqueeTile[]): string[] {
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
  return [...new Set(tiles.filter(({ rect: tile }) =>
    [tile.left, tile.top, tile.width, tile.height].every(Number.isFinite) && tile.width > 0 && tile.height > 0
    && tile.left + tile.width > rect.left && tile.left < rect.left + rect.width
    && tile.top + tile.height > rect.top && tile.top < rect.top + rect.height,
  ).map(({ key }) => key))];
}

/** Ctrl/Cmd adds, never toggles. Shift alone replaces. Apply repeatedly to accumulate like the host. */
export function marqueeSelection(before: readonly string[], hits: readonly string[], modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): string[] {
  return [...new Set(modifiers.ctrlKey || modifiers.metaKey ? [...before, ...hits] : hits)];
}

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  const paths = new Set(a);
  return paths.size === new Set(b).size && b.every((path) => paths.has(path));
}
