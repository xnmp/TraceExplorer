import { expect, it } from 'vitest';
import { overlapLength, type Segment } from '$lib/domain/trace-graph/layout-quality';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { tileMetrics, tileSize } from '$lib/domain/trace-graph/metrics';
import { screenshot } from '../../../layout-eval/corpus';
import { folderInput, makeFolder } from './folder-layout-fixtures';

it('does not turn a degenerate cubic fragment into an asymmetric shared lane', () => {
  const horizontal: Segment = [{ x: 160, y: 117 }, { x: 206.5, y: 117 }];
  const fragment: Segment = [{ x: 162, y: 116.99999999998772 }, { x: 161.99999999999997, y: 116.99999999998872 }];
  expect(overlapLength(horizontal, fragment)).toBe(0);
  expect(overlapLength(fragment, horizontal)).toBe(0);
  expect(overlapLength(horizontal, [{ x: 162, y: 117 }, { x: 174, y: 117 }])).toBe(12);
});

it('certifies packed cover stems without widening or replacing the normal candidates', () => {
  const folder = makeFolder({ stacks: [screenshot.nodes, screenshot.nodes] });
  const engine = createDefaultEngine();
  const states = [360, 454, 640, 900, 1400].flatMap(width => [48, 64, 96, 128].map(image => ({ width, image })));
  let fallbacks = 0;
  for (const { width, image } of states) {
    const tile = tileMetrics(image), columns = Math.max(1, Math.floor((width + 16) / (tile.width + 16)));
    const pane = columns * tile.width + (columns - 1) * 16;
    const layout = engine(folderInput(folder, { open: folder.stacks.keys(), width: pane, tile,
      grid: { cellWidth: tile.width, cellHeight: tileSize({ foreign: false, hint: true }, tile).height, gap: 16 } }));
    expect(folderGeometryGate(layout), `${width}/${image}`).toBeNull();
    expect(layout.size.width, `${width}/${image}`).toBeLessThanOrEqual(pane);
    if (layout.decision?.fallback || [...layout.graphs.values()].some(g => g.layout.decision?.fallback === 'geometry-fallback')) fallbacks++;
  }
  expect(fallbacks / states.length).toBe(0);
});

it('does not invent shared length at a translated collinear endpoint', () => {
  for (const shift of [0, 1000, -300]) {
    const a: Segment = [{x:290.5,y:303.67+shift},{x:290.5,y:316.5+shift}];
    const b: Segment = [{x:290.5,y:316.5+shift},{x:290.5,y:332.75+shift}];
    expect(overlapLength(a,b)).toBe(0);
    expect(overlapLength(b,a)).toBe(0);
    expect(overlapLength(a,[{x:290.5,y:316.499+shift},b[1]])).toBeCloseTo(.001,8);
  }
});
