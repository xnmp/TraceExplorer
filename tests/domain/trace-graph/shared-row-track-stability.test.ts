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

const harnessVillage = [
  node('village'), node('palette'), { ...node('mist'), scope: 'subfolder' as const }, { ...node('lantern'), scope: 'external' as const },
  node('daylight', ['village'], 1), node('warm', ['village', 'palette', 'mist', 'lantern'], 2), node('cool', ['palette'], 3),
  node('morning', ['daylight'], 4), node('sunny', ['daylight'], 5), node('evening', ['warm'], 6), node('rain', ['warm'], 7),
  { ...node('merge', ['daylight', 'warm'], 8), temporary: true }, node('quiet', ['rain'], 9),
  node('dawn', ['daylight'], 10), node('noon', ['daylight'], 11), node('dusk', ['daylight'], 12),
];

const scenario = (harness: boolean) => {
  // Mirrors view-fixture.ts ?deeper=1&fanChildren=2: 18 existing plus two
  // additional direct fan children; the unexpanded forest has hinted mist.
  const folder = makeFolder({ stacks: [
    harness ? harnessVillage : [node('village'), node('daylight', ['village'], 1), node('warm', ['village'], 2), node('morning', ['daylight'], 3)],
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
  return { before, after, forest, fan, folder, options };
};

// Engine counterpart of e2e/stack-grid.spec.ts's later-row attachment-motion fixme.
// Motion cannot continue to the same destination when an unrelated opening changes that destination.
describe.each([false, true])('shared-row attachment stability (full harness graph: %s)', harness => {
  let result: ReturnType<typeof scenario>;
  beforeAll(() => {
    result = scenario(harness);
    const { before, after, forest, fan } = result;
    // Admission and wrapping are part of the feature contract too.
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

  it('keeps an unchanged band fixed when a neighbor wraps below it', () => {
    const { before, after, forest } = result;
    // Observable folder coordinates, including every unchanged child. On main:
    // Before consolidation both children moved from y=131 to y=137.
    expect(childRectangles(after.graphs.get(forest)!)).toEqual(childRectangles(before.graphs.get(forest)!));
    expect(after.graphs.get(forest)!.attached.routes).toEqual(before.graphs.get(forest)!.attached.routes);
    expect(after.decision?.fallback).toBeUndefined();
    expect(before.decision?.fallback).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 0])('ignores an invalid retained attachment track (%s)', track => {
    const { before, forest, fan, folder, options } = result;
    const graph = before.graphs.get(forest)!;
    const previous = { ...before, graphs: new Map(before.graphs).set(forest, { ...graph, placement: { ...graph.placement, track } }) };
    const after = createDefaultEngine()(folderInput(folder, { ...options, open: [forest, fan], previous }));
    expect(folderGeometryGate(after)).toBeNull();
    expect(after.graphs.get(fan)!.attached.nodes.size).toBe(21);
    expect(after.decision?.fallback).toBeUndefined();
  });

  it.each([40, 1e20])('rejects finite attachment metadata that does not replay the committed drawing (%s)', stemRoom => {
    const { before, forest, fan, folder, options } = result;
    const graph = before.graphs.get(forest)!;
    const previous = { ...before, graphs: new Map(before.graphs).set(forest, { ...graph, placement: { ...graph.placement, stemRoom } }) };
    const after = createDefaultEngine()(folderInput(folder, { ...options, open: [forest, fan], previous }));
    expect(folderGeometryGate(after)).toBeNull();
    expect(after.decision?.fallback).toBeUndefined();
    expect(after.graphs.get(forest)!.placement.track).toBe(10);
    expect(after.graphs.get(forest)!.placement.stemRoom).toBe(40);
  });
});
