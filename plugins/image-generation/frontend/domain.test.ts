import { describe, expect, it } from 'vitest';
import { API_BACKENDS, TRANSPORT_ID, canAddCodex, configuration, newProfile, removeProfile, setDefault, transportLabel, validConfiguration, validation, type ImageConfiguration, type ImageProfile } from './domain';

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

describe('canAddCodex', () => {
  const config = (...transports: ('codex-cli' | 'openai-images')[]): ImageConfiguration =>
    ({ schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: transports.map((t, i) => newProfile(`p${i}`, t)) });
  it('offers Codex until a Codex connection exists', () => {
    expect(canAddCodex(config())).toBe(true);
    expect(canAddCodex(config('openai-images', 'openai-images'))).toBe(true);
    expect(canAddCodex(config('codex-cli'))).toBe(false);
    expect(canAddCodex(config('openai-images', 'codex-cli'))).toBe(false);
  });
  it('offers it again once the Codex connection is removed', () => {
    const withCodex = config('openai-images', 'codex-cli');
    expect(canAddCodex(removeProfile(withCodex, 'p1'))).toBe(true);
  });
});


describe('API backend registry', () => {
  const withBackend = (transport: string): ImageConfiguration => {
    const profile = { ...newProfile('x', 'openai-images'), transport, defaultModel: 'm', baseUrl: 'https://gateway.test/v1' } as ImageConfiguration['profiles'][number];
    return { schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: [profile] };
  };
  it('lists well-formed, unique transports that do not collide with Codex', () => {
    expect(API_BACKENDS.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const b of API_BACKENDS) {
      expect(b.transport).toMatch(TRANSPORT_ID);
      expect(b.transport).not.toBe('codex-cli');
      expect(seen.has(b.transport)).toBe(false); seen.add(b.transport);
      for (const text of [b.label, b.addLabel, b.defaultName, b.baseUrlLabel, b.credentialEnv]) expect(text.trim()).not.toBe('');
      expect(b.credentialEnv).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
  it('creates every registered backend as a connection that validates once a model is chosen', () => {
    for (const b of API_BACKENDS) {
      const created = newProfile('p', b.transport);
      expect(created).toMatchObject({ transport: b.transport, name: b.defaultName, baseUrl: b.defaultBaseUrl, credential: { kind: 'none' } });
      expect(validation({ schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: [{ ...created, defaultModel: 'm' } as ImageProfile] })).toBeNull();
    }
  });
  it('accepts, validates and round-trips a backend this build has no registry entry for', () => {
    const value = withBackend('future-images');
    expect(validConfiguration(value)).toBe(true);
    expect(configuration(value).profiles[0]).toMatchObject({ transport: 'future-images', baseUrl: 'https://gateway.test/v1', defaultModel: 'm' });
    expect(transportLabel({ transport: 'future-images' })).toBe('future-images');
    expect(canAddCodex(value)).toBe(true);
  });
  it('rejects malformed transports and incomplete API shapes', () => {
    expect(validConfiguration(withBackend('Bad_Name'))).toBe(false);
    expect(validConfiguration(withBackend(''))).toBe(false);
    expect(validConfiguration(withBackend('a'.repeat(65)))).toBe(false);
    const broken = withBackend('future-images');
    expect(validConfiguration({ ...broken, profiles: [{ id: 'x', name: 'n', recipeRevision: 'r', transport: 'future-images', credential: { kind: 'none' } } as unknown as ImageProfile] })).toBe(false);
  });
  it("applies a backend's own URL rule only to that backend", () => {
    const rooted = (transport: string) => { const c = withBackend(transport); return validation({ ...c, profiles: [{ ...c.profiles[0], baseUrl: 'https://gateway.test/v1/images/edits' } as ImageProfile] }); };
    expect(rooted('openai-images')).toMatch(/without \/generations or \/edits/);
    expect(rooted('future-images')).toBeNull();
  });
});
