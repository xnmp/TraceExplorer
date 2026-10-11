import type { ImageConfiguration, ImageOperationStatus, ImageProfile } from '../../../../integration/services/image-generation-v1';
import { isApi } from '../domain';
import type { Backend } from '../controller';

export const fixtureStatus = (operationId: string, state: 'accepted' | 'succeeded' | 'unknown' | 'failed' | 'cancelled' = 'accepted', revision = 1): ImageOperationStatus => ({
  version: 1, operationId, requestFingerprint: 'b'.repeat(64),
  provider: { packageId: 'xnmp.image-generation', serviceId: 'image-generation', major: 1 }, revision,
  execution: state === 'succeeded' ? { state, metadata: { adapter: 'openai-images', endpointIdentity: 'https://example.test/images', requestedModel: 'custom-image', actualModel: null, externalRequestId: null, threadId: null, options: { size: '1024x1024', quality: 'low', background: 'auto' }, remoteChargeUncertain: false } }
    : state === 'unknown' || state === 'failed' ? { state, error: { code: state === 'unknown' ? 'remote_outcome_unknown' : 'unavailable', message: state === 'unknown' ? 'The app closed during the test' : 'Credential command exited with status 1' } } : { state },
  delivery: state === 'succeeded' ? { state: 'available', output: { handle: 'opaque-fixture-handle', sha256: 'a'.repeat(64), byteLength: 100, mediaType: 'image/png' } } : { state: 'none' },
});

/** Same durable receipts, local presentation markers and admission rules as settings.*.
 * No host resolution acknowledgement or replay is invented by this fixture. */
