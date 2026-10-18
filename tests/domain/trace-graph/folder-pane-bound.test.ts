import { expectFolderArrivalPinned } from './folder-arrival-contract';
import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { fallbackGridMetrics } from '$lib/domain/trace-graph/folder-grid';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { corpusNode as node, folderInput, makeFolder } from './folder-layout-fixtures';

it('routes an arrival around a centered ordinary tile within the pane, preserving all retained rectangles', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(96);
  const input = (grow: boolean) => {
    const folder = makeFolder({ stacks: [[node('root'), node('a', ['root'], 1), ...(grow ? [node('b', ['root'], 2)] : [])]], files: 1 });
    const request = folderInput(folder, { open: ['s0:root'], width: 200, tile, grid: fallbackGridMetrics(tile) });
    return { ...request, open: new Map([...request.open].map(([id, stack]) => [id, { ...stack, expanded: new Map(stack.members.map(key => [key, true])) }])) };
  };
  const before = engine(input(false)), after = engine({ ...input(true), previous: before });
  expect(after.bounds.x + after.bounds.width).toBeLessThanOrEqual(200);
  expect(after.size.width).toBeLessThanOrEqual(200);
  expect(folderGeometryGate(after)).toBeNull();
  expect(after.cells).toEqual(before.cells);
  expectFolderArrivalPinned(before, after);
  expect(after.graphs.get('s0:root')!.attached.nodes.has('s0:b')).toBe(true);
});

it('rejects malformed physical footprints instead of hiding cell collisions', () => {
  const tile = tileMetrics(96);
  const folder = makeFolder({ stacks: [], files: 2 });
  const base = createDefaultEngine()(folderInput(folder, { width: 360, tile }));
  const entries = [...base.cells];
  const [a, cell] = entries[0], [b] = entries[1];
  const collided = { ...base, cells: new Map([[a, cell], [b, { ...cell, id: b }]]) };
  expect(folderGeometryGate({ ...collided, cellFootprints: undefined })).not.toBeNull();
  expect(folderGeometryGate({ ...collided, cellFootprints: new Map([
    [a, { x:cell.x, y:cell.y, width:1, height:1 }],
    [b, { x:200, y:cell.y, width:1, height:1 }],
  ]) })).not.toBeNull();
  expect(folderGeometryGate({ ...base, cellFootprints: {} as never })).not.toBeNull();
});

it('does not add band padding to ordinary world-coordinate cells during a merge arrival', () => {
  const engine = createDefaultEngine(), tile = tileMetrics(64);
  const input = (grow: boolean) => {
    const folder = makeFolder({stacks:[[node('root'),node('a',['root'],1),node('b',['root'],2),
      ...(grow ? [node('c',['a','b'],3)] : [])],[node('root'),node('child',['root'],1)]],files:1});
    const request = folderInput(folder,{open:folder.stacks.keys(),width:200,tile,grid:fallbackGridMetrics(tile)});
    return {...request,open:new Map([...request.open].map(([id,s]) => [id,{...s,expanded:new Map(s.members.map(k=>[k,true]))}]))};
  };
  const before = engine(input(false)), after = engine({...input(true),previous:before});
  expect(after.size.width).toBeLessThanOrEqual(200);
  expect(folderGeometryGate(after)).toBeNull();
  expectFolderArrivalPinned(before, after);
}, 30_000); // A budget fallback spends the constrained search's finite allowance before legacy runs.
