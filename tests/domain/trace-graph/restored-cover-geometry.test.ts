import { expect, it } from 'vitest';
import { createDefaultEngine, planBands } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { displayIdentity, rememberDisplay } from '$lib/domain/trace-graph/folder-layout/display-memory';
import { folderGridGeometry } from '$lib/domain/trace-graph/folder-grid';
import { buildFolderScene } from '$lib/domain/trace-graph/folder-scene';
import { mapPathNumbers, pathNumbers } from '$lib/domain/trace-graph/path-data';
import { node } from '../../../layout-eval/corpus';
import { makeFolder, folderInput, sourcesOf } from './folder-layout-fixtures';

it('rejects restored connectors detached from their painted cover cell', () => {
  const folder = makeFolder({ stacks: [[node('root'), node('a', ['root'], 1)]] });
  const input = folderInput(folder, { open: ['s0:root'], width: 640 });
  const engine = createDefaultEngine(), before = engine(input);
  const graph = before.graphs.get('s0:root')!, dx = 200;
  const attached = { ...graph.attached,
    nodes: new Map([...graph.attached.nodes].map(([k, n]) => [k, { ...n, x: n.x + dx }])),
    junctions: new Map([...graph.attached.junctions].map(([k, j]) => [k, { ...j, x: j.x + dx }])),
    routes: graph.attached.routes.map(r => ({ ...r, path: mapPathNumbers(r.path, (v, i) => v + (i % 2 ? 0 : dx)) })),
  };
  const forged = { ...before, graphs: new Map([['s0:root', { ...graph, attached }]]) };
  expect(folderGeometryGate(forged)).not.toBeNull();
  const plans = planBands(input, folderGridGeometry(input.width, input.tile, input.grid));
  const displays = rememberDisplay(undefined, displayIdentity(input, plans), forged);
  const result = createDefaultEngine()({ ...input, previous: { ...before, displays } });
  const scene = buildFolderScene({ scope: { paneId: 'review', directory: '/f', generation: 0 },
    layoutInput: input, layout: result, sources: sourcesOf(folder),
    styling: { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null } });
  const cover = [...scene.tiles.values()].find(t => t.cover)!;
  const route = [...scene.routes.values()].find(r => r.route.from.id === 's0:root')!;
  expect(result.revisited).toBeUndefined();
  expect(folderGeometryGate(result)).toBeNull();
  expect(pathNumbers(route.route.path)[0]).toBe(cover.rect.x + cover.rect.width / 2);
});

it.each([NaN, Infinity, -Infinity])('rejects nonfinite painted cover coordinates: %s', x => {
  const input = folderInput(makeFolder({ stacks: [[node('root'), node('a', ['root'], 1)]] }), { open: ['s0:root'] });
  const before = createDefaultEngine()(input);
  const forged = { ...before, cells: new Map([...before.cells].map(([id, cell]) => [id, { ...cell, x }])) };
  expect(folderGeometryGate(forged)).not.toBeNull();
  const plans = planBands(input, folderGridGeometry(input.width, input.tile, input.grid));
  const displays = rememberDisplay(undefined, displayIdentity(input, plans), forged);
  const result = createDefaultEngine()({ ...input, previous: { ...before, displays } });
  expect(result.revisited).toBeUndefined();
  expect(result.cells).toEqual(before.cells);
});
