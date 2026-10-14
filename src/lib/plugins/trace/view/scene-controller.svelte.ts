/**
 * The pane's scene controller (docs/scene-transactions.md §4–5): the only publisher of drawable
 * state. Every interaction is an action with a lease; external changes arrive through one intake
 * (`offer`) and become root transactions. A transaction captures the pane's intent once it has
 * stabilised, prepares complete data (component leases under one index token) and the complete
 * folder layout (the registered engine, inline or in the worker), and commits one scene. The
 * previous scene stays published until then; nothing partial, estimated or placeholder is ever
 * published.
 *
 * Supersession is by transaction id: a newer action aborts the preparing one, whose late results
 * are dropped. A commit is accepted only while its transaction is current, and motion starts only
 * while its publication is still the published one.
 *
 * Cold opens: a requested stack whose data is not ready stays closed in the scene; its cover
 * carries a notice (busy at once, spinner after 400 ms in the view). Every requested stack whose
 * current data is not committed (a cold open, or an open stack read again for a new index) has a
 * 5 s deadline. A failed or timed-out stack fails in its cover only: it is laid out closed with
 * its error until Retry or an explicit close (a failed re-read also until a newer index), so late
 * results never open it and the rest of the folder still commits.
 *
 * An action's operation that throws fails its transaction; one still pending after the same
 * bound stops holding the scene, so external changes are never held back by it.
 */
import { tick as svelteTick } from "svelte";
import type { NodeKey } from "$lib/domain/trace-graph/model";
import type { ComponentData, FolderIndex } from "$lib/domain/trace-graph/folder-data";
import { buildFolderScene, diffScenes, type FolderScene, type SceneDiff, type SceneScope } from "$lib/domain/trace-graph/folder-scene";
import { engines, memoizeEngine, type FolderLayout, type FolderLayoutEngine, type FolderLayoutInput, type GraphId } from "$lib/domain/trace-graph/folder-layout";
import { folderItems, fresh, intentChange, changed as anyChange, prepareLayoutInput, requiredComponents, resolveCover, stylingOf,
  sameStyling, type HeldHistory, type IntentChange, type SceneData, type SceneIntent } from "./scene-inputs";
import { restylePresentation, retargetPresentation, settledPresentation, staticPresentation, type DisplayedPresentation, type Presentation,
  type Publication, type TransactionId } from "./presentation";
import { presents } from "./scene-view";
import { motionParticipants } from "./participants";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import { sceneInstrumentation, type SceneEvent } from "./scene-instrumentation";
import { StaleComponentsError, type ComponentLease } from "./folder-session.svelte";

export type { Publication, TransactionId };

export type TransactionStatus = "collecting" | "preparing-data" | "preparing-layout" | "ready" | "committed" | "superseded" | "failed";

export interface SceneCause {
  readonly kind: "startup" | "restore" | "selection" | "expand" | "collapse" | "resize" | "metrics" | "listing" | "refresh" | "reveal" | "retry";
  /** Stable node key, cover key or entry path. */
  readonly target: string | null;
  readonly anchor: "hold" | "reveal" | "none";
}

export interface SceneTransaction {
  readonly id: TransactionId;
  readonly scope: SceneScope;
  /** The captured intent, null until it has stabilised. */
  readonly intent: SceneIntent | null;
  readonly cause: SceneCause;
  readonly status: TransactionStatus;
  /** Covers waiting for data or layout. */
  readonly pending: ReadonlySet<GraphId>;
  readonly error: string | null;
}

export interface ActionLease {
  readonly id: TransactionId;
  /** Aborts when a newer action supersedes this one or the pane's folder changes. */
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Runs a write that belongs to this action (it dirties the same transaction, never a new one). */
  derive<T>(write: () => T): T;
}

export interface PreparationNotice {
  readonly transactionId: TransactionId;
  readonly coverKey: GraphId;
  readonly phase: "loading" | "arranging" | "failed";
  readonly message: string | null;
}

/** What the controller reads from the folder session. */
export interface SceneDataSource {
  readonly index: FolderIndex | null;
  readonly components: ReadonlyMap<string, ComponentData>;
  isStale(id: string): boolean;
  acquireComponents(ids: readonly string[], token: string, signal?: AbortSignal): ComponentLease;
}

/** The data revision the intake reports with the intent, compared by identity. */
export interface DataMark {
  readonly index: FolderIndex | null;
  readonly components: ReadonlyMap<string, ComponentData>;
}

/**
 * The renderer's native motion driver (`scene-motion.ts`). `sample` runs before a geometry
 * publication renders and reports what the published presentation displays now; `start` runs
 * once after the publication rendered, in the commit's microtask checkpoint, creating every
 * effect of the new presentation's epoch, and reports whether anything started and when it has
 * settled (false when superseded). `snap` ends owned motion.
 */
