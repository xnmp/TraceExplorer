import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { createFolderLayoutRuntime } from '$lib/plugins/trace/view/folder-layout-runtime';
import { node } from '../../../layout-eval/corpus';
import { folderInput, makeFolder } from '../../domain/trace-graph/folder-layout-fixtures';

it('budgets the certification and restore of a retained large drawing', () => {
  const input = folderInput(makeFolder({ stacks: [[node('root'), ...Array.from({ length: 2000 }, (_, i) => node(`n${i}`, ['root'], i + 1))]] }), { open: ['s0:root'], width: 900 });
  const workerOutput = createDefaultEngine()(input);
  const runtime = createFolderLayoutRuntime();
  runtime.remember(structuredClone(workerOutput));
  const request = { ...input, dataRevision: 'status-only-refresh', previous: structuredClone(workerOutput) };
  const inline = runtime.inline(request);
  expect(inline).toBe(false);
}, 30_000);

it('keeps a small restored drawing within the inline budget', () => {
  const input = folderInput(makeFolder({ stacks: [[node('root')]] }), { open: ['s0:root'] });
  const previous = createDefaultEngine()(input);
  const runtime = createFolderLayoutRuntime();
  runtime.remember(previous);
  const request = { ...input, previous, dataRevision: 'status-only-refresh' };
  expect(runtime.inline(request)).toBe(true);
  expect(runtime.engine(request).revisited).toBe(true);
});

it.each([[90, true], [91, false]] as const)('dispatches a %i-tile restored folder at the calibrated boundary', (files, inline) => {
  const input = folderInput(makeFolder({ stacks: [], files }));
  const runtime = createFolderLayoutRuntime();
  const previous = runtime.engine(input);
  const request = { ...input, previous, dataRevision: 'status-only-refresh' };
  expect(runtime.inline(request)).toBe(inline);
  expect(runtime.engine(request).revisited).toBe(true);
});

it('does not charge a small restore for an unrelated large display in its ledger', () => {
  const folder = makeFolder({ stacks: [[node('root'), ...Array.from({ length: 100 }, (_, i) => node(`n${i}`, ['root'], i + 1))]] });
  const runtime = createFolderLayoutRuntime();
  const opened = runtime.engine(folderInput(folder, { open: ['s0:root'] }));
  const closed = folderInput(folder, { previous: opened });
  const previous = runtime.engine(closed);
  const refresh = { ...closed, previous, dataRevision: 'status-only-refresh' };
  expect(runtime.inline(refresh)).toBe(true);
  expect(runtime.engine(refresh).revisited).toBe(true);
});

it('budgets hidden band members whose metadata the restored display still decodes', () => {
  const nodes = Array.from({ length: 2001 }, (_, i) => node(`n${i}`, i ? [`n${i - 1}`] : [], i));
  const input = folderInput(makeFolder({ stacks: [nodes] }), { open: ['s0:n0'] });
  const workerOutput = createDefaultEngine()(input);
  expect(workerOutput.graphs.get('s0:n0')!.attached.nodes.size).toBe(2);
  const runtime = createFolderLayoutRuntime();
  runtime.remember(workerOutput);
  expect(runtime.inline({ ...input, previous: workerOutput, dataRevision: 'status-only-refresh' })).toBe(false);
});
