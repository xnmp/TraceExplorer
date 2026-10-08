/**
 * Fixed tile bounds. Every tile has the same width and image size, whatever
 * the selection or focus; only rows a node always carries (its scope marker,
 * its expansion hint) add height. Title completion, image decoding and
 * selection changes therefore never resize a tile. The Svelte tiles use these
 * same numbers as CSS sizes.
 */
export const TILE = {
  border: 1,
  padding: 5,
  label: 18,
  scope: 28,
  hint: 16,
  width: 92,
  image: 51,
} as const;

/** What a node always shows besides its image and title. */
export interface TileShape { readonly foreign: boolean; readonly hint: boolean }
export interface TileSize { readonly width: number; readonly height: number; readonly imageHeight: number }

export function tileSize(shape: TileShape): TileSize {
  const chrome = 2 * TILE.border + 2 * TILE.padding + TILE.label;
  return {
    width: TILE.width,
    imageHeight: TILE.image,
    height: chrome + TILE.image + (shape.foreign ? TILE.scope : 0) + (shape.hint ? TILE.hint : 0),
  };
}

export const SPACING = {
  /**
   * Gap between tiles of one generation (stacked tiles when running right);
   * also the lane for routes passing them. Room for two lanes inside the
   * clearance either side; further routes take another gap or a margin.
   */
  column: 16,
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