export interface SceneMotion {
  /** The visible area in folder coordinates (null when unknown): it selects motion participants (`motionParticipants`). */
  viewport?(): GridRect | null;
  sample(presentation: Presentation): DisplayedPresentation;
  reduced(): boolean;
  start(presentation: Presentation): { readonly started: boolean; readonly settled: Promise<boolean> };
  snap(): void;
}

export interface SceneControllerOptions {
  readonly paneId: string;
  readonly data: SceneDataSource;
  /** Inline engine (default: the registered default engine, memoised). */
  readonly engine?: FolderLayoutEngine;
  /** Off-thread engine run; rejects with an AbortError as soon as `signal` aborts. */
  readonly runLayout?: (input: FolderLayoutInput, signal: AbortSignal) => Promise<FolderLayout>;
  /** Whether a prepared input is small enough to lay out inline (default: always). */
  readonly inline?: (input: FolderLayoutInput) => boolean;
  /** Told about every layout `runLayout` computed (to reuse its parts inline later). */
  readonly remember?: (layout: FolderLayout) => void;
  readonly tick?: () => Promise<void>;
  readonly setTimer?: (run: () => void, ms: number) => () => void;
  /** Per-cover preparation deadline (data and layout). */
  readonly deadline?: number;
  /** Counts preparation as pending work (the harness's `layoutsPending`); returns its release. */
  readonly holdWork?: () => () => void;
}

/** Actions that may commit on the last coherent committed data while current data is still loading. */
const HOT = new Set<SceneCause["kind"]>(["selection", "collapse", "resize", "metrics"]);
const MAX_RESTARTS = 3;
const STABILISE_TICKS = 8;
export const PREPARATION_DEADLINE_MS = 5000;
const noop = () => undefined;
const thenable = (value: unknown): value is PromiseLike<unknown> => !!value && typeof (value as { then?: unknown }).then === "function";

const superseded = () => new DOMException("Trace scene transaction was superseded", "AbortError");
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Rejects with the signal's reason as soon as it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

interface Committed {
  readonly intent: SceneIntent;
  readonly data: SceneData;
  readonly history: HeldHistory;
  readonly basis: string;
}

/** A stack that failed in its cover. `reread` is the index token of a failed re-read of an open stack: a newer index reads it again. */
interface CoverFailure { readonly error: string; readonly reread: string | null }

interface Transaction {
  readonly id: TransactionId;
  readonly cause: SceneCause;
  readonly scope: SceneScope;
  readonly controller: AbortController;
  phase: "operating" | "stabilising" | "preparing" | "done";
  /** Offers now belong to this transaction (its own writes, or a `derive`). */
  owned: number;
  wake: AbortController | null;
  status: TransactionStatus;
  intent: SceneIntent | null;
  error: string | null;
  /** The publication this transaction committed, if any. */
  publication: Publication | null;
  /** Requested reveals: a cover that failed during this transaction, with its error. */
  readonly coverErrors: Map<GraphId, string>;
  /** The worker layout it is waiting for, by layout basis, with the job's own abort. */
  layout: { readonly key: string; readonly promise: Promise<FolderLayout>; readonly job: AbortController } | null;
}

