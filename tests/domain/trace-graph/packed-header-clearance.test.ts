import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { folderGeometryGate } from '$lib/domain/trace-graph/folder-layout/geometry-gate';
import { tileMetrics } from '$lib/domain/trace-graph/metrics';
import { folderInput, makeFolder, handCase } from './folder-layout-fixtures';
it('keeps ordinary shared-row attachment lanes clear without changing route identities', () => {
  const folder=makeFolder({stacks:[handCase('screenshot'),handCase('merges-3')]}), engine=createDefaultEngine();
  const layout=engine(folderInput(folder,{open:[...folder.stacks.keys()],width:640,tile:tileMetrics(96)}));
  expect(folderGeometryGate(layout)).toBeNull();
  expect(layout.decision?.fallback).toBeUndefined();
});
