/** Existing committed-history/index reach, shared with numerical charts.
 * This bounds arithmetic evidence; it is not an ink-clearance tolerance. */
export const MAX_INDEX_ROWS = 65_536;
export const inReach = (value: number): boolean => Number.isFinite(value) && Math.abs(value) <= MAX_INDEX_ROWS * 64;
