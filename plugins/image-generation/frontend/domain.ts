import type { ApiProfile, CodexProfile, ImageConfiguration, ImageProfile, ImageOperationStatus } from '../../../integration/services/image-generation-v1';
import backends from '../backends.json';
export type { ApiProfile, CodexProfile, ImageConfiguration, ImageProfile, ImageOperationStatus };

/**
 * One HTTP image backend. The data lives in `plugins/image-generation/backends.json`,
 * which the Rust descriptors are tested against (transport, default URL, credential env).
 */
export interface ApiBackend {
  readonly transport: string;
  readonly label: string;
  readonly addLabel: string;
  readonly defaultName: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly modelPlaceholder: string;
  readonly credentialEnv: string;
  readonly baseUrlLabel: string;
  readonly baseUrlNote: string;
  /** Base-URL path segments this backend refuses: matched case-insensitively against every segment; a trailing `*` is a prefix match. */
  readonly rejectedPathSegments: readonly string[];
  /** The model id becomes a URL path segment, so it must be a safe one. */
  readonly modelIdInPath: boolean;
}
export const API_BACKENDS: readonly ApiBackend[] = backends;
export const TRANSPORT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export function isCodex(profile: Pick<ImageProfile, 'transport'>): profile is CodexProfile { return profile.transport === 'codex-cli'; }
export function isApi(profile: ImageProfile): profile is ApiProfile { return profile.transport !== 'codex-cli'; }
export function backendFor(transport: string): ApiBackend | undefined { return API_BACKENDS.find(b => b.transport === transport); }

