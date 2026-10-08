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

/**
 * The arrowhead every terminal route ends in, in canvas pixels: the same size
 * whatever the line's width or tone. Its tip lies on the target tile's edge
 * and its base where the route's path ends.
 */
export const ARROW = { length: 8, width: 7 } as const;

/** Height of one bend track; a bend zone grows when its tracks need more than its default height. */
export const TRACK_HEIGHT = 6;
/**
 * Bend room in a channel without junctions: three bend tracks, so up to three
 * crossing sources bend in slices of their own before the channel grows.
 */
const BEND = 3 * TRACK_HEIGHT;
/** Bend room between wrapped rows of one generation: two tracks. */
const ROW_BEND = 2 * TRACK_HEIGHT;

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
  /**
   * Straight run at the bottom of every channel, into the row below: a stem
   * as long as the arrowhead, then the arrowhead itself. Routes bend only
   * above it, so each arrowhead lies on a straight segment perpendicular to
   * the tile edge and points the way its line arrives.
   */
  approach: 2 * ARROW.length,
  /** Channel below the last display row of a generation: bend room, then the approach. */
  bandChannel: BEND + 2 * ARROW.length,
  /** Channel between wrapped display rows of one generation. */
  rowChannel: ROW_BEND + 2 * ARROW.length,
  /** Extra channel height per nested junction level. */
  junctionLevel: 26,
  /** Minimum distance between junctions sharing a level. */
  junctionSpacing: 18,
  /** Clearance kept between a passing route and a tile edge. */
  clearance: 6,
  /** Separation between routes sharing one gap. */
  lane: 4,
  minWidth: 360,
} as const;
