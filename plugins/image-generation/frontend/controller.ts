import { active, configuration, equal, validation, validConfiguration, validTestReceipt, type ImageConfiguration, type ImageOperationStatus, type ImageProfile } from './domain';
export interface Backend { invoke<T>(method: string, params?: Record<string, unknown>): Promise<T> }
export interface RevisionEvent { documentRevision: number; affectedProfileIds: readonly string[] }
export interface TestResult { requestId: string; profileId: string; profileName: string; configurationRevision: number; status?: ImageOperationStatus; error?: string }
export interface State { saved: ImageConfiguration | null; draft: ImageConfiguration | null; busy: boolean; loading: boolean; conflict: boolean; error: string; message: string; check: { profileId: string; message: string; available: boolean } | null; tests: readonly TestResult[] }
export class TestRegistry {
  private records = new Map<string, TestResult>();
  private discarded = new Set<string>();
  private listeners = new Set<() => void>();
  all(): readonly TestResult[] { return [...this.records.values()]; }
  set(result: TestResult): void {
    if (this.discarded.has(result.requestId)) return;
    this.records.set(result.requestId, result);
    if (this.records.size > 64) for (const [id, record] of this.records) { if (this.records.size <= 64) break; if (record.status && ['failed', 'cancelled'].includes(record.status.execution.state)) this.records.delete(id); }
    for (const fn of this.listeners) fn();
  }
  remove(id: string): void { this.discarded.add(id); this.records.delete(id); for (const fn of this.listeners) fn(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
const initial = (): State => ({ saved: null, draft: null, busy: false, loading: true, conflict: false, error: '', message: '', check: null, tests: [] });
function message(cause: unknown): string { return typeof cause === 'string' ? cause.slice(0, 1024) : cause instanceof Error ? cause.message.slice(0, 1024) : 'The image service could not complete this request.'; }
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
  private unsubscribe: () => void;
  constructor(private backend: Backend, private registry: TestRegistry, private timer: Schedule = schedule, private id: () => string = () => crypto.randomUUID()) {
    this.state.tests = registry.all();
    this.unsubscribe = registry.subscribe(() => this.update({ tests: registry.all() }));
  }
  snapshot(): State { return this.state; }
  subscribe(fn: (state: State) => void): () => void { this.listeners.add(fn); fn(this.state); return () => this.listeners.delete(fn); }
  get dirty(): boolean { return !!this.state.saved && !!this.state.draft && !equal(this.state.saved, this.state.draft); }
  private update(patch: Partial<State>): void { if (this.disposed) return; this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(this.state); }
  async initialize(): Promise<void> { await this.refresh(); for (const test of this.registry.all()) if (active(test.status)) void this.poll(test.requestId); }
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
    const unresolved = (test: TestResult) => active(test.status) || test.status?.execution.state === 'unknown' || test.status?.execution.state === 'succeeded' && !['discarded', 'acquired'].includes(test.status.delivery.state);
    if (prior.filter(unresolved).length >= 16 || prior.some(t => t.profileId === profileId && unresolved(t))) { this.update({ error: 'Resolve the retained test for this connection before starting another.' }); return; }
    const record: TestResult = { requestId: this.id(), profileId, profileName: profile.name, configurationRevision: this.state.saved!.documentRevision };
    this.registry.set(record);
    try {
      this.accept(record, await this.backend.invoke<ImageOperationStatus>('settings.test', { profileId, requestId: record.requestId, expectedConfigurationRevision: record.configurationRevision }));
      if (this.disposed) { void this.cancel(record.requestId); return; }
      if (active(this.registry.all().find(t => t.requestId === record.requestId)?.status)) this.queue(record.requestId);
    } catch (cause) { this.failure(record, `${message(cause)} The operation ID is retained; refresh status before starting another test.`); }
  }
  private accept(record: TestResult, status: ImageOperationStatus): void {
    if (!validTestReceipt(status, record.requestId)) throw new Error('The service returned an invalid test receipt.');
    const old = this.registry.all().find(t => t.requestId === record.requestId);
    if (old?.status && status.revision < old.status.revision) return;
    this.registry.set({ ...record, status, error: undefined });
  }
  private failure(record: TestResult, error: string): void { this.registry.set({ ...(this.registry.all().find(t => t.requestId === record.requestId) ?? record), error }); }
  private queue(requestId: string): void {
    this.timers.get(requestId)?.();
    this.timers.delete(requestId);
    if (!this.disposed && this.registry.all().some(test => test.requestId === requestId)) this.timers.set(requestId, this.timer(() => { this.timers.delete(requestId); void this.poll(requestId); }, 750));
  }
  async poll(requestId: string): Promise<void> {
    const record = this.registry.all().find(t => t.requestId === requestId); if (!record || this.polling.has(requestId) || this.disposed) return;
    this.polling.add(requestId);
    try { this.accept(record, await this.backend.invoke<ImageOperationStatus>('settings.test.status', { requestId })); }
    catch (cause) { this.failure(record, message(cause)); }
    finally { this.polling.delete(requestId); if (!this.disposed && active(this.registry.all().find(t => t.requestId === requestId)?.status)) this.queue(requestId); }
  }
  async cancel(requestId: string): Promise<void> {
    const record = this.registry.all().find(t => t.requestId === requestId); if (!record || !active(record.status)) return;
    try { this.accept(record, await this.backend.invoke<ImageOperationStatus>('settings.cancelTest', { requestId })); if (!this.disposed && active(this.registry.all().find(t => t.requestId === requestId)?.status)) this.queue(requestId); }
    catch (cause) { this.failure(record, `Cancellation could not be confirmed: ${message(cause)}`); }
  }
  async discard(requestId: string): Promise<void> {
    const record = this.registry.all().find(t => t.requestId === requestId);
    if (!record || record.status?.execution.state !== 'succeeded' || this.disposed) return;
    try { const status = await this.backend.invoke<ImageOperationStatus>('settings.test.discard', { requestId }); this.accept(record, status); if (status.delivery.state === 'discarded') this.registry.remove(requestId); }
    catch (cause) { this.failure(record, `Test output remains retained: ${message(cause)}`); }
  }
  close(): void {
    if (this.disposed) return;
    this.disposed = true; this.actionSequence++; this.readSequence++; this.unsubscribe();
    for (const stop of this.timers.values()) stop(); this.timers.clear(); this.listeners.clear();
    for (const test of this.registry.all()) if (active(test.status)) void this.cancel(test.requestId);
  }
}
