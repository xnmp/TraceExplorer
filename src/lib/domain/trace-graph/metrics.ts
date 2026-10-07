/**
 * Fixed tile bounds. Every tile size is a function of (large, foreign, hint)
 * only, so title completion and image decoding can never rearrange the graph.
 * The Svelte tiles use these same numbers as CSS sizes.
 */
export const TILE = {
  border: 1,
  padding: 5,
  label: 18,
  scope: 28,
  hint: 16,
  large: { width: 168, image: 101 },
  small: { width: 92, image: 51 },
} as const;

export interface TileShape { readonly large: boolean; readonly foreign: boolean; readonly hint: boolean }
export interface TileSize { readonly width: number; readonly height: number; readonly imageHeight: number }

export function tileSize(shape: TileShape): TileSize {
  const kind = shape.large ? TILE.large : TILE.small;
  const chrome = 2 * TILE.border + 2 * TILE.padding + TILE.label;
  return {
    width: kind.width,
    imageHeight: kind.image,
    height: chrome + kind.image + (shape.foreign ? TILE.scope : 0) + (shape.hint ? TILE.hint : 0),
  };
}

export const SPACING = {
  /** Horizontal gap between tiles; also the vertical lane for passing routes. */
  column: 28,
  /** Side margin kept free for routes around a row. */
  margin: 20,
  top: 18,
  bottom: 14,
  /** Channel below the last display row of a generation. */
  bandChannel: 46,
  /** Channel between wrapped display rows of one generation. */
  rowChannel: 34,
  /** Extra channel height per nested junction level. */
  junctionLevel: 26,
  /** Minimum distance between junctions sharing a level. */
  junctionSpacing: 18,
  /** Clearance kept between a passing route and a tile edge. */
  clearance: 6,
  /** Separation between routes sharing one gap. */
  lane: 4,
  arrow: 3,
  minWidth: 360,
} as const;
