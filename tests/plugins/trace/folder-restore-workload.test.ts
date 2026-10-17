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