export function connectionFixture(initial: ImageConfiguration = { schemaVersion: 1, documentRevision: 0, defaultConnectionId: null, profiles: [] }, emit: (value: ImageConfiguration) => void = () => {}) {
  let current = structuredClone(initial);
  const results = new Map<string, { profileId: string; status: ImageOperationStatus }>();
  const shown = new Set<string>();
  const cancelledBeforeAdmission = new Set<string>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let outcome: 'succeeded' | 'unknown' | 'running' = 'succeeded';
  let startFailure: unknown = null;
  let credentialFailure = false;
  let nextStatusFailure: unknown = null;
  let startReply: ((status: ImageOperationStatus) => Promise<ImageOperationStatus>) | null = null;
  let nextCleanupFailure: unknown = null;
  let discovery: (() => Promise<void>) | null = null;
  const executionIdentity = (p: ImageProfile) => JSON.stringify(isApi(p) ? [p.transport, p.baseUrl, p.defaultModel, p.allowInsecureHttp, p.credential] : [p.transport, p.executablePath, p.credential]);
  const commit = (value: ImageConfiguration, forceRotation?: string) => {
    current = { ...value, profiles: value.profiles.map(p => {
      const previous = current.profiles.find(old => old.id === p.id);
      const recipeRevision = previous && p.id !== forceRotation && executionIdentity(previous) === executionIdentity(p) ? previous.recipeRevision : `fixture-${value.documentRevision}-${p.id}`;
      return { ...p, recipeRevision };
    }) };
    emit(current); return structuredClone(current);
  };
  const backend: Backend = { async invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    calls.push({ method, params });
    const invoke = async (): Promise<unknown> => {
      if (method === 'settings.read') return structuredClone(current);
      if (method === 'settings.save') {
        if (params.expectedRevision !== current.documentRevision) throw { code: 'configuration_changed', message: 'Image connections changed; reload before saving' };
        return commit({ ...structuredClone(params.configuration as ImageConfiguration), documentRevision: current.documentRevision + 1 });
      }
      if (method === 'settings.credential.set' || method === 'settings.credential.clear') {
        if (params.expectedRevision !== current.documentRevision) throw { code: 'configuration_changed', message: 'Settings changed' };
        return commit({ ...current, documentRevision: current.documentRevision + 1, profiles: current.profiles.map(p => p.id === params.profileId && isApi(p) ? { ...p, credential: method.endsWith('.clear') ? { kind: 'none' } : { kind: 'secret', id: 'owned-secret-reference' } } : p) }, String(params.profileId));
      }
      if (method === 'settings.test.list') {
        await discovery?.();
        const retained = [...results].filter(([id]) => !shown.has(id));
        for (const [id, { status }] of retained) if (!['accepted', 'running', 'succeeded'].includes(status.execution.state)) shown.add(id);
        return retained.map(([, entry]) => structuredClone(entry));
      }
      if (method === 'settings.check') return { available: true };
      const requestId = String(params.requestId);
      if (method === 'settings.test') {
        const previous = results.get(requestId); if (previous) return structuredClone(previous.status);
        if (startFailure) throw startFailure;
        if ([...results.values()].some(({ profileId, status }) => profileId === params.profileId && ['accepted', 'running'].includes(status.execution.state))) throw { code: 'test_already_running', message: 'A test is already running for this connection' };
        if (params.expectedConfigurationRevision !== current.documentRevision) throw { code: 'configuration_changed', message: 'Settings changed' };
        const status = fixtureStatus(requestId, cancelledBeforeAdmission.has(requestId) ? 'cancelled' : credentialFailure ? 'failed' : 'accepted');
        results.set(requestId, { profileId: String(params.profileId), status });
        return startReply ? startReply(structuredClone(status)) : structuredClone(status);
      }
      const entry = results.get(requestId);
      if (!entry && method === 'settings.cancelTest') cancelledBeforeAdmission.add(requestId);
      if (!entry) throw { code: method === 'settings.cancelTest' ? 'test_not_started' : 'not_found', message: method === 'settings.cancelTest' ? 'The test never started' : 'Unknown image operation' };
      const receipt = entry.status;
      if (method === 'settings.test.status') {
        if (nextStatusFailure) { const failure = nextStatusFailure; nextStatusFailure = null; throw failure; }
        if (!['accepted', 'running'].includes(receipt.execution.state) || outcome === 'running') return structuredClone(receipt);
        entry.status = fixtureStatus(requestId, outcome, receipt.revision + 1); return structuredClone(entry.status);
      }
      if (method === 'settings.cancelTest') {
        if (['accepted', 'running'].includes(receipt.execution.state)) entry.status = fixtureStatus(requestId, 'cancelled', receipt.revision + 1);
        return structuredClone(entry.status);
      }
      if (method === 'settings.test.discard') {
        if (receipt.execution.state !== 'succeeded') throw { code: 'invalid_request', message: 'Successful test output required for discard' };
        entry.status = { ...receipt, revision: receipt.revision + 1, delivery: { state: 'discarded' } };
        if (nextCleanupFailure) { const failure = nextCleanupFailure; nextCleanupFailure = null; throw failure; }
        shown.add(requestId); return structuredClone(entry.status);
      }
      throw { code: 'method_not_found', message: 'Unknown fixture RPC' };
    };
    return await invoke() as T;
  } };
  return {
    backend, calls: () => [...calls], snapshot: () => structuredClone(current),
    outcome: (value: typeof outcome) => { outcome = value; },
    rejectStart: (reason: unknown) => { startFailure = reason; },
    failCredential: () => { credentialFailure = true; },
    failNextCleanup: (reason: unknown) => { nextCleanupFailure = reason; },
    failNextStatus: (reason: unknown) => { nextStatusFailure = reason; },
    startReply: (reply: typeof startReply) => { startReply = reply; },
    discovery: (wait: typeof discovery) => { discovery = wait; },
    retain: (profileId: string, status: ImageOperationStatus) => results.set(status.operationId, { profileId, status }),
    staleUnknown: () => results.set('stale-test', { profileId: current.profiles[0].id, status: fixtureStatus('stale-test', 'unknown', 2) }),
    remoteName: (name: string) => commit({ ...current, documentRevision: current.documentRevision + 1, profiles: current.profiles.map(p => ({ ...p, name })) }),
  };
}
