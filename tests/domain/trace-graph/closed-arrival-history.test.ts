import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import type { FolderLayout } from '$lib/domain/trace-graph/folder-layout/types';
import { corpusNode as node, folderInput, makeFolder } from './folder-layout-fixtures';

it.each([true, false])('preserves arrival snapshots when reopening after closed growth (revision supplied: %s)', revision => {
  const engine = createDefaultEngine();
  const nodes = [node('root'), node('a', ['root'], 1)];
  const input = (previous?: FolderLayout, open = true) => ({
    ...folderInput(makeFolder({ stacks: [nodes] }), { open: open ? ['s0:root'] : [], previous }),
    ...(revision ? { dataRevision: `contents-${nodes.length}` } : {}),
  });
  let result = engine(input());
  nodes.push(node('b', ['root'], 2)); result = engine(input(result));
  const history = result.arrivals!.get('s0:root')!.history;
  expect(history).toBeDefined();
  result = engine(input(result, false));
  nodes.push(node('c', ['root'], 3)); result = engine(input(result, false));
  const placement = result.arrivalPlacement;
  result = engine(input(result));
  expect(result.arrivals!.get('s0:root')!.history).toBe(history);
  expect(result.arrivalPlacement).toEqual(placement);
  expect(result.graphs.get('s0:root')!.attached.nodes.has('s0:c')).toBe(true);
  const drawing = (layout: FolderLayout) => [layout.cells, layout.bands, [...layout.graphs].map(([id, graph]) =>
    [id, [...graph.attached.nodes], graph.attached.routes, [...graph.attached.junctions], graph.origin])];
  const beforeRoundTrip = drawing(result);
  result = engine(input(result, false));
  result = engine(input(result));
  expect(drawing(result)).toEqual(beforeRoundTrip);
  expect(result.arrivals!.get('s0:root')!.history).toBe(history);
});

it('does not commit arrival history for a data revision that changes no contents', () => {
  const engine = createDefaultEngine();
  const folder = makeFolder({ stacks: [[node('root'), node('a', ['root'], 1)]] });
  const input = folderInput(folder, { open: ['s0:root'] });
  const before = engine({ ...input, dataRevision: 'before-status-update' });
  const after = engine({ ...input, previous: before, dataRevision: 'after-status-update' });
  expect(after.arrivals).toEqual(before.arrivals);
  expect(after.arrivalPlacement).toEqual(before.arrivalPlacement);
});
