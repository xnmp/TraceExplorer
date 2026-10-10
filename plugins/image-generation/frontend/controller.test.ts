import { describe, expect, test } from 'vitest';
import { ConnectionsController, TestRegistry, type Backend } from './controller';
import { configuration, newProfile, removeProfile, validation, type ImageConfiguration, type ImageOperationStatus } from './domain';
const config = (revision = 1): ImageConfiguration => ({ schemaVersion: 1, documentRevision: revision, defaultConnectionId: 'p', profiles: [{ ...newProfile('p', 'openai-images'), transport: 'openai-images', baseUrl: 'https://example.com/v1/images', defaultModel: 'arbitrary-image-model', allowInsecureHttp: false, credential: { kind: 'none' } }] });
const status = (state: 'accepted' | 'running' | 'cancelled' | 'succeeded' = 'accepted', revision = 1): ImageOperationStatus => ({ version: 1, operationId: 'test-id', requestFingerprint: 'b'.repeat(64), provider: { packageId: 'xnmp.image-generation', serviceId: 'image-generation', major: 1 }, revision, execution: state === 'succeeded' ? { state, metadata: { adapter: 'openai-images', endpointIdentity: '', requestedModel: 'arbitrary-image-model', actualModel: null, externalRequestId: null, threadId: null, options: { size: '1024x1024', quality: 'low', background: 'auto' }, remoteChargeUncertain: false } } : { state }, delivery: state === 'succeeded' ? { state: 'available', output: { handle: 'h', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png' } } : { state: 'none' } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler: (method: string, params: Record<string, unknown>) => unknown = () => config()) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const backend: Backend = { async invoke<T>(method: string, params = {}) { calls.push({ method, params }); return await handler(method, params) as T; } };
  const registry = new TestRegistry();
  const pending = new Map<() => void, number>();
  const controller = new ConnectionsController(backend, registry, (fn, delay) => { pending.set(fn, delay); return () => { pending.delete(fn); }; }, () => 'test-id');
  return { controller, registry, calls, pending, backend };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
describe('image connections contract', () => {
  test('empty configuration stays unconfigured; deleting the default never selects another', () => {
    const value = { ...config(), profiles: [...config().profiles, newProfile('other', 'codex-cli')] };
    expect(removeProfile(value, 'p').defaultConnectionId).toBeNull();
    expect(validation({ schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: [] })).toBeNull();
  });
  test('URL, arbitrary model, environment and executable validation follow native policy', () => {
    expect(validation(config())).toBeNull();
    const p = config().profiles[0]; if (p.transport !== 'openai-images') throw Error();
    for (const baseUrl of ['https://user:secret@example.com/images', 'https://example.com/images?key=secret', 'https://example.com/images/edits', 'file:///images']) expect(validation({ ...config(), profiles: [{ ...p, baseUrl }] })).not.toBeNull();
    expect(validation({ ...config(), profiles: [{ ...p, baseUrl: 'http://localhost:8080/images' }] })).toBeNull();
    expect(validation({ ...config(), profiles: [{ ...p, credential: { kind: 'environment', name: '0BAD' } }] })).not.toBeNull();
    expect(validation({ ...config(), profiles: [{ ...newProfile('p', 'codex-cli'), transport: 'codex-cli', executablePath: 'relative/codex', modelSelection: false, credential: { kind: 'cli_saved_login' } }] })).not.toBeNull();
  });
  test('save payload strips frontend-only metadata', () => { const p = config().profiles[0]; expect(JSON.stringify(configuration({ ...config(), profiles: [{ ...p, hasCredential: true, capabilities: {} } as unknown as typeof p] }))).not.toMatch(/hasCredential|capabilities/); });
  test('cross-window revision preserves dirty edits, blocks stale save and explicit reload adopts latest', async () => {
    let current = config(); const f = fixture(() => current); await f.controller.initialize();
    f.controller.edit({ ...config(), profiles: config().profiles.map(p => ({ ...p, name: 'My unsaved name' })) }); current = config(2);
    f.controller.revision({ documentRevision: 2, affectedProfileIds: ['p'] }); await settle();
    expect(f.controller.snapshot().draft?.profiles[0].name).toBe('My unsaved name'); expect(f.controller.snapshot().conflict).toBe(true);
    await f.controller.save(); expect(f.calls.some(c => c.method === 'settings.save')).toBe(false);
    await f.controller.refresh(true); expect(f.controller.snapshot().draft?.documentRevision).toBe(2); expect(f.controller.dirty).toBe(false); f.controller.close();
  });
  test('event newer than delayed save reply reconciles committed state', async () => {
    const saved = deferred<ImageConfiguration>(); let current = config(); const f = fixture(method => method === 'settings.save' ? saved.promise : current); await f.controller.initialize();
    f.controller.edit({ ...config(), defaultConnectionId: null }); const work = f.controller.save();
    current = config(3); f.controller.revision({ documentRevision: 3, affectedProfileIds: ['p'] }); saved.resolve(config(2)); await work;
    expect(f.controller.snapshot().saved?.documentRevision).toBe(3); expect(f.controller.dirty).toBe(false); f.controller.close();
  });
  test('CAS rejection retains the draft and reports conflict', async () => {
    let current = config(); const f = fixture(method => { if (method === 'settings.save') { current = config(2); throw Error('Image connections changed; reload before saving'); } return current; }); await f.controller.initialize();
    f.controller.edit({ ...config(), defaultConnectionId: null }); await f.controller.save();
    expect(f.controller.snapshot().draft?.defaultConnectionId).toBeNull(); expect(f.controller.snapshot().conflict).toBe(true); expect(f.controller.snapshot().error).toContain('reload'); f.controller.close();
  });
  test('late local check never validates an edited connection', async () => {
    const checked = deferred<{ available: boolean }>(); const f = fixture(method => method === 'settings.check' ? checked.promise : config()); await f.controller.initialize();
    const work = f.controller.check('p'); f.controller.edit({ ...config(), defaultConnectionId: null }); checked.resolve({ available: true }); await work;
    expect(f.controller.snapshot().check).toBeNull(); f.controller.close();
  });
  test('check is local; generation uses saved revision and one explicit request ID', async () => {
    const f = fixture(method => method === 'settings.check' ? { available: true } : method === 'settings.test' ? status() : config()); await f.controller.initialize();
    await f.controller.check('p'); expect(f.controller.snapshot().check?.message).toContain('has not been tested'); await f.controller.test('p'); await f.controller.test('p');
    expect(f.calls.filter(c => c.method === 'settings.test')).toEqual([{ method: 'settings.test', params: { profileId: 'p', requestId: 'test-id', expectedConfigurationRevision: 1 } }]); f.controller.close();
  });
  test('write-only key reaches only the credential RPC and never enters configuration state', async () => {
    const f = fixture(method => config(method === 'settings.credential.set' ? 2 : 1)); await f.controller.initialize(); await f.controller.credential('p', 'private-api-key');
    expect(f.calls.find(c => c.method === 'settings.credential.set')?.params).toMatchObject({ expectedRevision: 1, profileId: 'p', key: 'private-api-key' }); expect(JSON.stringify(f.controller.snapshot())).not.toContain('private-api-key'); f.controller.close();
  });
  test('closing uncertain acceptance cancels again after a late accepted reply, never discards', async () => {
    const started = deferred<ImageOperationStatus>(); let cancellations = 0;
    const f = fixture(method => { if (method === 'settings.test') return started.promise; if (method === 'settings.cancelTest') { if (++cancellations === 1) throw Error('not accepted yet'); return status('cancelled', 3); } return config(); });
    await f.controller.initialize(); const work = f.controller.test('p'); f.controller.close(); await settle(); started.resolve(status()); await work; await settle();
    expect(cancellations).toBe(2); expect(f.registry.all()[0].status?.execution.state).toBe('cancelled'); expect(f.calls.some(c => c.method === 'settings.test.discard')).toBe(false); expect(f.pending.size).toBe(0);
  });
  test('success survives close and remains available to a new dialog until explicit discard', async () => {
    const f = fixture(method => method === 'settings.test' ? status('succeeded', 3) : method === 'settings.test.discard' ? { ...status('succeeded', 4), delivery: { state: 'discarded' } } : config()); await f.controller.initialize(); await f.controller.test('p'); f.controller.close();
    expect(f.registry.all()[0].status?.delivery.state).toBe('available'); expect(f.calls.some(c => c.method === 'settings.cancelTest' || c.method === 'settings.test.discard')).toBe(false);
    const second = new ConnectionsController(f.backend, f.registry); await second.initialize(); expect(second.snapshot().tests.length).toBe(1); await second.discard('test-id'); expect(f.registry.all()).toEqual([]); second.close();
  });
  test('configuration changes leave historical test evidence explicitly tied to old revision', async () => {
    let current = config(); const f = fixture(method => method === 'settings.test' ? status('succeeded', 3) : current); await f.controller.initialize(); await f.controller.test('p'); current = config(2); f.controller.revision({ documentRevision: 2, affectedProfileIds: ['p'] }); await settle();
    expect(f.controller.snapshot().saved?.documentRevision).toBe(2); expect(f.controller.snapshot().tests[0].configurationRevision).toBe(1); f.controller.close();
  });
  test('late poll and poll errors never erase a newer confirmed terminal receipt', async () => {
    const read = deferred<ImageOperationStatus>(); const f = fixture(method => method === 'settings.test' ? status() : method === 'settings.test.status' ? read.promise : method === 'settings.cancelTest' ? status('cancelled', 4) : config()); await f.controller.initialize(); await f.controller.test('p'); const work = f.controller.poll('test-id'); await f.controller.cancel('test-id'); read.reject(Error('read unavailable')); await work;
    expect(f.registry.all()[0].status?.execution.state).toBe('cancelled'); expect(f.registry.all()[0].status?.revision).toBe(4); f.controller.close();
  });
  test('wrong operation receipt retains original identity for recovery without new generation', async () => {
    const f = fixture(method => method === 'settings.test' ? { ...status(), operationId: 'someone-else' } : config()); await f.controller.initialize(); await f.controller.test('p');
    expect(f.registry.all()[0].requestId).toBe('test-id'); expect(f.registry.all()[0].status).toBeUndefined(); expect(f.registry.all()[0].error).toContain('invalid test receipt'); f.controller.close();
  });
  test('malformed terminal receipt never becomes a successful or retained-output claim', async () => {
    const f = fixture(method => method === 'settings.test' ? { ...status('succeeded'), execution: { state: 'succeeded' } } : config()); await f.controller.initialize(); await f.controller.test('p');
    expect(f.registry.all()[0].status).toBeUndefined(); expect(f.registry.all()[0].error).toContain('invalid test receipt'); f.controller.close();
  });
  test('malformed settings reply cannot replace an existing dirty draft', async () => {
    let current: unknown = config(); const f = fixture(() => current); await f.controller.initialize(); f.controller.edit({ ...config(), defaultConnectionId: null });
    current = { ...config(2), profiles: [{ id: 'p', transport: 'unknown' }] }; await f.controller.refresh();
    expect(f.controller.snapshot().draft?.defaultConnectionId).toBeNull(); expect(f.controller.snapshot().saved?.documentRevision).toBe(1); expect(f.controller.snapshot().error).toContain('invalid connection settings'); f.controller.close();
  });
  test('late read cannot resurrect output after confirmed explicit discard', async () => {
    const read = deferred<ImageOperationStatus>(); const f = fixture(method => method === 'settings.test' ? status('succeeded', 3) : method === 'settings.test.status' ? read.promise : method === 'settings.test.discard' ? { ...status('succeeded', 4), delivery: { state: 'discarded' } } : config());
    await f.controller.initialize(); await f.controller.test('p'); const work = f.controller.poll('test-id'); await f.controller.discard('test-id'); read.resolve(status('succeeded', 3)); await work;
    expect(f.registry.all()).toEqual([]); expect(f.controller.snapshot().tests).toEqual([]); expect(f.pending.size).toBe(0); f.controller.close();
  });
  test('resolved historical tests do not consume active test quota', async () => {
    const f = fixture(method => method === 'settings.test' ? status() : config());
    for (let i = 0; i < 16; i++) f.registry.set({ requestId: `old-${i}`, profileId: 'p', profileName: 'old', configurationRevision: 1, status: { ...status('cancelled'), operationId: `old-${i}` } });
    await f.controller.initialize(); await f.controller.test('p'); expect(f.calls.filter(c => c.method === 'settings.test')).toHaveLength(1); f.controller.close();
  });
});