export function createSceneController(options: SceneControllerOptions) {
  const source = options.data;
  const engine = options.engine ?? memoizeEngine(engines.default);
  const inline = options.inline ?? (() => true);
  const tick = options.tick ?? svelteTick;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => { const handle = setTimeout(run, ms); return () => clearTimeout(handle); });
  const deadline = options.deadline ?? PREPARATION_DEADLINE_MS;
  const runLayout = options.runLayout ?? ((input: FolderLayoutInput) => Promise.resolve(engine(input)));

  let published = $state.raw<Publication | null>(null);
  let transactionState = $state.raw<SceneTransaction | null>(null);
  let notices = $state.raw<ReadonlyMap<GraphId, PreparationNotice>>(new Map());
  let failure = $state.raw<string | null>(null);

  let disposed = false;
  let scope: SceneScope = { paneId: options.paneId, directory: "", generation: 0 };
  let intent: SceneIntent | null = null;
  let data: DataMark = { index: null, components: new Map() };
  let revision = 0;
  let ids = 0;
  let geometryVersion = 0;
  let current: Transaction | null = null;
  /** The action whose operation is running synchronously; nested actions reuse its lease. */
  let operating: Transaction | null = null;
  let committed: Committed | null = null;
  let motion: SceneMotion | null = null;
  /** A publication rendered but whose motion has not started yet. */
  let presenting: TransactionId | null = null;
  let afterPresentation: (() => void)[] = [];
  let motionSettled: Promise<void> = Promise.resolve();
  let motionIdle = true;
  /** Presentation epochs: one per geometry publication. */
  let epochs = 0;
  let startedEpoch = 0;
  const presentedListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  /** Recent transactions by id, for reveal waits. */
  const recent = new Map<TransactionId, Transaction>();
  /** Failed covers by the stable key they failed under. */
  const failed = new Map<string, CoverFailure>();
  /** Running cover deadlines. */
  const deadlines = new Map<GraphId, () => void>();
  /** Component leases by `token\0componentId`. */
  const leases = new Map<string, { readonly id: string; readonly token: string; readonly lease: ComponentLease; readonly results: Promise<ReadonlyMap<string, ComponentData>>; settled: boolean }>();

  const notify = () => { for (const listener of [...changeListeners]) listener(); };
  const event = (tx: { id: TransactionId }, keys: readonly string[] = []): SceneEvent =>
    ({ transaction: tx.id, scope: scope.directory, geometryVersion: published?.geometryVersion ?? 0, requestKeys: keys });
  const graphKeys = (scene: FolderScene | null) => scene ? [...scene.graphs.keys()].sort() : [];

  function publishState(tx: Transaction): void {
    if (current !== tx) return;
    transactionState = { id: tx.id, scope: tx.scope, intent: tx.intent, cause: tx.cause, status: tx.status, pending: new Set(deadlines.keys()), error: tx.error };
  }

  // ── Covers: pending deadlines, failures and notices ────────────────────────
  const committedOpen = (): ReadonlySet<GraphId> => new Set(published?.scene.graphs.keys() ?? []);
  const isBlocking = (failure: CoverFailure, index: FolderIndex | null) => failure.reread === null || failure.reread === (index?.token ?? null);
  function blocked(index: FolderIndex): ReadonlySet<GraphId> {
    const keys = new Set<GraphId>();
    for (const [key, failure] of failed) if (isBlocking(failure, index)) keys.add(resolveCover(index, key) ?? key);
    return keys;
  }
  /** Failures recorded for `cover` (under any key that resolves to it). */
  const failuresOf = (cover: GraphId, index: FolderIndex | null) => [...failed].filter(([key]) => key === cover || (!!index && resolveCover(index, key) === cover));
  /** Whether the published scene draws `cover` open from current data for `index`. */
  function openOnCurrentData(cover: GraphId, index: FolderIndex): boolean {
    const graph = published?.scene.graphs.get(cover);
    const summary = graph && index.components.find((candidate) => candidate.coverKey === cover);
    return !!summary && graph.componentId === summary.id && fresh(committed?.data.components.get(summary.id), index, (other) => source.isStale(other), summary.id);
  }

  function refreshNotices(): void {
    const next = new Map<GraphId, PreparationNotice>();
    const id = current?.id ?? 0;
    // Reading an open stack again (a new index) is silent: the committed band stays as drawn.
    const open = committedOpen();
    for (const cover of deadlines.keys()) if (!open.has(cover)) next.set(cover, { transactionId: id, coverKey: cover, phase: current?.status === "preparing-layout" ? "arranging" : "loading", message: null });
    const index = data.index;
    for (const [key, failure] of failed) {
      if (!isBlocking(failure, index)) continue;
      const cover = index ? resolveCover(index, key) ?? key : key;
      next.set(cover, { transactionId: id, coverKey: cover, phase: "failed", message: failure.error });
    }
    const same = next.size === notices.size && [...next].every(([key, notice]) => {
      const was = notices.get(key);
      return was && was.phase === notice.phase && was.message === notice.message;
    });
    if (!same) notices = next;
  }

  /**
   * Starts deadlines for newly pending covers (requested, not blocked, and not drawn open from
   * current data), stops them for covers that opened or closed, forgets failures of closed covers
   * and of covers that reopened.
   */
  function reconcileCovers(): void {
    // An index of another folder (the pane moved on, its index not read yet) has no covers here.
    const index = data.index && data.index.directory === intent?.directory ? data.index : null;
    const requested = intent?.open ?? new Set<GraphId>();
    if (index) for (const key of [...failed.keys()]) {
      const cover = resolveCover(index, key) ?? key;
      if (!requested.has(cover) || openOnCurrentData(cover, index)) failed.delete(key);
    }
    const stops = new Set(index?.components.map((summary) => summary.coverKey) ?? []);
    const skip = index ? blocked(index) : new Set<GraphId>();
    const pending = new Set([...requested].filter((key) => stops.has(key) && !skip.has(key) && !openOnCurrentData(key, index!)));
    for (const [cover, cancel] of deadlines) if (!pending.has(cover)) { cancel(); deadlines.delete(cover); }
    for (const cover of pending) if (!deadlines.has(cover)) deadlines.set(cover, setTimer(() => coverFailed(cover, "Trace took too long to load this stack"), deadline));
    refreshNotices();
  }

  /**
   * A requested stack failed (its read failed or its deadline passed): it is laid out closed with
   * its error, and the transaction preparing commits everything else. A stack drawn open, or one
   * whose failed re-read is being retried, failed a re-read: a newer index reads it again.
   */
  function coverFailed(cover: GraphId, error: string): void {
    if (disposed) return;
    deadlines.get(cover)?.();
    deadlines.delete(cover);
    const index = data.index;
    const previous = failuresOf(cover, index);
    const wasOpen = committedOpen().has(cover);
    const reread = wasOpen || previous.some(([, failure]) => failure.reread !== null) ? index?.token ?? null : null;
    for (const [key] of previous) failed.delete(key);
    failed.set(cover, { error, reread });
    const tx = current;
    if (tx && tx.phase !== "done") {
      tx.coverErrors.set(cover, error);
      tx.wake?.abort();
    }
    sceneInstrumentation.failure({ ...event(tx ?? { id: 0 }, [cover]), message: error });
    reconcileLeases(new Map(), true);
    refreshNotices();
    notify();
    // Nothing is preparing: a stack still drawn open must be drawn closed with its error.
    if (wasOpen && (!tx || tx.phase === "done") && intent) void run(begin({ kind: "refresh", target: null, anchor: "none" }));
  }

  // ── Data leases ────────────────────────────────────────────────────────────
  /**
   * Keeps one lease per component the desired scene still needs under the current token (`needed`),
   * releasing the others. With `pruneOnly`, only releases leases no longer needed by the intent.
   */
  function reconcileLeases(needed: ReadonlyMap<GraphId, string>, pruneOnly = false): void {
    const index = data.index;
    const wanted = new Set(needed.values());
    if (pruneOnly && index && intent) {
      const skip = blocked(index);
      for (const summary of index.components) if (intent.open.has(summary.coverKey) && !skip.has(summary.coverKey)) wanted.add(summary.id);
    }
    const isFresh = (id: string) => !!index && fresh(source.components.get(id), index, (other) => source.isStale(other), id);
    // A settled lease whose data is no longer fresh (a same-token refresh outdated it) is read again.
    for (const [key, held] of leases) if (!index || held.token !== index.token || !wanted.has(held.id) || (held.settled && !isFresh(held.id))) { held.lease.release(); leases.delete(key); }
    if (pruneOnly || !index) return;
    for (const id of wanted) {
      const key = `${index.token}\0${id}`;
      if (leases.has(key) || isFresh(id)) continue;
      const lease = source.acquireComponents([id], index.token);
      const entry = { id, token: index.token, lease, results: lease.results, settled: false };
      // A failed lease is dropped so the next attempt (Retry, reopening) reads again.
      lease.results.then(() => { entry.settled = true; }, () => { entry.settled = true; if (leases.get(key) === entry) leases.delete(key); });
      leases.set(key, entry);
    }
  }

  function releaseLeases(): void {
    for (const held of leases.values()) held.lease.release();
    leases.clear();
  }

  // ── Transactions ───────────────────────────────────────────────────────────
  function finish(tx: Transaction, status: TransactionStatus, error: string | null = null): void {
    if (tx.phase === "done") return;
    tx.phase = "done";
    tx.status = status;
    tx.error = error ?? tx.error;
    tx.wake = null;
    publishState(tx);
    if (status === "superseded") tx.controller.abort(superseded());
    notify();
  }

  function begin(cause: SceneCause): Transaction {
    const previous = current;
    const tx: Transaction = { id: ++ids, cause, scope, controller: new AbortController(), phase: "operating", owned: 0, wake: null, status: "collecting",
      intent: null, error: null, publication: null, coverErrors: new Map(), layout: null };
    current = tx;
    recent.set(tx.id, tx);
    for (const id of recent.keys()) if (recent.size > 64) recent.delete(id); else break;
    if (previous && previous.phase !== "done") finish(previous, "superseded");
    sceneInstrumentation.actionBegin(event(tx));
    publishState(tx);
    return tx;
  }

  const live = (tx: Transaction) => !disposed && current === tx && tx.phase !== "done" && tx.scope === scope;

  /** Offers until the next tick belong to `tx`. */
  function own(tx: Transaction): void {
    tx.owned++;
    void tick().then(() => { tx.owned--; });
  }

  function lease(tx: Transaction): ActionLease {
    return {
      id: tx.id,
      signal: tx.controller.signal,
      isCurrent: () => !tx.controller.signal.aborted && current === tx,
      derive: <T>(write: () => T): T => {
        if (current === tx && tx.phase !== "done") own(tx);
        return write();
      },
    };
  }

  function rootCause(change: IntentChange, before: SceneIntent | null, after: SceneIntent, tokenChanged: boolean): SceneCause {
    const target = after.focus?.key ?? null;
    if (change.directory || !before) return { kind: "startup", target: null, anchor: "none" };
    if (change.hostChoice) return { kind: "selection", target, anchor: "none" };
    if (change.listing) return { kind: "listing", target: null, anchor: "none" };
    if (change.resize) return { kind: "resize", target: null, anchor: "none" };
    if (change.metrics) return { kind: "metrics", target: null, anchor: "none" };
    if (tokenChanged) return { kind: "refresh", target: null, anchor: "none" };
    if (change.other) {
      const grew = [...after.open].some((key) => !before.open.has(key)), shrank = [...before.open].some((key) => !after.open.has(key));
      return { kind: grew ? "expand" : shrank ? "collapse" : "selection", target, anchor: "none" };
    }
    return { kind: "refresh", target: null, anchor: "none" };
  }

  /** Stabilises the intent, then prepares and commits. */
  async function run(tx: Transaction): Promise<void> {
    tx.phase = "stabilising";
    for (let i = 0; i < STABILISE_TICKS; i++) {
      const seen = revision;
      await tick();
      if (!live(tx)) return;
      if (seen === revision) break;
    }
    tx.phase = "preparing";
    const release = options.holdWork?.() ?? (() => {});
    try { await prepare(tx); }
    catch (error) { if (live(tx)) { finish(tx, "failed", message(error)); failure = message(error); sceneInstrumentation.failure({ ...event(tx), message: message(error) }); } }
    finally { dropLayout(tx); release(); }
  }

  /** Aborts the worker layout `tx` asked for: it is no longer the one that will commit. */
  function dropLayout(tx: Transaction): void {
    tx.layout?.job.abort(superseded());
    tx.layout = null;
  }

  async function prepare(tx: Transaction): Promise<void> {
    let restarts = 0, rounds = 0;
    for (;;) {
      if (!live(tx)) return;
      // Every round awaits new data, a wake-up or a restart; a bound turns a logic error into a failure, not a spin.
      if (++rounds > 1000) throw new Error("Trace could not prepare this folder");
      const wake = tx.wake = new AbortController();
      const waiting = AbortSignal.any([tx.controller.signal, wake.signal]);
      const wanted = intent, index = data.index;
      tx.intent = wanted;
      if (!wanted || wanted.width <= 0 || !index || index.directory !== wanted.directory) { finish(tx, "committed"); return; }
      reconcileCovers();
      const skip = blocked(index);
      const { cells } = folderItems(wanted.listing, index, wanted.claimed, new Set());
      const required = requiredComponents(cells, wanted.open, skip);
      reconcileLeases(required);
      const isFresh = (id: string) => fresh(source.components.get(id), index, (other) => source.isStale(other), id);
      const missing = [...required].filter(([, id]) => !isFresh(id));
      let sceneData: SceneData, open: ReadonlyMap<GraphId, string>, sceneIntent = wanted, continuation = false;
      if (!missing.length) {
        sceneData = { index, components: new Map([...required.values()].map((id) => [id, source.components.get(id)!])) };
        open = required;
      } else if (HOT.has(tx.cause.kind) && committed && hotAllowed(wanted)) {
        // Interaction while data is revalidated: the last committed coherent snapshot, never mixed with the new index.
        const base = committed.data;
        sceneIntent = { ...wanted, listing: committed.intent.listing, claimed: committed.intent.claimed };
        const baseCells = folderItems(sceneIntent.listing, base.index, sceneIntent.claimed, new Set()).cells;
        const components = new Map(base.components);
        for (const [, id] of requiredComponents(baseCells, wanted.open, blocked(base.index))) {
          const loaded = source.components.get(id);
          if (!components.has(id) && fresh(loaded, base.index, (other) => source.isStale(other), id)) components.set(id, loaded);
        }
        open = new Map([...requiredComponents(baseCells, wanted.open, blocked(base.index))].filter(([, id]) => components.has(id)));
        sceneData = { index: base.index, components };
        continuation = true;
      } else {
        // A layout of the scene without this data is not the one that will commit.
        dropLayout(tx);
        tx.status = "preparing-data";
        publishState(tx);
        refreshNotices();
        const pending = missing.map(([cover, id]) => {
          const held = leases.get(`${index.token}\0${id}`);
          return held ? held.results.catch((error) => { throw Object.assign(new Error(message(error)), { cover, cause: error }); }) : Promise.resolve(new Map());
        });
        try { await abortable(Promise.all(pending), waiting); }
        catch (error) {
          if (!live(tx)) return;
          if (wake.signal.aborted) continue;
          const cause = (error as { cause?: unknown }).cause ?? error;
          if (cause instanceof StaleComponentsError || isAbort(cause)) {
            if (++restarts > MAX_RESTARTS) throw new Error("Trace kept changing while it was loading");
            continue;
          }
          // One unreadable stack fails in its cover, whether it was opening or already open; the rest commits.
          const cover = (error as { cover?: GraphId }).cover;
          if (cover !== undefined) { coverFailed(cover, message(cause)); continue; }
          throw cause;
        }
        continue;
      }

      const prepared = prepareLayoutInput(sceneIntent, sceneData, open, committed?.history ?? null, published?.scene.layout ?? null, source.components);
      if (tx.layout?.key !== prepared.basis) dropLayout(tx);
      let layout: FolderLayout;
      if (published && committed && prepared.basis === committed.basis) layout = published.scene.layout;
      else if (inline(prepared.input)) layout = engine(prepared.input);
      else {
        tx.status = "preparing-layout";
        publishState(tx);
        refreshNotices();
        if (!tx.layout) {
          // Its own signal: aborted by supersession, and by a deadline or new data that changes what is laid out.
          const job = new AbortController();
          const promise = runLayout(prepared.input, AbortSignal.any([tx.controller.signal, job.signal]));
          promise.then((computed) => options.remember?.(computed), noop);
          tx.layout = { key: prepared.basis, promise, job };
        }
        try { layout = await abortable(tx.layout.promise, waiting); }
        catch (error) {
          if (!live(tx)) return;
          if (wake.signal.aborted) continue;
          throw error;
        }
        if (!live(tx)) return;
      }
      tx.status = "ready";
      const scene = buildFolderScene({ scope, layoutInput: prepared.input, layout, sources: prepared.sources, styling: stylingOf(sceneIntent), coverNodes: prepared.coverNodes });
      commit(tx, scene, { intent: sceneIntent, data: sceneData, history: prepared.history, basis: prepared.basis });
      // A scene of the current data supersedes whatever failed before it; one on the older snapshot does not.
      if (!continuation) failure = null;
      if (continuation && !disposed && current === tx) {
        const next = begin({ kind: data.index && committed && data.index.token !== committed.data.index.token ? "refresh" : "expand", target: null, anchor: "none" });
        void run(next);
      }
      return;
    }
  }

  /** A hot action may use the committed snapshot only when its target is in that snapshot. */
  function hotAllowed(wanted: SceneIntent): boolean {
    if (!committed || committed.intent.directory !== wanted.directory) return false;
    const focus = wanted.focus?.key;
    if (!focus) return true;
    if (published?.scene.navigation.has(focus)) return true;
    return [...committed.data.components.values()].some((component) => component.dag.nodes.has(focus))
      || [...committed.data.index.members.values()].some((member) => member.key === focus);
  }

  /** Whether `next` would draw or classify differently from the published scene. */
  function differs(previous: Publication | null, next: FolderScene, diff: SceneDiff): boolean {
    if (!previous || diff.policy.reset || diff.enter.size || diff.exit.size || diff.update.size) return true;
    if (previous.scene.layout !== next.layout || !sameStyling(previous.scene.inputs.styling, next.inputs.styling)) return true;
    for (const [id, graph] of next.graphs) if (previous.scene.graphs.get(id)?.data !== graph.data) return true;
    return false;
  }

  /** Continues from what `driver` displays: only records near the viewport, chosen or still moving take part. */
  function retarget(driver: SceneMotion, from: Presentation, scene: FolderScene, diff: SceneDiff, transaction: TransactionId): Presentation {
    const displayed = driver.sample(from);
    const records = motionParticipants({ next: scene, displayed, viewport: driver.viewport?.() ?? null });
    return retargetPresentation(displayed, scene, diff, { transaction, epoch: ++epochs, reduced: driver.reduced(), records });
  }

  function commit(tx: Transaction, scene: FolderScene, snapshot: Committed): void {
    const previous = published;
    const diff = diffScenes(previous?.scene ?? null, scene);
    committed = snapshot;
    if (!differs(previous, scene, diff)) { finish(tx, "committed"); reconcileCovers(); return; }
    const geometry = diff.policy.reset || diff.enter.size > 0 || diff.exit.size > 0 || [...diff.policy.records.values()].some((policy) => policy !== "carry");
    // Geometry continues from what is displayed; a restyle keeps the running epoch (tracks and retirees).
    const presentation = !geometry && previous ? restylePresentation(previous.presentation, scene)
      : diff.policy.reset || !previous || !motion ? staticPresentation(scene, ++epochs)
      : retarget(motion, previous.presentation, scene, diff, tx.id);
    const publication: Publication = { transactionId: tx.id, geometryVersion: geometry ? ++geometryVersion : previous?.geometryVersion ?? geometryVersion, scene, presentation };
    published = publication;
    tx.publication = publication;
    if (geometry) sceneInstrumentation.geometryPublication(event(tx, graphKeys(scene)));
    presenting = tx.id;
    finish(tx, "committed");
    reconcileCovers();
    const lifetime = scope;
    void tick().then(() => {
      if (disposed || lifetime !== scope || published !== publication) return;
      // An epoch starts once, after its first publication rendered (a restyle committed in the same
      // turn carries it, so it starts the epoch instead).
      if (motion && presentation.epoch !== startedEpoch) {
        startedEpoch = presentation.epoch;
        if (diff.policy.reset) motion.snap();
        const { started, settled } = motion.start(presentation);
        if (started) sceneInstrumentation.motionStart(event(tx, graphKeys(scene)));
        motionIdle = false;
        const mine = motionSettled = settled.then(() => undefined, () => undefined);
        void settled.then((finished) => {
          if (motionSettled !== mine || disposed || lifetime !== scope) return;
          motionIdle = true;
          // The epoch is over: present the same scene settled (retirees gone, every record at its target).
          if (finished && published?.presentation.epoch === presentation.epoch) {
            if (published.presentation.duration > 0) published = { ...published, presentation: settledPresentation(published.presentation) };
            sceneInstrumentation.settled(event(tx, graphKeys(scene)));
          }
          notify();
        }, () => undefined);
      }
      presenting = null;
      const queued = afterPresentation;
      afterPresentation = [];
      for (const run of queued) run();
      for (const listener of [...presentedListeners]) listener();
      notify();
    });
  }

  function resetScope(directory: string): void {
    scope = { paneId: options.paneId, directory, generation: scope.generation + 1 };
    if (current && current.phase !== "done") finish(current, "superseded");
    current = null;
    published = null;
    committed = null;
    presenting = null;
    afterPresentation = [];
    failure = null;
    failed.clear();
    for (const cancel of deadlines.values()) cancel();
    deadlines.clear();
    releaseLeases();
    motion?.snap();
    motionIdle = true;
    motionSettled = Promise.resolve();
    transactionState = null;
    refreshNotices();
    notify();
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    /** The only drawable state: the complete committed scene, or null before the first commit. */
    get published() { return published; },
    /** The newest transaction's progress (never drawable). */
    get transaction() { return transactionState; },
    /** Cover progress and failures, by cover key (never drawable geometry). */
    get notices() { return notices; },
    /** A view-level failure (a refresh that could not be prepared); the last scene stays. */
    get failure() { return failure; },
    /** The index the published scene was built from (for interaction rules that must match what is drawn). */
    get committedIndex(): FolderIndex | null { return committed?.data.index ?? null; },

    /**
     * The one intake: the pane's current intent and data revision. Contents are compared, not
     * object identity. A change during a stabilising or owned transaction belongs to it; a host
     * selection, listing, size or index change otherwise starts a root transaction.
     */
    offer(next: SceneIntent, mark: DataMark): void {
      if (disposed) return;
      const before = intent;
      if (before && before.directory !== next.directory) resetScope(next.directory);
      else if (!before) scope = { ...scope, directory: next.directory, generation: scope.generation + 1 };
      const change = intentChange(intent && intent.directory === next.directory ? intent : null, next);
      const dataChanged = mark.index !== data.index || mark.components !== data.components;
      const tokenChanged = (mark.index?.token ?? null) !== (data.index?.token ?? null);
      if (!anyChange(change) && !dataChanged) return;
      intent = next;
      data = mark;
      revision++;
      reconcileCovers();
      const tx = current;
      if (tx && tx.phase !== "done" && tx.scope === scope && !change.directory) {
        // Its own writes, a derive, or anything before its intent is captured: the same transaction.
        if (tx.phase === "stabilising" || tx.owned > 0) { tx.wake?.abort(); return; }
        // A newer host choice supersedes the action, even one still awaiting its operation.
        const root = change.hostChoice || (tx.phase === "preparing" && (change.listing || change.resize || change.metrics));
        if (!root) { tx.wake?.abort(); return; }
      }
      void run(begin(rootCause(change, before && before.directory === next.directory ? before : null, next, tokenChanged)));
    },

    /**
     * Runs one interaction. The lease begins before any host write or await; nested actions reuse
     * it. After the operation (and its promise) finishes, the intent is stabilised over `tick()`s,
     * then prepared and committed once.
     *
     * An operation that throws fails the transaction with its error (rethrown to the caller); what
     * it wrote before throwing commits in a transaction of its own. An operation still pending
     * after the preparation deadline stops holding the scene: the transaction prepares the
     * current intent, and the operation's later writes are changes of their own.
     */
    action<T>(cause: SceneCause, operation: (lease: ActionLease) => T): T {
      if (operating && current === operating) return operation(lease(operating));
      const tx = begin(cause);
      const seen = revision;
      operating = tx;
      own(tx);
      let result: T;
      try { result = operation(lease(tx)); }
      catch (error) {
        operating = null;
        if (live(tx)) {
          finish(tx, "failed", message(error));
          sceneInstrumentation.failure({ ...event(tx), message: message(error) });
          if (revision !== seen) void run(begin(cause));
        }
        throw error;
      }
      operating = null;
      void (async () => {
        if (thenable(result)) {
          let stop: () => void = noop;
          const bound = new Promise<void>((resolve) => { stop = setTimer(resolve, deadline); });
          // A rejection is the operation's own to report; the scene still commits what it wrote.
          await Promise.race([Promise.resolve(result).then(noop, noop), bound]);
          stop();
        }
        if (live(tx)) await run(tx);
      })();
      return result;
    },

    /** A derived write outside an action (an effect): it belongs to the transaction in progress. */
    derive<T>(write: () => T): T {
      if (current && current.phase !== "done") own(current);
      return write();
    },

    /** Forgets a failed cover so it may open again; returns its cover key in the current index. */
    clearFailure(key: string): GraphId | null {
      const index = data.index;
      const cover = index ? resolveCover(index, key) : key;
      for (const failedKey of [...failed.keys()]) if (failedKey === key || (index && resolveCover(index, failedKey) === cover)) failed.delete(failedKey);
      reconcileCovers();
      return cover;
    },

    /**
     * Resolves once transaction `id` has finished and its scene (or the scene it left in place) is
     * presented with `key` in it. Rejects at once when the transaction is superseded or fails, or
     * when `key` is not shown.
     */
    whenPresented(id: TransactionId, key: NodeKey, signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const stop = () => { changeListeners.delete(check); signal?.removeEventListener("abort", check); };
        function check(): void {
          if (signal?.aborted) { stop(); reject(signal.reason); return; }
          const tx = recent.get(id);
          if (!tx || tx.scope !== scope) { stop(); reject(superseded()); return; }
          if (tx.status === "superseded") { stop(); reject(superseded()); return; }
          if (tx.phase !== "done" || presenting !== null) return;
          stop();
          if (published && presents(published.scene, key)) { resolve(); return; }
          const coverError = [...tx.coverErrors.values()].at(-1);
          if (tx.status === "failed" || coverError) reject(new Error(tx.error ?? coverError ?? "Trace image could not be shown"));
          else reject(new Error("Trace image could not be shown"));
        }
        changeListeners.add(check);
        signal?.addEventListener("abort", check, { once: true });
        check();
      });
    },

    /** Resolves once transaction `id` is presented and the motion it left running has settled. */
    whenSettled(id: TransactionId, signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const stop = () => { changeListeners.delete(check); signal?.removeEventListener("abort", check); };
        function check(): void {
          if (signal?.aborted) { stop(); reject(signal.reason); return; }
          const tx = recent.get(id);
          if (!tx || tx.scope !== scope || tx.status === "superseded") { stop(); reject(superseded()); return; }
          if (tx.status === "failed") { stop(); reject(new Error(tx.error ?? "Trace scene failed")); return; }
          if (tx.phase !== "done" || presenting !== null || !motionIdle) return;
          stop();
          resolve();
        }
        changeListeners.add(check);
        signal?.addEventListener("abort", check, { once: true });
        check();
      });
    },

    /** Runs `fn` after the rendered publication's motion has started (now, when none is pending). */
    afterPresentation(fn: () => void): void {
      if (presenting === null) fn(); else afterPresentation.push(fn);
    },
    /** Called after every publication's motion setup (once per publication). */
    onPresented(listener: () => void): () => void {
      presentedListeners.add(listener);
      return () => presentedListeners.delete(listener);
    },
    /** The renderer's native motion; one at a time. */
    attachMotion(adapter: SceneMotion): () => void {
      // A presentation whose epoch no driver runs is shown settled.
      const settle = () => {
        if (published && published.presentation.duration > 0) published = { ...published, presentation: settledPresentation(published.presentation) };
        startedEpoch = published?.presentation.epoch ?? startedEpoch;
        motionIdle = true;
        motionSettled = Promise.resolve();
        notify();
      };
      motion?.snap();
      motion = adapter;
      settle();
      return () => { if (motion === adapter) { adapter.snap(); motion = null; settle(); } };
    },
    /** Clears a view-level failure (the caller retries the refresh). */
    clearViewFailure(): void { failure = null; },
    dispose(): void {
      if (disposed) return;
      resetScope("");
      disposed = true;
      changeListeners.clear();
      presentedListeners.clear();
    },
  };
}

export type SceneController = ReturnType<typeof createSceneController>;
