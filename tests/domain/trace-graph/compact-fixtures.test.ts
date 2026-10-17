import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { cellsOf, folderInput, makeFolder } from './folder-layout-fixtures';
import { node } from '../../../layout-eval/corpus';
import { TILE_GRID_PX, TILE_IMAGE_PX } from '../../../e2e/harness/tile-presets';

// Match layout-compact.spec.ts's nodes, host presets, listing columns and click history.
it.each(['deep', 'wrapped'] as const)('computes compact %s band through the harness folder engine', scene => {
  const deep = scene === 'deep', preset = deep ? 'large' : 'xlarge';
  const stacks = deep ? [[node('deep'), node('Cerulean', ['deep'], 1), node('Saffron', ['deep'], 2), node('Blastoise', ['Saffron'], 3), node('Ash', ['Saffron'], 4), node('Charizard', ['Ash'], 5)]]
    : ['stack-a', 'stack-b'].map(root => [node(root), node(`${root}-1`, [root], 1), node(`${root}-2`, [root], 2)]);
  const folder = makeFolder({ stacks, files: deep ? 6 : 1 });
  const cells = cellsOf(folder), ids = [...folder.stacks.keys()];
  const items = deep ? [...cells.slice(1, 6), cells[0], cells[6]] : [cells[0], cells[2], cells[1]];
  const image = TILE_IMAGE_PX[preset];
  // Host padding takes 8 px on either side of the measured pane.
  const options = { items, width: (deep ? 1150 : 625) - 16, tile: tileMetrics(image),
    grid: { cellWidth: TILE_GRID_PX[preset], cellHeight: 22 + image + 4 + 37 + 2, gap: 6 } };
  const engine = createDefaultEngine();
  let previous = engine(folderInput(folder, options));
  for (let i = 0; i < ids.length; i++) previous = engine(folderInput(folder, { ...options, open: ids.slice(0, i + 1), previous }));
  if (deep) {
    const choices = new Map([['s0:Saffron', true]]);
    previous = engine(folderInput(folder, { ...options, open: ids, previous, expansion: { choices, reveals: [] } }));
    previous = engine(folderInput(folder, { ...options, open: ids, previous, expansion: { choices: new Map([...choices, ['s0:Ash', true]]), reveals: [] } }));
  }
  expect(previous.columns).toBe(deep ? 7 : 3);
  const height = previous.rowBands[0].height;
  console.log(`COMPACT ${scene}: ${height}px`);
  expect(height).toBeLessThanOrEqual(deep ? 460 : 390);
});
