/** Painted obstacle bounds are distinct from a stretched grid allocation. */
import type { GridRect } from '../grid-flow';
import type { FolderLayout, FolderLayoutInput } from './types';

export const centeredCellFootprint = (cell: GridRect, width: number): GridRect => ({
  x: cell.x + (cell.width - width) / 2, y: cell.y, width, height: cell.height,
});

export function withCellFootprints(layout: FolderLayout, input: FolderLayoutInput): FolderLayout {
  const kinds = new Map(input.items.map(item => [item.id, item.kind]));
  return { ...layout, cellFootprints: new Map([...layout.cells].map(([id, cell]) => {
    // Trace owns cover painting. Host ordinary renderers are conservative unless
    // their adapter supplies a finite painted width; minimum cell width is not it.
    const width = kinds.get(id) === 'stack' ? input.tile.width : input.grid.contentWidth;
    return [id, width !== undefined && Number.isFinite(width) && width > 0
      ? centeredCellFootprint(cell, width) : cell];
  })) };
}
