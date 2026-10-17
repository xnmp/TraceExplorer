import { beforeAll, describe, expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import type { FolderGraph } from '$lib/domain/trace-graph/folder-layout';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { node } from '../../../layout-eval/corpus';
import { folderInput, makeFolder } from './folder-layout-fixtures';

const childRectangles = (graph: FolderGraph) => [...graph.attached.nodes.values()]
  .filter(n => n.key !== graph.id)
  .map(n => ({ key: n.key, x: n.x + graph.origin.x, y: n.y + graph.origin.y, width: n.width, height: n.height }))
  .sort((a, b) => a.key.localeCompare(b.key));

const scenario = () => {
  const folder = makeFolder({ stacks: [
    [node('village'), node('daylight', ['village'], 1), node('warm', ['village'], 2), node('morning', ['daylight'], 3)],
    [node('forest'), node('forest-mist', ['forest'], 1), node('autumn', ['forest'], 2),
      node('mist-dawn', ['forest-mist'], 3), node('mist-dusk', ['mist-dawn'], 4)],
    [node('fan'), ...Array.from({ length: 20 }, (_, i) => node(`fan-${i}`, ['fan'], i + 1))],
  ] });
  const [village, forest, fan] = [...folder.stacks.keys()];
  const tile = tileMetrics();
  // Represent the 420 px harness scenario with 400 px of engine space (20 px view padding).
  const options = { width: 400, tile, grid: fallbackGridMetrics(tile) };
  const engine = createDefaultEngine();
  let previous = engine(folderInput(folder, options));
  // Open village, open forest, close village, then open fan while forest is unchanged.
  for (const open of [[village], [village, forest], [forest]])
    previous = engine(folderInput(folder, { ...options, open, previous }));
  const before = previous;
  const after = engine(folderInput(folder, { ...options, open: [forest, fan], previous }));
  return { before, after, forest, fan };
};

// Engine counterpart of e2e/stack-grid.spec.ts's later-row attachment-motion fixme.
// Motion cannot continue to the same destination when an unrelated opening changes that destination.
describe('shared-row attachment stability', () => {
  let result: ReturnType<typeof scenario>;
  beforeAll(() => {
    result = scenario();
    const { before, after, forest, fan } = result;
    // Keep setup/admission failures outside it.fails so they cannot masquerade as the known defect.
    expect(folderGeometryGate(before)).toBeNull();
    expect(folderGeometryGate(after)).toBeNull();
    expect(after.columns).toBe(before.columns);
    expect(after.cells).toEqual(before.cells);
    const forestBand = after.bands.find(b => b.id === forest)!;
    const fanBand = after.bands.find(b => b.id === fan)!;
    expect(fanBand.row).toBe(forestBand.row);
    expect(fanBand.y).toBeGreaterThanOrEqual(forestBand.y + forestBand.height);
    expect([...after.graphs.get(fan)!.attached.nodes.keys()]).toHaveLength(21);
  });

  it.fails('keeps an unchanged band fixed when a neighbor wraps below it (shared attachment headers currently add 6 px)', () => {
    const { before, after, forest } = result;
    // Observable folder coordinates, including every unchanged child. On main:
    // forest-mist and autumn both move from y=131 to y=137; x and sizes stay fixed.
    expect(childRectangles(after.graphs.get(forest)!)).toEqual(childRectangles(before.graphs.get(forest)!));
  });
});
