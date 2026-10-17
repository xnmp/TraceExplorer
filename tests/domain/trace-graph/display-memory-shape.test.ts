import { expect, it } from 'vitest';
import { createDefaultEngine } from '$lib/domain/trace-graph/folder-layout/default-engine';
import { validDisplayMemory } from '$lib/domain/trace-graph/folder-layout/display-memory';
import { folderInput, makeFolder } from './folder-layout-fixtures';

it.each(['entries', 'members', 'entry-pair', 'member-pair'])('discards sparse display memory: %s', field => {
  const input = folderInput(makeFolder({ stacks: [], files: 1 }));
  const engine = createDefaultEngine(), before = engine(input);
  const malformed = field.endsWith('-pair') ? [new Array(2)] : new Array(1);
  const key = field.startsWith('entr') ? 'entries' : 'members';
  const previous = { ...before, displays: { ...before.displays!, [key]: malformed } };
  expect(validDisplayMemory(previous.displays)).toBe(false);
  const result = engine({ ...input, previous });
  expect(result.revisited).toBeUndefined();
  expect(result.cells).toEqual(before.cells);
  expect(validDisplayMemory(result.displays)).toBe(true);
});
