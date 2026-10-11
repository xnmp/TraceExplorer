import type { ImageConfiguration, ImageProfile, ImageOperationStatus } from '../../../integration/services/image-generation-v1';
export type { ImageConfiguration, ImageProfile, ImageOperationStatus };

export function configuration(value: ImageConfiguration): ImageConfiguration {
  return { schemaVersion: 1, documentRevision: value.documentRevision, defaultConnectionId: value.defaultConnectionId,
    profiles: value.profiles.map(profile => profile.transport === 'codex-cli'
      ? { id: profile.id, name: profile.name, recipeRevision: profile.recipeRevision, transport: profile.transport, executablePath: profile.executablePath, modelSelection: false, credential: { kind: 'cli_saved_login' } }
      : { id: profile.id, name: profile.name, recipeRevision: profile.recipeRevision, transport: profile.transport, baseUrl: profile.baseUrl, defaultModel: profile.defaultModel, allowInsecureHttp: profile.allowInsecureHttp, credential: { ...profile.credential } }) };
}
export function equal(a: ImageConfiguration, b: ImageConfiguration): boolean { return JSON.stringify(configuration(a)) === JSON.stringify(configuration(b)); }
export function newProfile(id: string, transport: ImageProfile['transport']): ImageProfile {
  const base = { id, name: transport === 'codex-cli' ? 'Codex' : 'Images API', recipeRevision: 'draft' };
  return transport === 'codex-cli' ? { ...base, transport, executablePath: '', modelSelection: false, credential: { kind: 'cli_saved_login' } }
    : { ...base, transport, baseUrl: 'https://api.openai.com/v1/images', defaultModel: '', allowInsecureHttp: false, credential: { kind: 'none' } };
}
export function removeProfile(value: ImageConfiguration, id: string): ImageConfiguration {
  return { ...value, profiles: value.profiles.filter(p => p.id !== id), defaultConnectionId: value.defaultConnectionId === id ? null : value.defaultConnectionId };
}
export function validation(value: ImageConfiguration): string | null {
  if (value.profiles.length > 32) return 'Keep at most 32 image connections.';
  if (value.defaultConnectionId !== null && !value.profiles.some(p => p.id === value.defaultConnectionId)) return 'Select an existing default connection.';
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!/^[\w.-]{1,128}$/.test(profile.id) || ids.has(profile.id)) return 'Connection identifiers must be unique.';
    ids.add(profile.id);
    if (!profile.name.trim() || [...profile.name].length > 256 || /[\u0000-\u001f\u007f]/.test(profile.name)) return 'Enter a connection name of at most 256 characters.';
    if (profile.transport === 'codex-cli') {
      if (profile.executablePath.length > 8192 || /[\u0000-\u001f\u007f]/.test(profile.executablePath) || profile.executablePath && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(profile.executablePath)) return 'Use an absolute Codex executable path, or leave it empty for discovery.';
    } else {
      if (!profile.defaultModel.trim() || [...profile.defaultModel].length > 256 || /[\u0000-\u001f\u007f]/.test(profile.defaultModel)) return 'Enter the model ID supported by this Images API.';
      let url: URL;
      try { url = new URL(profile.baseUrl); } catch { return 'Enter an absolute Images resource URL.'; }
      if (profile.baseUrl.length > 2048 || !url.hostname || url.username || url.password || url.search || url.hash) return 'The Images URL cannot contain credentials, a query, or a fragment.';
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (profile.allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return 'Use HTTPS or explicitly allow insecure HTTP.';
      if (/\/(generations|edits)\/?$/.test(url.pathname)) return 'Use the Images resource root, without /generations or /edits.';
      if (profile.credential.kind === 'environment' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.credential.name)) return 'Enter a valid credential environment variable name.';
    }
  }
  return null;
}
export function validConfiguration(value: ImageConfiguration): boolean {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 0 || !Array.isArray(value.profiles) || value.profiles.length > 32 || !(value.defaultConnectionId === null || typeof value.defaultConnectionId === 'string')) return false;
  for (const profile of value.profiles) {
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || typeof profile.recipeRevision !== 'string' || !profile.credential) return false;
    if (profile.transport === 'codex-cli') {
      if (typeof profile.executablePath !== 'string' || profile.modelSelection !== false || profile.credential.kind !== 'cli_saved_login') return false;
    } else if (profile.transport === 'openai-images') {
      if (typeof profile.baseUrl !== 'string' || typeof profile.defaultModel !== 'string' || typeof profile.allowInsecureHttp !== 'boolean') return false;
      const credential = profile.credential;
      if (!['none', 'environment', 'secret'].includes(credential.kind) || credential.kind === 'environment' && typeof credential.name !== 'string' || credential.kind === 'secret' && typeof credential.id !== 'string') return false;
    } else return false;
  }
  return validation(value) === null;
}
export function active(status?: ImageOperationStatus): boolean { return !status || status.execution.state === 'accepted' || status.execution.state === 'running'; }
export function validTestReceipt(status: ImageOperationStatus, requestId: string): boolean {
  if (!status || status.version !== 1 || status.operationId !== requestId || !Number.isSafeInteger(status.revision) || status.revision < 0
    || !/^[a-f0-9]{64}$/.test(status.requestFingerprint) || status.provider?.packageId !== 'xnmp.image-generation' || status.provider.serviceId !== 'image-generation' || status.provider.major !== 1 || !status.execution || !status.delivery) return false;
  const execution = status.execution;
  if (!['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(execution.state)) return false;
  if (execution.state === 'failed' || execution.state === 'unknown') {
    if (!execution.error || typeof execution.error.code !== 'string' || !execution.error.code || execution.error.code.length > 128 || typeof execution.error.message !== 'string' || execution.error.message.length > 4096) return false;
  }
  if (execution.state === 'succeeded') {
    const metadata = execution.metadata;
    const nullable = (value: unknown, limit: number) => value === null || typeof value === 'string' && value.length <= limit;
    if (!metadata || typeof metadata.adapter !== 'string' || metadata.adapter.length > 128 || typeof metadata.endpointIdentity !== 'string' || metadata.endpointIdentity.length > 8192 || typeof metadata.remoteChargeUncertain !== 'boolean'
      || !nullable(metadata.requestedModel, 256) || !nullable(metadata.actualModel, 256) || !nullable(metadata.externalRequestId, 4096) || !nullable(metadata.threadId, 4096)
      || !metadata.options || typeof metadata.options.size !== 'string' || metadata.options.size.length > 128 || !['auto', 'low', 'medium', 'high'].includes(metadata.options.quality) || !['auto', 'opaque', 'transparent'].includes(metadata.options.background)) return false;
  }
  const delivery = status.delivery;
  if (!['none', 'available', 'acquired', 'discarded', 'unavailable'].includes(delivery.state)) return false;
  if (execution.state !== 'succeeded' && delivery.state !== 'none' || execution.state === 'succeeded' && delivery.state === 'none') return false;
  if (delivery.state === 'available') return !!delivery.output && typeof delivery.output.handle === 'string' && delivery.output.handle.length > 0 && delivery.output.handle.length <= 256 && /^[a-f0-9]{64}$/.test(delivery.output.sha256) && Number.isSafeInteger(delivery.output.byteLength) && delivery.output.byteLength > 0 && delivery.output.byteLength <= 50 * 1024 * 1024 && delivery.output.mediaType === 'image/png';
  if (delivery.state === 'acquired') return typeof delivery.transferReceipt === 'string' && delivery.transferReceipt.length > 0 && delivery.transferReceipt.length <= 256;
  if (delivery.state === 'unavailable') return ['missing', 'corrupt', 'storage_unavailable'].includes(delivery.reason);
  return true;
}
export function testSummary(status: ImageOperationStatus): string {
  const execution = status.execution;
  if (execution.state === 'succeeded') return status.delivery.state === 'discarded' ? 'Generation succeeded. Test output discarded.' : status.delivery.state === 'available' ? 'Generation succeeded. Test output is retained until you discard it.' : 'Generation succeeded; its output is unavailable. No new generation was started.';
  if (execution.state === 'failed' || execution.state === 'unknown') return `${execution.state === 'unknown' ? 'Remote outcome unknown' : 'Generation failed'}: ${execution.error.message}`;
  return execution.state === 'cancelled' ? 'Test cancelled.' : execution.state === 'running' ? 'Generating a test image…' : 'Test accepted; waiting for generation…';
}
/** The short, user-facing name of a connection's kind. */
export function transportLabel(profile: Pick<ImageProfile, 'transport'>): string { return profile.transport === 'codex-cli' ? 'Codex' : 'Images API'; }
export function setDefault(value: ImageConfiguration, id: string): ImageConfiguration {
  return value.profiles.some(p => p.id === id) ? { ...value, defaultConnectionId: id } : value;
}