export function configuration(value: ImageConfiguration): ImageConfiguration {
  return { schemaVersion: 1, documentRevision: value.documentRevision, defaultConnectionId: value.defaultConnectionId,
    profiles: value.profiles.map(profile => isCodex(profile)
      ? { id: profile.id, name: profile.name, recipeRevision: profile.recipeRevision, transport: profile.transport, executablePath: profile.executablePath, modelSelection: false, credential: { kind: 'cli_saved_login' } }
      : { id: profile.id, name: profile.name, recipeRevision: profile.recipeRevision, transport: profile.transport, baseUrl: profile.baseUrl, defaultModel: profile.defaultModel, allowInsecureHttp: profile.allowInsecureHttp, credential: { ...profile.credential } }) };
}
export function equal(a: ImageConfiguration, b: ImageConfiguration): boolean { return JSON.stringify(configuration(a)) === JSON.stringify(configuration(b)); }
export function newProfile(id: string, transport: string): ImageProfile {
  if (transport === 'codex-cli') return { id, name: 'Codex', recipeRevision: 'draft', transport, executablePath: '', modelSelection: false, credential: { kind: 'cli_saved_login' } };
  const backend = backendFor(transport);
  return { id, name: backend?.defaultName ?? transport, recipeRevision: 'draft', transport, baseUrl: backend?.defaultBaseUrl ?? '', defaultModel: backend?.defaultModel ?? '', allowInsecureHttp: false, credential: { kind: 'none' } };
}
export function removeProfile(value: ImageConfiguration, id: string): ImageConfiguration {
  return { ...value, profiles: value.profiles.filter(p => p.id !== id), defaultConnectionId: value.defaultConnectionId === id ? null : value.defaultConnectionId };
}
export type ParsedCommand = { argv: string[]; problem: null } | { argv: null; problem: string };
const hasUnpairedSurrogate = (text: string): boolean => /[\uD800-\uDFFF]/u.test(text);
/** Tokenize argv only: quotes group, backslashes escape, and nothing expands. */
export function parseCommand(text: string): ParsedCommand {
  if (hasUnpairedSurrogate(text)) return { argv: null, problem: 'Credential command must contain valid Unicode.' };
  const argv: string[] = [];
  let token = '', started = false, quote: "'" | '"' | null = null, escaped = false;
  for (const char of text) {
    if (escaped) { token += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = null; else token += char; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) { argv.push(token); token = ''; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) return { argv: null, problem: 'Close the quote in the credential command.' };
  if (escaped) return { argv: null, problem: 'Complete the escape in the credential command.' };
  if (started) argv.push(token);
  return { argv, problem: null };
}
export function formatCommand(argv: readonly string[]): string {
  return argv.map(arg => arg && !/[\s'"\\]/u.test(arg) ? arg : `"${arg.replace(/["\\]/g, '\\$&')}"`).join(' ');
}
export interface CommandDraft { readonly text: string; readonly argv: readonly string[] }
/** Raw syntax belongs to these argv; a newly adopted configuration must display its own command. */
export function commandDraftText(argv: readonly string[], draft?: CommandDraft): string {
  return draft && JSON.stringify(argv) === JSON.stringify(draft.argv) ? draft.text : formatCommand(argv);
}
/** Mirrors the backend's UTF-8 byte and control-character policy. */
export function commandProblem(argv: readonly string[]): string | null {
  if (argv.length < 1 || argv.length > 32 || argv.some(arg => typeof arg !== 'string' || !arg || hasUnpairedSurrogate(arg) || new TextEncoder().encode(arg).length > 4096 || /\p{Cc}/u.test(arg))) return 'Credential command needs 1–32 nonempty arguments, each at most 4096 bytes without control characters.';
  if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(argv[0]) && (/[\\/:]/.test(argv[0]) || ['.', '..'].includes(argv[0]))) return 'Credential command must use an absolute executable path or a bare program name.';
  return null;
}
const PATH_SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const segmentRejected = (pattern: string, segment: string): boolean => {
  const p = pattern.toLowerCase(), s = segment.toLowerCase();
  return p.endsWith('*') ? s.startsWith(p.slice(0, -1)) : s === p;
};
/** The first base-URL path segment `backend` refuses, if any. Mirrors `domain/backend_rules.rs`. */
export function rejectedSegment(backend: ApiBackend | undefined, url: URL): string | undefined {
  return url.pathname.split('/').filter(Boolean).find(segment => backend?.rejectedPathSegments.some(p => segmentRejected(p, segment)));
}
export function validation(value: ImageConfiguration): string | null {
  if (value.profiles.length > 32) return 'Keep at most 32 image connections.';
  if (value.defaultConnectionId !== null && !value.profiles.some(p => p.id === value.defaultConnectionId)) return 'Select an existing default connection.';
  const ids = new Set<string>();
  for (const profile of value.profiles) {
    if (!/^[\w.-]{1,128}$/.test(profile.id) || ids.has(profile.id)) return 'Connection identifiers must be unique.';
    ids.add(profile.id);
    if (!profile.name.trim() || [...profile.name].length > 256 || /[\u0000-\u001f\u007f]/.test(profile.name)) return 'Enter a connection name of at most 256 characters.';
    if (isCodex(profile)) {
      if (profile.credential.kind !== 'cli_saved_login') return 'Codex uses its saved login.';
      if (profile.executablePath.length > 8192 || /[\u0000-\u001f\u007f]/.test(profile.executablePath) || profile.executablePath && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(profile.executablePath)) return 'Use an absolute Codex executable path, or leave it empty for discovery.';
    } else {
      if (!profile.defaultModel.trim() || [...profile.defaultModel].length > 256 || /[\u0000-\u001f\u007f]/.test(profile.defaultModel)) return `Enter the model ID supported by this ${transportLabel(profile)}.`;
      const backend = backendFor(profile.transport);
      if (backend?.modelIdInPath && !PATH_SAFE_MODEL_ID.test(profile.defaultModel)) return `The ${transportLabel(profile)} model ID can contain only letters, digits, ".", "_" and "-", start with a letter or digit, and be at most 128 characters.`;
      let url: URL;
      try { url = new URL(profile.baseUrl); } catch { return `Enter an absolute ${backendFor(profile.transport)?.baseUrlLabel ?? 'API URL'}.`; }
      if (profile.baseUrl.length > 2048 || !url.hostname || url.username || url.password || url.search || url.hash) return `The ${transportLabel(profile)} URL cannot contain credentials, a query, or a fragment.`;
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (profile.allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return 'Use HTTPS or explicitly allow insecure HTTP.';
      const segment = rejectedSegment(backend, url);
      if (segment !== undefined) return `The ${backend?.baseUrlLabel ?? 'API URL'} cannot contain the path segment /${segment}.`;
      if (profile.credential.kind === 'command') { const problem = commandProblem(profile.credential.argv); if (problem) return problem; }
      if (profile.credential.kind === 'environment' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(profile.credential.name)) return 'Enter a valid credential environment variable name.';
    }
  }
  return null;
}
export function validConfiguration(value: ImageConfiguration): boolean {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 0 || !Array.isArray(value.profiles) || value.profiles.length > 32 || !(value.defaultConnectionId === null || typeof value.defaultConnectionId === 'string')) return false;
  for (const profile of value.profiles) {
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || typeof profile.recipeRevision !== 'string' || !profile.credential) return false;
    if (isCodex(profile)) {
      if (typeof profile.executablePath !== 'string' || profile.modelSelection !== false || profile.credential.kind !== 'cli_saved_login') return false;
    } else if (typeof profile.transport === 'string' && TRANSPORT_ID.test(profile.transport)) {
      if (typeof profile.baseUrl !== 'string' || typeof profile.defaultModel !== 'string' || typeof profile.allowInsecureHttp !== 'boolean') return false;
      const credential = profile.credential;
      if (!['none', 'environment', 'secret', 'command'].includes(credential.kind) || credential.kind === 'environment' && typeof credential.name !== 'string' || credential.kind === 'secret' && typeof credential.id !== 'string' || credential.kind === 'command' && (!Array.isArray(credential.argv) || credential.argv.some((arg: unknown) => typeof arg !== 'string'))) return false;
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
/** Codex has one saved login and discovers its own executable, so one Codex connection is enough. */
export function canAddCodex(value: Pick<ImageConfiguration, 'profiles'>): boolean { return !value.profiles.some(isCodex); }
/** Codex, a registered backend's label, or (for a backend this build does not know) its transport id. */
export function transportLabel(profile: Pick<ImageProfile, 'transport'>): string { return isCodex(profile) ? 'Codex' : backendFor(profile.transport)?.label ?? profile.transport; }
export function setDefault(value: ImageConfiguration, id: string): ImageConfiguration {
  return value.profiles.some(p => p.id === id) ? { ...value, defaultConnectionId: id } : value;
}
