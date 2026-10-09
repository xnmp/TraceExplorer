import type { TileSizePreset } from "../../integration/plugin-sdk";

/** The host's thumbnail edge per tile-size preset (its THUMBNAIL_SIZE_CONFIG displaySize). */
export const TILE_IMAGE_PX: Record<TileSizePreset, number> = { small: 48, medium: 64, large: 96, xlarge: 128 };
/** The host's tile column width per preset (its gridMinWidth). */
export const TILE_GRID_PX: Record<TileSizePreset, number> = { small: 84, medium: 108, large: 140, xlarge: 172 };
