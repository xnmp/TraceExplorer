/**
 * Tile bounds. Every tile of a view has the same width and image size,
 * whatever the selection or focus; only rows a node always carries (its scope
 * marker, its expansion hint) add height. Title completion, image decoding and
 * selection changes therefore never resize a tile. The Svelte tiles use these
 * same numbers as CSS sizes.
 *
 * `TILE` is the default tile, which the view uses when the host does not say
 * how large its tiles are (hosts without the SDK's `tileSize` capability).
 * Width and image follow the host's tile-size setting (`tileMetrics`); the
 * text rows (label, scope, hint) keep their heights, since their text does not
 * grow with the setting.
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

/** Chrome between a tile's edge and its image, either side. */
const INSET = TILE.border + TILE.padding;
/** Image aspect (height over width), as in the default tile's 80 × 51 image. */
const IMAGE_ASPECT = TILE.image / (TILE.width - 2 * INSET);
/**
 * Tile width beyond the host's thumbnail edge. The host's tiles are their
 * thumbnail plus 44 px of chrome from its medium preset up (108, 140 and
 * 172 px wide for 64, 96 and 128 px thumbnails), so Trace tiles are as wide
 * as the host's own for the same setting. Its smallest preset (48 px) then
 * gives the default tile, 92 px.
 */
const HOST_TILE_CHROME = 44;
/** The host thumbnail edge the default tile corresponds to: its "small" preset. */
export const DEFAULT_IMAGE_PX = TILE.width - HOST_TILE_CHROME;
/** Host thumbnail edges outside this range are clamped; the host's presets span 48–128 px. */
const IMAGE_PX_RANGE = [24, 512] as const;

/** The size of every tile in a view: its width and image height. */
export interface TileMetrics { readonly width: number; readonly image: number }

/**
 * Tile metrics for the host's thumbnail edge (`PaneTileSize.imagePx`). A
 * missing or invalid edge gives the default tile.
 */
export function tileMetrics(imagePx?: number | null): TileMetrics {
  if (typeof imagePx !== "number" || !Number.isFinite(imagePx) || imagePx <= 0) return { width: TILE.width, image: TILE.image };
  const edge = Math.round(Math.min(IMAGE_PX_RANGE[1], Math.max(IMAGE_PX_RANGE[0], imagePx)));
  const width = edge + HOST_TILE_CHROME;
  return { width, image: Math.round((width - 2 * INSET) * IMAGE_ASPECT) };
}

/** What a node always shows besides its image and title. */
export interface TileShape { readonly foreign: boolean; readonly hint: boolean }
export interface TileSize { readonly width: number; readonly height: number; readonly imageHeight: number }

export function tileSize(shape: TileShape, metrics: TileMetrics = tileMetrics()): TileSize {
  const chrome = 2 * TILE.border + 2 * TILE.padding + TILE.label;
  return {
    width: metrics.width,
    imageHeight: metrics.image,
    height: chrome + metrics.image + (shape.foreign ? TILE.scope : 0) + (shape.hint ? TILE.hint : 0),
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
 * Bend room in a channel between generations without junctions, at the
 * default tile: three bend tracks, so up to three crossing sources bend in
 * slices of their own before the channel grows.
 */
const BEND = 3 * TRACK_HEIGHT;
/** Bend room between wrapped rows of one generation: two tracks. */
const ROW_BEND = 2 * TRACK_HEIGHT;

/**
 * Spacing for tiles `tileWidth` wide. What frames the tiles grows with them,
 * so a view of larger tiles keeps its proportions: the gap between tiles, the
 * side margins and the bend room (routes between larger tiles bend across
 * wider offsets, and keep their slope). What serves the lines does not: the
 * arrowhead and its approach, junction levels, clearances and lanes stay as
 * legible as at the default size. Tiles narrower than the default keep the
 * default spacing, which their routes still need.
 */
export function spacingFor(tileWidth?: number) {
  const scale = typeof tileWidth === "number" && Number.isFinite(tileWidth) && tileWidth > TILE.width ? tileWidth / TILE.width : 1;
  const grow = (value: number) => Math.round(value * scale);
  return {
    /**
     * Gap between tiles of one generation (stacked tiles when running right);
     * also the lane for routes passing them. Room for two lanes inside the
     * clearance either side at the default size; further routes take another
     * gap or a margin.
     */
    column: grow(16),
    /** Side margin kept free for routes around a row. */
    margin: grow(20),
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
    bandChannel: grow(BEND) + 2 * ARROW.length,
    /** Channel between wrapped display rows of one generation. */
    rowChannel: grow(ROW_BEND) + 2 * ARROW.length,
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
}

export type Spacing = ReturnType<typeof spacingFor>;

/** Spacing at the default tile size. */
export const SPACING: Spacing = spacingFor();

/** A route this close to a junction it does not belong to reads as passing through it; dots keep this berth above and below. */
export const JUNCTION_BERTH = 6;

/**
 * Default heights of a channel's bend zones, top to bottom, for `levels`
 * junction levels. A channel is its bend zones, the junction levels between
 * them, then the approach (a straight stem and the arrowhead). Each junction
 * level adds `junctionLevel`: its dot's berths and the zone between it and
 * the next level; the bend room left either side of the levels is split
 * evenly. A zone grows past its default when its bend tracks need more.
 */
export function bendZones(spacing: Spacing, levels: number, betweenBands = true): number[] {
  if (levels <= 0) return [(betweenBands ? spacing.bandChannel : spacing.rowChannel) - spacing.approach];
  const end = (spacing.bandChannel - spacing.approach + spacing.junctionLevel) / 2 - JUNCTION_BERTH;
  return Array.from({ length: levels + 1 }, (_, zone) => zone === 0 || zone === levels ? end : spacing.junctionLevel - 2 * JUNCTION_BERTH);
}
