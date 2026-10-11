import { active, configuration, equal, validation, validConfiguration, validTestReceipt, type ImageConfiguration, type ImageOperationStatus, type ImageProfile, type TestOutcome } from './domain';
export interface Backend { invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> }
export interface RevisionEvent { documentRevision: number; affectedProfileIds: readonly string[] }
export interface TestResult extends TestOutcome { requestId: string; profileName: string; configurationRevision: number; startedAt?: number; outputCleaned?: boolean; cancelRequested?: boolean; cancelNotStarted?: boolean }
export interface State { saved: ImageConfiguration | null; draft: ImageConfiguration | null; busy: boolean; loading: boolean; recoveringTests: boolean; conflict: boolean; error: string; message: string; check: { profileId: string; message: string; available: boolean } | null; tests: readonly TestResult[] }
export class TestRegistry {
  private records = new Map<string, TestResult>();
  private discarded = new Set<string>();
  private listeners = new Set<() => void>();
  all(): readonly TestResult[] { return [...this.records.values()]; }
  set(result: TestResult): void {
    if (this.discarded.has(result.requestId)) return;
    this.records.set(result.requestId, result);
    if (this.records.size > 64) {
      const latest = new Map([...this.records.values()].map(record => [record.profileId, record.requestId]));
      for (const [id, record] of this.records) {
        if (this.records.size <= 64) break;
        if (latest.get(record.profileId) !== id && !pollable(record)) this.records.delete(id);
      }
    }
    for (const fn of this.listeners) fn();
  }
  remove(id: string): void { this.discarded.add(id); this.records.delete(id); for (const fn of this.listeners) fn(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
export const pending = (test: TestResult): boolean => !test.neverStarted && (!test.startFailed || !!test.status) && active(test.status);
const needsOutputCleanup = (test: TestResult): boolean => !test.outputCleaned && test.status?.execution.state === 'succeeded' && ['available', 'discarded', 'unavailable'].includes(test.status.delivery.state);
const pollable = (test: TestResult): boolean => pending(test) || needsOutputCleanup(test);
const initial = (): State => ({ saved: null, draft: null, busy: false, loading: true, recoveringTests: true, conflict: false, error: '', message: '', check: null, tests: [] });
function message(cause: unknown): string {
  // The native bridge rejects with JSON-RPC objects, not necessarily Error instances.
  if (cause && typeof cause === 'object') {
    const rpc = cause as { message?: unknown; data?: { message?: unknown }; error?: { message?: unknown } };
    const detail = rpc.data?.message ?? rpc.error?.message ?? rpc.message;
    if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 1024);
  }
  return typeof cause === 'string' ? cause.slice(0, 1024) : cause instanceof Error ? cause.message.slice(0, 1024) : 'The image service could not complete this request.'; }
/** Only structured provider errors can prove that admission did not happen. */
function errorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const rpc = cause as { code?: unknown; data?: { code?: unknown }; error?: unknown };
  const code = rpc.data?.code ?? rpc.code;
  return typeof code === 'string' ? code : errorCode(rpc.error);
}
const rejectedBeforeAdmission = (cause: unknown): boolean => ['test_not_started', 'configuration_changed', 'invalid_request', 'preparation_expired', 'operation_conflict', 'test_already_running'].includes(errorCode(cause) ?? '');
type Schedule = (fn: () => void, delay: number) => () => void;
const schedule: Schedule = (fn, delay) => { const timer = setTimeout(fn, delay); return () => clearTimeout(timer); };
export class ConnectionsController {
  private state: State = initial();
  private listeners = new Set<(state: State) => void>();
  private disposed = false;
  private observed = 0;
  private readSequence = 0;
  private actionSequence = 0;
  private timers = new Map<string, () => void>();
  private polling = new Set<string>();
  private discarding = new Map<string, Promise<void>>();
  private unsubscribe: () => void;
  constructor(private backend: Backend, private registry: TestRegistry, private timer: Schedule = schedule, private id: () => string = () => crypto.randomUUID()) {
    this.state.tests = registry.all();
    this.unsubscribe = registry.subscribe(() => this.update({ tests: registry.all() }));
  }
  snapshot(): State { return this.state; }
  subscribe(fn: (state: State) => void): () => void { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  get dirty(): boolean { return !!this.state.saved && !!this.state.draft && !equal(this.state.saved, this.state.draft); }
  private update(patch: Partial<State>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(this.state); }
  async initialize(): Promise<void> {
    await this.refresh();
    try {
      const retained = await this.backend.invoke<{ profileId: string; status: ImageOperationStatus }[]>('settings.test.list');
      if (!Array.isArray(retained)) throw new Error('The service returned an invalid test list.');
      for (const entry of retained) {
        const profile = this.state.saved?.profiles.find(p => p.id === entry.profileId);
        const record = this.registry.all().find(t => t.requestId === entry.status?.operationId) ?? { requestId: entry.status?.operationId, profileId: entry.profileId, profileName: profile?.name ?? entry.profileId, configurationRevision: this.state.saved?.documentRevision ?? 0 };
        this.accept(record, entry.status);
      }
      this.update({ recoveringTests: false });
    } catch (cause) {
      this.update({ error: message(cause) });
      if (!this.disposed) {
        this.timers.get('discovery')?.();
        this.timers.set('discovery', this.timer(() => { this.timers.delete('discovery'); void this.initialize(); }, 750));
      }
    }
    await Promise.all(this.registry.all().map(test => pending(test) ? this.poll(test.requestId) : this.discard(test.requestId)));
  }
  revision(event: RevisionEvent): void {
    if (!Number.isSafeInteger(event.documentRevision) || event.documentRevision < 0) return;
    this.observed = Math.max(this.observed, event.documentRevision);
    if (event.documentRevision > (this.state.saved?.documentRevision ?? -1)) {
      this.actionSequence++;
      this.update({ check: null });
      if (!this.state.busy) void this.refresh();
    }
  }
  edit(draft: ImageConfiguration): void { if (this.state.busy || this.disposed) return; this.actionSequence++; this.update({ draft: configuration(draft), error: '', message: '', check: null }); }
  private adopt(value: ImageConfiguration): void { this.observed = Math.max(this.observed, value.documentRevision); this.actionSequence++; this.update({ saved: configuration(value), draft: configuration(value), conflict: false, error: '', check: null }); }
  async refresh(force = false): Promise<void> {
    const read = ++this.readSequence;
    try {
      const value = await this.backend.invoke<ImageConfiguration>('settings.read');
      if (!validConfiguration(value)) throw new Error('The service returned invalid connection settings. Your draft is preserved.');
      if (this.disposed || read !== this.readSequence || value.documentRevision < (this.state.saved?.documentRevision ?? -1)) return;
      this.observed = Math.max(this.observed, value.documentRevision);
      if (force || !this.state.saved) this.adopt(value);
      else if (value.documentRevision > this.state.saved.documentRevision) {
        if (this.dirty || this.state.busy) this.update({ conflict: true, check: null }); else this.adopt(value);
      }
    } catch (cause) { if (read === this.readSequence) this.update({ error: message(cause) }); }
    finally { if (read === this.readSequence) this.update({ loading: false }); }
  }
  async save(): Promise<void> {
    const { saved, draft } = this.state;
    if (!saved || !draft || this.state.busy || this.state.conflict) return;
    const invalid = validation(draft); if (invalid) { this.update({ error: invalid }); return; }
    await this.mutate('settings.save', { expectedRevision: saved.documentRevision, configuration: configuration(draft) }, 'Connections saved.');
  }
  async credential(profileId: string, key: string | null): Promise<void> {
    if (!this.state.saved || this.dirty || this.state.busy || this.state.conflict) return;
    if (key !== null && (!key.trim() || key.length > 4096 || /[\u0000-\u001f\u007f]/.test(key))) { this.update({ error: 'Enter a nonempty API key of at most 4096 characters.' }); return; }
    await this.mutate(key === null ? 'settings.credential.clear' : 'settings.credential.set', { expectedRevision: this.state.saved.documentRevision, profileId, ...(key === null ? {} : { key }) }, key === null ? 'Saved key cleared.' : 'API key saved securely.');
  }
  private async mutate(method: string, params: Record<string, unknown>, success: string): Promise<void> {
    this.actionSequence++; this.update({ busy: true, error: '', message: '', check: null });
    try { const value = await this.backend.invoke<ImageConfiguration>(method, params); if (!validConfiguration(value)) throw new Error('The saved settings reply is invalid; reload to verify the committed state.'); this.adopt(value); this.update({ message: success }); }
    catch (cause) { this.update({ error: message(cause) }); await this.refresh(); }
    finally { this.update({ busy: false }); if (!this.disposed && this.observed > (this.state.saved?.documentRevision ?? -1)) await this.refresh(); }
  }
  private usable(profileId: string): ImageProfile | undefined { return !this.dirty && !this.state.busy && !this.state.conflict ? this.state.saved?.profiles.find(p => p.id === profileId) : undefined; }
  async check(profileId: string): Promise<void> {
    if (!this.usable(profileId)) return;
    const sequence = ++this.actionSequence;
    this.update({ check: null, message: 'Checking the saved connection locally…', error: '' });
    try {
      const result = await this.backend.invoke<{ available: boolean; error?: { message: string } }>('settings.check', { profileId });
      if (sequence !== this.actionSequence) return;
      this.update({ message: '', check: { profileId, available: result.available, message: result.available ? 'Local checks passed. Model generation has not been tested.' : result.error?.message ?? 'This connection is unavailable.' } });
    } catch (cause) { if (sequence === this.actionSequence) this.update({ message: '', error: message(cause) }); }
  }
  async test(profileId: string): Promise<void> {
    const profile = this.usable(profileId); if (!profile) return;
    const prior = this.registry.all();
    if (prior.some(t => t.profileId === profileId && pending(t))) return;
    if (this.disposed || this.state.recoveringTests) return;
    const record: TestResult = { requestId: this.id(), profileId, profileName: profile.name, configurationRevision: this.state.saved!.documentRevision, connectionRevision: profile.recipeRevision, startedAt: Date.now() };
    this.registry.set(record);
    try {
      const status = await this.backend.invoke<ImageOperationStatus>('settings.test', { profileId, requestId: record.requestId, expectedConfigurationRevision: record.configurationRevision });
      this.accept(record, status);
      if (this.disposed || this.registry.all().find(t => t.requestId === record.requestId)?.cancelRequested) { await this.cancel(record.requestId); await this.discard(record.requestId); return; }
      if (active(this.registry.all().find(t => t.requestId === record.requestId)?.status)) this.queue(record.requestId);
      else await this.discard(record.requestId);
    } catch (cause) {
      const latest = this.registry.all().find(t => t.requestId === record.requestId) ?? record;
      const rejected = rejectedBeforeAdmission(cause);
      // Transport failures cannot prove the billable operation was rejected.
      // Cancellation's durable no-receipt evidence survives any late failure.
      const neverStarted = !latest.status && !!latest.cancelNotStarted;
      this.registry.set({ ...latest, startFailed: !latest.status && rejected,
        neverStarted,
        error: neverStarted ? 'The test never started' : message(cause) });
      await this.poll(record.requestId);
      const settled = this.registry.all().find(t => t.requestId === record.requestId);
      if (settled && pending(settled) && (this.disposed || settled.cancelRequested)) await this.cancel(record.requestId);
    }
  }
  private accept(record: TestResult, status: ImageOperationStatus): void {
    if (!validTestReceipt(status, record.requestId)) throw new Error('The service returned an invalid test receipt.');
    const old = this.registry.all().find(t => t.requestId === record.requestId);
    if (old?.status && status.revision < old.status.revision) return;
    this.registry.set({ ...record, ...old, status, startFailed: false, neverStarted: false, cancelNotStarted: false, error: undefined,
      elapsedMs: old?.elapsedMs ?? (!active(status) && record.startedAt !== undefined ? Date.now() - record.startedAt : undefined) });
    if (!active(status)) { this.timers.get(record.requestId)?.(); this.timers.delete(record.requestId); }
  }
  private failure(record: TestResult, error: string): void { const latest = this.registry.all().find(t => t.requestId === record.requestId) ?? record; this.registry.set({ ...latest, error: (latest.startFailed || latest.neverStarted) && latest.error ? latest.error : error }); }
  private queue(requestId: string): void {
    this.timers.get(requestId)?.();
    this.timers.delete(requestId);
    const record = this.registry.all().find(test => test.requestId === requestId);
    if (record && pollable(record) && (!this.disposed || record.cancelRequested || needsOutputCleanup(record))) this.timers.set(requestId, this.timer(() => {
      this.timers.delete(requestId);
      const latest = this.registry.all().find(test => test.requestId === requestId);
      if (latest && pending(latest)) void this.poll(requestId);
      else void this.discard(requestId);
    }, 750));
  }
  async poll(requestId: string): Promise<void> {
    const record = this.registry.all().find(t => t.requestId === requestId); if (!record || !pending(record) || this.polling.has(requestId) || this.disposed && !record.cancelRequested) return;
    this.polling.add(requestId);
    try { this.accept(record, await this.backend.invoke<ImageOperationStatus>('settings.test.status', { requestId }));
      const latest = this.registry.all().find(t => t.requestId === requestId)!;
      if (pending(latest) && latest.cancelRequested) await this.cancel(requestId);
      else await this.discard(requestId);
    }
    catch (cause) { this.failure(record, message(cause)); }
    finally { this.polling.delete(requestId); if (this.registry.all().some(t => t.requestId === requestId && pollable(t))) this.queue(requestId); }
  }
  async cancel(requestId: string): Promise<void> {
    const record = this.registry.all().find(t => t.requestId === requestId); if (!record || !pending(record)) return;
    this.registry.set({ ...record, cancelRequested: true });
    try { this.accept(record, await this.backend.invoke<ImageOperationStatus>('settings.cancelTest', { requestId })); if (active(this.registry.all().find(t => t.requestId === requestId)?.status)) this.queue(requestId); else await this.discard(requestId); }
    catch (cause) {
      const reason = message(cause);
      if (errorCode(cause) === 'test_not_started') {
        const latest = this.registry.all().find(t => t.requestId === requestId) ?? record;
        // The backend durably records cancellation before this reply, so even
        // admission still in flight cannot dispatch. A late receipt overrides it.
        const neverStarted = !latest.status;
        this.registry.set({ ...latest, cancelNotStarted: true, neverStarted,
          startFailed: neverStarted || latest.startFailed, error: reason });
        if (neverStarted) { this.timers.get(requestId)?.(); this.timers.delete(requestId); }
        else this.queue(requestId);
      } else { this.failure(record, `Cancellation could not be confirmed: ${reason}`); this.queue(requestId); }
    }
  }
  async discard(requestId: string): Promise<void> {
    const existing = this.discarding.get(requestId); if (existing) return existing;
    const record = this.registry.all().find(t => t.requestId === requestId);
    if (!record || !needsOutputCleanup(record)) return;
    const work = (async () => {
      try {
        const status = await this.backend.invoke<ImageOperationStatus>('settings.test.discard', { requestId });
        if (status?.execution?.state !== 'succeeded' || status.delivery?.state !== 'discarded') throw new Error('The service did not confirm test output discard.');
        this.accept(record, status);
        const latest = this.registry.all().find(test => test.requestId === requestId)!;
        this.registry.set({ ...latest, outputCleaned: true });
      } catch (cause) { this.failure(record, `Test cleanup could not be confirmed: ${message(cause)}`); this.queue(requestId); }
    })();
    this.discarding.set(requestId, work);
    try { await work; } finally { this.discarding.delete(requestId); }
  }
  close(): void {
    if (this.disposed) return;
    this.disposed = true; this.actionSequence++; this.readSequence++; this.unsubscribe();
    for (const stop of this.timers.values()) stop(); this.timers.clear(); this.listeners.clear();
    for (const test of this.registry.all()) {
      if (pending(test)) void this.cancel(test.requestId);
      else if (needsOutputCleanup(test)) void this.discard(test.requestId);
    }
  }
}
