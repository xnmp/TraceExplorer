import { describe, expect, it } from 'vitest';
import { API_BACKENDS, credentialSections, effectiveZoom, testSummary, TRANSPORT_ID, canAddCodex, configuration, newProfile, removeProfile, setDefault, transportLabel, validConfiguration, validation, type ImageConfiguration, type ImageProfile } from './domain';

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
    const check = (transport: string, baseUrl: string, defaultModel = 'm') => { const c = withBackend(transport); return validation({ ...c, profiles: [{ ...c.profiles[0], baseUrl, defaultModel } as ImageProfile] }); };
    expect(check('openai-images', 'https://gateway.test/v1/images/edits')).toMatch(/\/edits/);
    expect(check('future-images', 'https://gateway.test/v1/images/edits')).toBeNull();
  });
  it('rejects the same base URLs as the native rules, matching every segment case-insensitively', () => {
    const check = (transport: string, baseUrl: string) => { const c = withBackend(transport); return validation({ ...c, profiles: [{ ...c.profiles[0], baseUrl, defaultModel: 'flux-2-pro' } as ImageProfile] }); };
    for (const ok of ['https://g.test/v1/images', 'https://g.test/v1/images/', 'https://g.test/models/v1/images']) expect(check('openai-images', ok), ok).toBeNull();
    for (const bad of ['https://g.test/v1/images/edits/', 'https://g.test/v1/images/GENERATIONS', 'https://g.test/v1/edits/images']) expect(check('openai-images', bad), bad).not.toBeNull();
    for (const ok of ['https://g.test/v1beta', 'https://g.test/v1beta/', 'https://g.test/modelsx/v1beta']) expect(check('gemini', ok), ok).toBeNull();
    for (const bad of ['https://g.test/v1beta/models', 'https://g.test/v1beta/Models/', 'https://g.test/v1beta/models/gemini-x:generateContent', 'https://g.test/models/v1beta', 'https://g.test/v1beta/interactions']) expect(check('gemini', bad), bad).not.toBeNull();
    for (const ok of ['https://api.bfl.ai/v1', 'https://api.bfl.ai/v1/', 'https://api.eu.bfl.ai']) expect(check('bfl', ok), ok).toBeNull();
    for (const bad of ['https://api.bfl.ai/v1/flux-2-pro', 'https://api.bfl.ai/V1/FLUX-2-PRO', 'https://api.bfl.ai/fluxproxy/v1', 'https://api.bfl.ai/v1/flux-3-image/']) expect(check('bfl', bad), bad).not.toBeNull();
    expect(check('gemini', 'https://g.test/v1beta/models')).toContain('/models');
    expect(check('gemini', 'https://g.test/v1beta/models')).toContain('Gemini API root URL');
  });
  it('requires a path-safe model ID only where the backend puts it in the URL', () => {
    const check = (transport: string, defaultModel: string) => { const c = withBackend(transport); return validation({ ...c, profiles: [{ ...c.profiles[0], baseUrl: 'https://api.bfl.ai/v1', defaultModel } as ImageProfile] }); };
    for (const bad of ['flux 2 pro', '.', '..', '-x', 'a/b', 'a'.repeat(129)]) expect(check('bfl', bad), bad).toMatch(/only letters, digits, "\.", "_" and "-"/);
    for (const ok of ['flux-2-pro', 'flux.2_pro', 'a'.repeat(128)]) expect(check('bfl', ok), ok).toBeNull();
    for (const transport of ['openai-images', 'gemini']) for (const ok of ['vendor/model', 'gpt image', '..']) expect(check(transport, ok), `${transport} ${ok}`).toBeNull();
  });
});


describe('credential sections', () => {
  it.each(['none', 'environment', 'command', 'secret', 'cli_saved_login'] as const)('shows only fields for %s', kind => {
    expect(credentialSections(kind)).toEqual({ environment: kind === 'environment', command: kind === 'command', secret: kind === 'secret' });
  });
  it('requires an owned reference before a saved-key source is configured', () => {
    const profile = newProfile('p', 'bfl');
    const value = (id: string): ImageConfiguration => ({ schemaVersion: 1, documentRevision: 0, defaultConnectionId: 'p', profiles: [{ ...profile, credential: { kind: 'secret', id } } as ImageProfile] });
    expect(validation(value(''))).toBe('Save a key for this connection');
    expect(validation(value('owned-secret'))).toBeNull();
  });
});
describe('zoomed viewport', () => {
  it.each([['1.1', 1.1], ['125%', 1.25], ['normal', 1], ['0', 1], ['invalid', 1]] as const)('handles %s', (text, expected) => expect(effectiveZoom([text])).toBe(expected));
  it('accounts for nested zoom and preserves the physical viewport margin', () => {
    const zoom = effectiveZoom(['1.25', '110%']);
    expect(zoom).toBeCloseTo(1.375);
    expect((800 / zoom - 32) * zoom).toBeCloseTo(800 - 32 * zoom);
  });
});
it('a rejected start stops showing waiting while an unresolved reply remains waiting', () => {
  expect(testSummary(undefined, true)).toBe('Test could not start.');
  expect(testSummary()).toBe('Waiting for the test acceptance reply…');
});
