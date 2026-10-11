import { describe, expect, test } from 'vitest';
import { ConnectionsController, TestRegistry, pending as testPending, type Backend } from './controller';
import { connectionFixture, fixtureStatus } from './harness/fixture';
import { configuration, newProfile, removeProfile, validation, testSummary, type ImageConfiguration, type ImageOperationStatus } from './domain';
const config = (revision = 1): ImageConfiguration => ({ schemaVersion: 1, documentRevision: revision, defaultConnectionId: 'p', profiles: [{ ...newProfile('p', 'openai-images'), transport: 'openai-images', baseUrl: 'https://example.com/v1/images', defaultModel: 'arbitrary-image-model', allowInsecureHttp: false, credential: { kind: 'none' } }] });
const status = (state: 'accepted' | 'running' | 'cancelled' | 'succeeded' = 'accepted', revision = 1): ImageOperationStatus => ({ version: 1, operationId: 'test-id', requestFingerprint: 'b'.repeat(64), provider: { packageId: 'xnmp.image-generation', serviceId: 'image-generation', major: 1 }, revision, execution: state === 'succeeded' ? { state, metadata: { adapter: 'openai-images', endpointIdentity: '', requestedModel: 'arbitrary-image-model', actualModel: null, externalRequestId: null, threadId: null, options: { size: '1024x1024', quality: 'low', background: 'auto' }, remoteChargeUncertain: false } } : { state }, delivery: state === 'succeeded' ? { state: 'available', output: { handle: 'h', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png' } } : { state: 'none' } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(handler: (method: string, params: Record<string, unknown>) => unknown = () => config()) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const backend: Backend = { async invoke<T>(method: string, params = {}) { calls.push({ method, params }); if (method === 'settings.test.list') return [] as T; return await handler(method, params) as T; } };
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
  test('closing uncertain acceptance cancels again after a late accepted reply and resolves it', async () => {
    const started = deferred<ImageOperationStatus>(); let cancellations = 0;
    const f = fixture(method => { if (method === 'settings.test') return started.promise; if (method === 'settings.cancelTest') { if (++cancellations === 1) throw Error('not accepted yet'); return status('cancelled', 3); } if (method === 'settings.test.discard') return status('cancelled', 3); return config(); });
    await f.controller.initialize(); const work = f.controller.test('p'); f.controller.close(); await settle(); started.resolve(status()); await work; await settle();
    expect(cancellations).toBe(2); expect(f.registry.all()[0].status?.execution.state).toBe('cancelled'); expect(f.calls.some(c => c.method === 'settings.test.discard')).toBe(false); expect(f.pending.size).toBe(0);
  });
  test('success is automatically discarded but its outcome remains in the open dialog', async () => {
    const f = fixture(method => method === 'settings.test' ? status('succeeded', 3) : method === 'settings.test.discard' ? { ...status('succeeded', 4), delivery: { state: 'discarded' } } : config()); await f.controller.initialize(); await f.controller.test('p');
    expect(f.controller.snapshot().tests[0]).toMatchObject({ status: { execution: { state: 'succeeded' }, delivery: { state: 'discarded' } } });
    expect(f.calls.filter(c => c.method === 'settings.test.discard')).toHaveLength(1); f.controller.close();
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
    expect(f.registry.all()[0].status?.delivery.state).toBe('discarded'); expect(f.controller.snapshot().tests[0].status?.delivery.state).toBe('discarded'); expect(f.pending.size).toBe(0); f.controller.close();
  });
  test('resolved historical tests do not consume active test quota', async () => {
    const f = fixture(method => method === 'settings.test' ? status() : config());
    for (let i = 0; i < 16; i++) f.registry.set({ requestId: `old-${i}`, profileId: 'p', profileName: 'old', configurationRevision: 1, status: { ...status('cancelled'), operationId: `old-${i}` } });
    await f.controller.initialize(); await f.controller.test('p'); expect(f.calls.filter(c => c.method === 'settings.test')).toHaveLength(1); f.controller.close();
  });
});


describe('start rejection recovery with the browser host fixture', () => {
  function harness() {
    const host = connectionFixture(config());
    const timers = new Map<() => void, number>();
    const registry = new TestRegistry();
    let id = 0;
    const controller = new ConnectionsController(host.backend, registry, (fn, delay) => { timers.set(fn, delay); return () => { timers.delete(fn); }; }, () => `test-${++id}`);
    const visible = () => { const result = controller.snapshot().tests.at(-1); return { spinning: !!result && testPending(result), text: result ? testSummary(result.status, result.startFailed || result.neverStarted, result.error, result.elapsedMs) : '' }; };
    return { host, timers, registry, controller, visible };
  }
  test.each(['configuration_changed', 'invalid_request', 'test_already_running', 'test_not_started'])('a definite %s rejection permits a fresh user test', async code => {
    const f = harness(); f.host.rejectStart({ code: -32000, data: { code, message: 'Test could not start.' } });
    await f.controller.initialize(); await f.controller.test('p');
    expect(f.visible()).toEqual({ spinning: false, text: '✗ Test could not start.' });
    await f.controller.test('p'); expect(f.host.calls().filter(c => c.method === 'settings.test')).toHaveLength(2); expect(f.timers.size).toBe(0); f.controller.close();
  });
  test.each([new Error('Start reply lost'), { code: -32000, message: 'Timeout' }, { code: 'host_unavailable', message: 'Transport unavailable' }])('lost acceptance plus a failed immediate read stays running and cancellable', async cause => {
    const f = harness(); f.host.outcome('running');
    f.host.startReply(async () => { throw cause; }); f.host.failNextStatus(new Error('Read temporarily unavailable'));
    await f.controller.initialize(); await f.controller.test('p');
    expect(f.visible()).toEqual({ spinning: true, text: '' }); expect(f.timers.size).toBe(1);
    await f.controller.test('p'); expect(f.host.calls().filter(c => c.method === 'settings.test')).toHaveLength(1);
    f.controller.close(); await settle();
    expect(f.host.calls().filter(c => c.method === 'settings.cancelTest')).toHaveLength(1);
    expect(f.registry.all()[0].status?.execution.state).toBe('cancelled');
  });
  test('an uncertain reply recovers the original operation by polling without replay', async () => {
    const f = harness(); f.host.startReply(async () => { throw new Error('Lost reply'); }); f.host.failNextStatus(new Error('Transient read'));
    await f.controller.initialize(); await f.controller.test('p');
    [...f.timers.keys()].forEach(run => { f.timers.delete(run); run(); }); await settle(); await settle();
    expect(f.visible().spinning).toBe(false); expect(f.visible().text).toMatch(/^✓ Generated a test image/);
    expect(f.host.calls().filter(c => c.method === 'settings.test')).toHaveLength(1); f.controller.close();
  });
  test('a lost host update after durable output discard is retried', async () => {
    const f = harness(); f.host.failNextCleanup(new Error('Host update unavailable'));
    await f.controller.initialize(); await f.controller.test('p');
    [...f.timers.keys()].forEach(run => { f.timers.delete(run); run(); }); await settle(); await settle();
    expect(f.visible().text).toMatch(/^✓ Generated a test image/);
    expect(f.controller.snapshot().tests[0].status?.delivery.state).toBe('available');
    const durable = await f.host.backend.invoke<ImageOperationStatus>('settings.test.status', { requestId: 'test-1' });
    expect(durable.delivery.state).toBe('discarded');
    expect(f.timers.size).toBe(1);
    [...f.timers.keys()].forEach(run => { f.timers.delete(run); run(); }); await settle(); await settle();
    expect(f.host.calls().filter(c => c.method === 'settings.test.discard')).toHaveLength(2);
    expect(f.timers.size).toBe(0); expect(await f.host.backend.invoke('settings.test.list')).toEqual([]); f.controller.close();
  });
  test('retained success with unavailable output is shown and discarded without replay', async () => {
    const f = harness(); f.host.retain('p', { ...fixtureStatus('retained', 'succeeded', 2), delivery: { state: 'unavailable', reason: 'storage_unavailable' } });
    await f.controller.initialize();
    expect(f.visible()).toEqual({ spinning: false, text: '✓ Generated a test image' });
    expect(f.controller.snapshot().tests[0].status?.delivery.state).toBe('discarded');
    expect(f.host.calls().some(c => c.method === 'settings.test')).toBe(false);
    expect(await f.host.backend.invoke('settings.test.list')).toEqual([]); f.controller.close();
  });
  test('closing after durable output discard continues a failed host update', async () => {
    const f = harness();
    f.host.retain('p', fixtureStatus('test-1', 'succeeded', 2));
    f.host.failNextCleanup(new Error('Host update unavailable'));
    // Use a retained success to exercise cleanup without a second generation.
    await f.controller.initialize(); expect(f.timers.size).toBe(1);
    f.controller.close(); await settle(); await settle();
    expect(f.registry.all()[0].status?.delivery.state).toBe('discarded');
    expect(f.host.calls().filter(c => c.method === 'settings.test.discard')).toHaveLength(2);
    expect(f.timers.size).toBe(0);
  });
  test('transient discovery failure retries while keeping the test gated', async () => {
    const f = harness(); let reads = 0;
    f.host.discovery(async () => { if (++reads === 1) throw new Error('Discovery temporarily unavailable'); });
    await f.controller.initialize(); await f.controller.test('p');
    expect(f.controller.snapshot().recoveringTests).toBe(true); expect(f.host.calls().some(c => c.method === 'settings.test')).toBe(false);
    [...f.timers.keys()].forEach(run => { f.timers.delete(run); run(); }); await settle(); await settle();
    expect(f.controller.snapshot().recoveringTests).toBe(false); await f.controller.test('p'); expect(f.visible().spinning).toBe(true); f.controller.close();
  });
  test('cancel without a receipt after an uncertain reply keeps inspecting even after close', async () => {
    const f = harness(); const backend: Backend = { invoke: (method, params) => method === 'settings.test' ? Promise.reject(new Error('Transport lost before reply')) : f.host.backend.invoke(method, params) };
    const timers = new Map<() => void, number>();
    const controller = new ConnectionsController(backend, f.registry, fn => { timers.set(fn, 750); return () => { timers.delete(fn); }; }, () => 'uncertain');
    await controller.initialize(); await controller.test('p'); await controller.cancel('uncertain');
    expect(testPending(controller.snapshot().tests[0])).toBe(true); expect(timers.size).toBe(1);
    controller.close(); await settle();
    f.host.retain('p', fixtureStatus('uncertain')); f.host.outcome('running');
    [...timers.keys()].forEach(run => { timers.delete(run); run(); }); await settle(); await settle();
    expect(f.registry.all()[0].status?.execution.state).toBe('cancelled'); expect(timers.size).toBe(0); f.controller.close();
  });
  test('discovery gates generation until a retained active test is known', async () => {
    const f = harness(); const discovery = deferred<void>(); f.host.discovery(() => discovery.promise); f.host.outcome('running');
    f.host.retain('p', fixtureStatus('retained', 'accepted'));
    const work = f.controller.initialize(); await settle(); await f.controller.test('p');
    expect(f.controller.snapshot().recoveringTests).toBe(true); expect(f.host.calls().some(c => c.method === 'settings.test')).toBe(false);
    discovery.resolve(); await work;
    expect(f.visible()).toEqual({ spinning: true, text: '' }); await f.controller.test('p');
    expect(f.host.calls().some(c => c.method === 'settings.test')).toBe(false); f.controller.close();
  });
  test('retained Unknown is inline once, never needs cleanup, and permits a new operation', async () => {
    const f = harness(); f.host.staleUnknown(); await f.controller.initialize();
    expect(f.visible()).toEqual({ spinning: false, text: '? Outcome unknown: The app closed during the test' });
    expect(f.host.calls().some(c => c.method === 'settings.test.discard')).toBe(false); expect(f.timers.size).toBe(0);
    expect(await f.host.backend.invoke('settings.test.list')).toEqual([]);
    await f.controller.test('p'); expect(f.visible().spinning).toBe(true); expect(f.host.calls().filter(c => c.method === 'settings.test')).toHaveLength(1); f.controller.close();
  });
  test('a never-admitted credential failure keeps its connection after restart', async () => {
    const f = harness(); f.host.failCredential(); await f.controller.initialize(); await f.controller.test('p');
    expect(f.visible()).toEqual({ spinning: false, text: '✗ Credential command exited with status 1' }); f.controller.close();
    const restarted = new ConnectionsController(f.host.backend, new TestRegistry(), () => () => {});
    await restarted.initialize(); expect(restarted.snapshot().tests[0].profileId).toBe('p');
    expect(testSummary(restarted.snapshot().tests[0].status)).toBe('✗ Credential command exited with status 1');
    expect(f.host.calls().some(c => c.method === 'settings.test.discard')).toBe(false); restarted.close();
  });
  test('cancel no-receipt evidence survives a definite delayed start rejection', async () => {
    const f = harness(); const reply = deferred<ImageOperationStatus>();
    // Admission has not happened while the original request is waiting.
    const backend: Backend = { invoke: (method, params) => method === 'settings.test' ? reply.promise as never : f.host.backend.invoke(method, params) };
    const controller = new ConnectionsController(backend, f.registry, () => () => {}, () => 'delayed');
    await controller.initialize(); const work = controller.test('p'); await controller.cancel('delayed');
    expect(testPending(controller.snapshot().tests[0])).toBe(true);
    reply.reject({ code: 'configuration_changed', message: 'Settings changed' }); await work;
    const result = controller.snapshot().tests[0];
    expect(testPending(result)).toBe(false); expect(testSummary(result.status, result.startFailed || result.neverStarted, result.error)).toBe('✗ The test never started'); controller.close(); f.controller.close();
  });
});

test('cancel before admission is reissued when the late start reply arrives', async () => {
  const started = deferred<ImageOperationStatus>(); let cancellations = 0;
  const f = fixture(method => {
    if (method === 'settings.test') return started.promise;
    if (method === 'settings.cancelTest') {
      if (++cancellations === 1) throw { code: 'test_not_started', message: 'The test never started' };
      return status('cancelled', 3);
    }
    if (method === 'settings.test.discard') return status('cancelled', 3);
    return config();
  });
  await f.controller.initialize(); const work = f.controller.test('p');
  await f.controller.cancel('test-id'); await f.controller.test('p');
  expect(f.calls.filter(call => call.method === 'settings.test')).toHaveLength(1);
  started.resolve(status()); await work;
  expect(cancellations).toBe(2);
  expect(f.controller.snapshot().tests[0]).toMatchObject({ status: { execution: { state: 'cancelled' } } });
  f.controller.close();
});
test('a late successful acceptance after close releases its output automatically', async () => {
  const started = deferred<ImageOperationStatus>();
  const f = fixture(method => {
    if (method === 'settings.test') return started.promise;
    if (method === 'settings.cancelTest') throw { code: 'test_not_started', message: 'The test never started' };
    if (method === 'settings.test.discard') return { ...status('succeeded', 4), delivery: { state: 'discarded' } };
    return config();
  });
  await f.controller.initialize(); const work = f.controller.test('p'); f.controller.close();
  started.resolve(status('succeeded', 3)); await work;
  expect(f.registry.all()[0]).toMatchObject({ status: { delivery: { state: 'discarded' } } });
});

test('cleanup retries automatically after a transient failure', async () => {
  let discards = 0;
  const f = fixture(method => {
    if (method === 'settings.test' || method === 'settings.test.status') return status('succeeded', 3);
    if (method === 'settings.test.discard') {
      if (++discards === 1) throw Error('Host temporarily unavailable');
      return { ...status('succeeded', 4), delivery: { state: 'discarded' } };
    }
    return config();
  });
  await f.controller.initialize(); await f.controller.test('p');
  expect(f.controller.snapshot().tests[0].status?.delivery.state).toBe('available');
  const scheduled = [...f.pending.keys()]; scheduled.forEach(run => run()); await settle();
  expect(f.controller.snapshot().tests[0]).toMatchObject({ status: { delivery: { state: 'discarded' } } });
  expect(discards).toBe(2); f.controller.close();
});
test('many tests on another connection preserve each connection’s last result', () => {
  const registry = new TestRegistry();
  registry.set({ requestId: 'first', profileId: 'a', profileName: 'A', configurationRevision: 1, status: { ...status('cancelled'), operationId: 'first' } });
  for (let i = 0; i < 100; i++) registry.set({ requestId: `b-${i}`, profileId: 'b', profileName: 'B', configurationRevision: 1, status: { ...status('cancelled'), operationId: `b-${i}` } });
  expect(registry.all().find(test => test.profileId === 'a')?.status?.execution.state).toBe('cancelled');
  expect(registry.all().filter(test => test.profileId === 'b').at(-1)?.requestId).toBe('b-99');
});

test('retaining the last result never drops an older success still awaiting output cleanup', () => {
  const registry = new TestRegistry();
  registry.set({ requestId: 'paid', profileId: 'p', profileName: 'P', configurationRevision: 1, status: fixtureStatus('paid', 'succeeded') });
  for (let i = 0; i < 100; i++) registry.set({ requestId: `past-${i}`, profileId: 'p', profileName: 'P', configurationRevision: 1, status: fixtureStatus(`past-${i}`, 'cancelled') });
  expect(registry.all().find(result => result.requestId === 'paid')?.status?.delivery.state).toBe('available');
  expect(registry.all().at(-1)?.requestId).toBe('past-99');
});
