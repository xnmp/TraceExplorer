/**
 * A row-major folder grid with full-width bands inserted between its rows.
 * The caller supplies host-sorted items, already collapsed to one stack at
 * its cover's position (other lineage members must not occur in this list).
 * Bands consume height only; the item index alone determines row and column.
 */
export type GridItemId = string;

export interface GridItem {
  /** Stable motion identity: an entry path or a stack's cover key, not a component id. */
  readonly id: GridItemId;
  readonly kind: "file" | "folder" | "stack";
}

export interface GridMetrics {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
}

export interface GridRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GridCell extends GridRect {
  readonly id: GridItemId;
  /** Logical grid coordinates; opening a band never adds a logical row. */
  readonly row: number;
  readonly col: number;
}

export interface GridBand extends GridRect {
  readonly id: GridItemId;
  /** The stack's logical grid row. */
  readonly row: number;
}

export interface GridFlow {
  readonly width: number;
  readonly height: number;
  readonly rowCount: number;
  /** In input order, including folders and closed stacks. */
  readonly cells: ReadonlyMap<GridItemId, GridCell>;
  /** In grid order, independent of the open map's insertion order. */
  readonly bands: readonly GridBand[];
}

const finiteNonnegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  return value;
};

/**
 * O(items + bands), with no sorting or graph traversal. Coordinates start at
 * (0, 0); callers add their own pane padding. Band height excludes the grid
 * cover row. Bands start at that row's bottom and touch one another when
 * several stacks in the row are open. The usual row gap follows all bands.
 * Unknown open ids and ids of ordinary entries are ignored (stale refreshes
 * are harmless). Zero-height bands are allowed. Invalid metrics, active band
 * heights, duplicate item ids or overflowing extents throw RangeError.
 */
export function gridFlow(items: readonly GridItem[], open: ReadonlyMap<GridItemId, number>, columns: number, metrics: GridMetrics): GridFlow {
  if (!Number.isSafeInteger(columns) || columns < 1) throw new RangeError("columns must be a positive safe integer");
  const cellWidth = finiteNonnegative(metrics.cellWidth, "cellWidth");
  const cellHeight = finiteNonnegative(metrics.cellHeight, "cellHeight");
  const columnGap = finiteNonnegative(metrics.columnGap, "columnGap");
  const rowGap = finiteNonnegative(metrics.rowGap, "rowGap");
  if (cellWidth === 0 || cellHeight === 0) throw new RangeError("cells must have positive dimensions");
  const width = finiteNonnegative(columns * cellWidth + (columns - 1) * columnGap, "grid width");
  const cells = new Map<GridItemId, GridCell>();
  const bands: GridBand[] = [];
  let y = 0;
  for (let start = 0, row = 0; start < items.length; start += columns, row++) {
    const end = Math.min(start + columns, items.length);
    let bottom = y + cellHeight;
    for (let index = start; index < end; index++) {
      const item = items[index], col = index - start;
      if (cells.has(item.id)) throw new RangeError(`duplicate grid item: ${item.id}`);
      cells.set(item.id, { id: item.id, row, col, x: col * cellWidth + col * columnGap, y, width: cellWidth, height: cellHeight });
      if (item.kind === "stack" && open.has(item.id)) {
        const height = finiteNonnegative(open.get(item.id)!, `band height: ${item.id}`);
        bands.push({ id: item.id, row, x: 0, y: bottom, width, height });
        bottom += height;
      }
    }
    y = finiteNonnegative(bottom + (end < items.length ? rowGap : 0), "grid height");
  }
  return { width, height: y, rowCount: Math.ceil(items.length / columns), cells, bands };
}

export interface GridItemChange {
  readonly id: GridItemId;
  /** null for arrivals/departures, respectively. */
  readonly before: GridRect | null;
  readonly after: GridRect | null;
}

/** Match by identity, including arrivals and departures; never match by cell index. */
export function mapGridItemRects(before: GridFlow, after: GridFlow): ReadonlyMap<GridItemId, GridItemChange> {
  const rect = (cell: GridCell | undefined): GridRect | null => cell
    ? { x: cell.x, y: cell.y, width: cell.width, height: cell.height } : null;
  const changes = new Map<GridItemId, GridItemChange>();
  for (const [id, cell] of before.cells) changes.set(id, { id, before: rect(cell), after: rect(after.cells.get(id)) });
  for (const [id, cell] of after.cells) if (!changes.has(id)) changes.set(id, { id, before: null, after: rect(cell) });
  return changes;
}
