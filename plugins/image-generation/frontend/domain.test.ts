import { describe, expect, it } from 'vitest';
import { newProfile, removeProfile, setDefault, transportLabel, validation, type ImageConfiguration } from './domain';

const config = (): ImageConfiguration => ({ schemaVersion: 1, documentRevision: 3, defaultConnectionId: 'a', profiles: [newProfile('a', 'codex-cli'), { ...newProfile('b', 'openai-images'), defaultModel: 'm' } as ImageConfiguration['profiles'][number]] });

describe('setDefault', () => {
  it('makes an existing connection the default without touching the rest', () => {
    const before = config(); const after = setDefault(before, 'b');
    expect(after.defaultConnectionId).toBe('b');
    expect(after.profiles).toBe(before.profiles);
    expect(before.defaultConnectionId).toBe('a');
    expect(validation(after)).toBeNull();
  });
  it('ignores an id that is not a connection, so the default never dangles', () => {
    const before = config();
    expect(setDefault(before, 'missing')).toBe(before);
    expect(setDefault(before, '')).toBe(before);
  });
  it('restores a default after the default connection is removed', () => {
    const removed = removeProfile(config(), 'a');
    expect(removed.defaultConnectionId).toBeNull();
    expect(setDefault(removed, 'b').defaultConnectionId).toBe('b');
  });
});

describe('transportLabel', () => {
  it('names each connection kind for people, not by its transport id', () => {
    expect(transportLabel({ transport: 'codex-cli' })).toBe('Codex');
    expect(transportLabel({ transport: 'openai-images' })).toBe('Images API');
  });
});
