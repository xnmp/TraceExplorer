/**
 * Anything the user can select and focus in the Trace view is either a tile (`data-node-key`) or a
 * reference badge (`data-reference-key`). Look both up the same way, so revealing, anchoring and
 * focusing never treat one kind as absent.
 */
export const selectableSelector = (key: string): string => `[data-node-key="${CSS.escape(key)}"], [data-reference-key="${CSS.escape(key)}"]`;

/** Shared hit targets for graph cards, reference badges, covers and host/fallback file tiles. */
export const SELECTABLE_TILES = "[data-node-key], [data-reference-key], [data-entry-path]";
