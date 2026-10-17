import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { prepareLayoutInput, sameGeometry, layoutBasis, type SceneIntent } from '$lib/plugins/trace/view/scene-inputs';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import type { ComponentData } from '$lib/domain/trace-graph/folder-data';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { node } from '../../../layout-eval/corpus';
import { makeFolder } from '../../domain/trace-graph/folder-layout-fixtures';

it('preserves arrivals through the real scene input adapter', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const input = (grow: boolean, previous?: FolderLayout) => {
    const folder = makeFolder({ stacks: [[node('root'), node('a', ['root'], 1), ...(grow ? [node('b', ['root'], 2)] : [])]], files: 1 });
    const token = grow ? 't2' : 't1';
    const components = new Map([...folder.stacks.values()].map(s => [s.componentId, {
      directory: '/f', token, version: grow ? 2 : 1, nodes: s.nodes, dag: s.graph.dag, members: s.graph.dag.order,
    } as ComponentData]));
    const intent: SceneIntent = { directory: '/f', listing: folder.entries, claimed: new Set(), open: new Set(['s0:root']),
      focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null,
      expansion: { choices: new Map([['s0:root', true], ['s0:a', true]]), reveals: [] },
      width: 200, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: '[]' };
    return prepareLayoutInput(intent, { index: { ...folder.index, token }, components }, new Map([['s0:root', 'c:s0:root']]), null, previous ?? null).input;
  };
  const before = engine(input(false)), request = input(true, before), after = engine(request);
  expect(request.grid.contentWidth).toBe(tile.width);
  expect(after.cells).toEqual(before.cells);
  for (const [key, n] of before.graphs.get('s0:root')!.attached.nodes)
    expect(after.graphs.get('s0:root')!.attached.nodes.get(key)).toMatchObject({ x: n.x, y: n.y, width: n.width, height: n.height });
});

it('invalidates scene reuse when the host changes only its painted content width', () => {
  const tile = tileMetrics(96), grid = fallbackGridMetrics(tile);
  const intent = { width: 640, tile, grid, cover: { imagePx: null, small: false } } as SceneIntent;
  const changed = { ...intent, grid: { ...grid, contentWidth: tile.width / 2 } };
  expect(sameGeometry(intent, changed)).toBe(false);
  const input = { items: [], open: new Map(), width: 640, tile, grid };
  expect(layoutBasis(input, [])).not.toBe(layoutBasis({ ...input, grid: changed.grid }, []));
});
