import { describe, expect, test } from 'vitest';
import { commandDraftText, commandProblem, formatCommand, isApi, newProfile, parseCommand, validConfiguration, validation, type ImageConfiguration } from './domain';

describe('credential command grammar', () => {
  test('whitespace, mixed quotes and escapes group literal argv without expansion', () => {
    expect(parseCommand(`  secret-tool  lookup service gemini `)).toEqual({ argv: ['secret-tool', 'lookup', 'service', 'gemini'], problem: null });
    expect(parseCommand(`helper 'one two' "three four" five\\ six 'single\\slash' "double\\\\slash" a"b c"d`)).toEqual({ argv: ['helper', 'one two', 'three four', 'five six', 'single\\slash', 'double\\slash', 'ab cd'], problem: null });
    expect(parseCommand(`helper $HOME *.key ~ $(whoami) ';'`)).toEqual({ argv: ['helper', '$HOME', '*.key', '~', '$(whoami)', ';'], problem: null });
    expect(parseCommand(`helper "a\\"b" ''`)).toEqual({ argv: ['helper', 'a"b', ''], problem: null });
  });
  test('incomplete quotes and escapes are problems', () => {
    for (const text of [`helper 'unfinished`, `helper "unfinished`, 'helper \\']) expect(parseCommand(text)).toMatchObject({ argv: null, problem: expect.any(String) });
  });
  test('formatting round-trips every argument including empty, quotes and Windows paths', () => {
    for (const argv of [[], ['secret-tool', 'lookup', 'service', 'gemini'], ['C:\\Program Files\\helper.exe', 'a"b', "a'b", '', '日本語', '$HOME', '*', 'two words', 'trailing\\'], ['line\nbreak', '\t']]) expect(parseCommand(formatCommand(argv))).toEqual({ argv, problem: null });
  });
});
const config = (argv: string[]): ImageConfiguration => {
  const profile = newProfile('api', 'gemini');
  if (!isApi(profile)) throw Error('Expected API profile');
  return { schemaVersion: 1, documentRevision: 0, defaultConnectionId: 'api', profiles: [{ ...profile, credential: { kind: 'command', argv } }] };
};
test('command configuration accepts valid argv and rejects domain bounds and malformed shapes', () => {
  expect(validConfiguration(config(['secret-tool', 'lookup', 'service', 'gemini']))).toBe(true);
  for (const argv of [[], ['C:helper.exe'], ['.'], ['..'], ['relative/helper'], ['relative\\helper'], ['helper', ''], ['helper', 'bad\u0085argument'], Array(33).fill('helper'), ['helper', 'é'.repeat(2049)]]) {
    expect(validation(config(argv))).not.toBeNull();
    expect(validConfiguration(config(argv))).toBe(false);
  }
  for (const argv of [null, 'helper', [null], [42]]) expect(validConfiguration(config(argv as unknown as string[]))).toBe(false);
  expect(commandProblem(['helper', 'é'.repeat(2048)])).toBeNull();
  expect(commandProblem(Array(32).fill('helper'))).toBeNull();
  expect(commandProblem(['/usr/bin/helper', 'lookup'])).toBeNull();
  expect(commandProblem(['C:\\Tools\\helper.exe'])).toBeNull();
});

test('adopting new argv replaces stale text while syntax drafts stay editable', () => {
  const draft = { text: `helper 'source A'`, argv: ['helper', 'source A'] };
  expect(commandDraftText(['helper', 'source A'], draft)).toBe(draft.text);
  expect(parseCommand(commandDraftText(['helper', 'source B'], draft)).argv).toEqual(['helper', 'source B']);
  const invalidDraft = { text: `helper 'unfinished`, argv: [] };
  expect(parseCommand(commandDraftText([], invalidDraft)).problem).not.toBeNull();
  expect(parseCommand(commandDraftText(['helper', 'source B'], invalidDraft)).problem).toBeNull();
});

test('unpaired UTF-16 surrogates are rejected in raw text and saved argv', () => {
  for (const malformed of ['\uD800', '\uDC00', 'x\uD800y', '\uDC00\uD800']) {
    expect(parseCommand(`helper '${malformed}'`)).toMatchObject({ argv: null, problem: expect.any(String) });
    expect(commandProblem(['helper', malformed])).not.toBeNull();
    expect(validConfiguration(config(['helper', malformed]))).toBe(false);
  }
  expect(parseCommand("helper '🙂'")).toEqual({ argv: ['helper', '🙂'], problem: null });
  expect(commandProblem(['helper', '🙂'])).toBeNull();
});
