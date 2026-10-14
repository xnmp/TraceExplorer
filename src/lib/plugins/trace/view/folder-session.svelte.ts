/**
 * Pane-owned Trace data for one folder: component summaries first, members
 * (Explorer path → node) next, and a component's nodes only when it is shown.
 * Every load is tagged with a generation; results for an older directory or
 * index are discarded. Refreshes keep the previous data visible until the new
 * index arrives, so graph views never flash empty. A new session for a folder
 * another session already loaded starts from that data and revalidates it, so
 * returning to a Trace tab never shows "Loading Trace…" again.
 */
import type { ComponentSummary, TraceNode } from "$lib/domain/trace-graph/model";
import { matchesIndex, type ComponentData, type FolderIndex, type Member } from "$lib/domain/trace-graph/folder-data";
import type { OrientationHistory } from "$lib/domain/trace-graph/orientation";
import { projectDag } from "$lib/domain/trace-graph/projection";
import { traceBackend, type TraceBackend } from "./backend";
import { createSnapshotCache, type SnapshotCache } from "./folder-snapshots";
import { sceneSnapshots } from "./scene-snapshots";
import { componentRequest } from "./component-requests";
import { parentDir, samePath } from "$lib/domain/path";
import { coverAliases, coverIdentity, forgetOpenStack, stackIdentity, pathIdentity, revisionIdentity, resolveOpenStacks } from "./open-stacks";

export type { ComponentData, FolderIndex, Member };

/** The session's index no longer carries the token a read was requested under. */
export class StaleComponentsError extends Error {
  constructor(message = "Trace changed while its components were loading") { super(message); this.name = "StaleComponentsError"; }
}

/** A cancellable claim on complete component data; see `acquireComponents`. */
export interface ComponentLease {
  /** Fresh, complete data for every requested id (in request order, duplicates collapsed), all read under the requested token. */
  readonly results: Promise<ReadonlyMap<string, ComponentData>>;
  /** Withdraws interest. Reads nobody else wants are aborted; pending `results` reject. Idempotent. */
  release(): void;
}

/** Strictly increasing across every session, so a version identifies one replacement of one component. */
let componentVersion = 0;

/** Rejects with the signal's reason as soon as it aborts, without waiting for `promise`. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Restarts tolerated while the journal keeps changing under a paged load. */
const MAX_RETRIES = 3;

export type SessionStatus = "idle" | "loading" | "ready" | "error";

/** Shared folder data, with each pane's expansion and selection history kept separately. */
export interface FolderSnapshot {
  readonly index: FolderIndex;
  readonly components: ReadonlyMap<string, ComponentData>;
  readonly stale: ReadonlySet<string>;
  readonly orientations: ReadonlyMap<string, OrientationHistory>;
  readonly panes: ReadonlyMap<string, PaneFolderSnapshot>;
}
interface PaneFolderSnapshot {
  readonly openCovers: ReadonlySet<string>;
  readonly openOwners: ReadonlyMap<string, string>;
  readonly selectionChoice: string;
  readonly selectionCovers: ReadonlySet<string>;
}
const emptyPaneSnapshot = (): PaneFolderSnapshot => ({ openCovers: new Set(), openOwners: new Map(), selectionChoice: "", selectionCovers: new Set() });
/** Members and nodes a snapshot holds, which bound the cache's memory. */
export const snapshotWeight = (snapshot: FolderSnapshot): number =>
  snapshot.index.members.size + [...snapshot.components.values()].reduce((sum, data) => sum + data.nodes.length, 0)
  + [...(snapshot.panes?.values() ?? [])].reduce((sum, pane) => sum + pane.openCovers.size + pane.openOwners.size + pane.selectionCovers.size, 0);
/** Shared by every session, so a remounted view finds what the previous one loaded. */
const folderSnapshots = createSnapshotCache<FolderSnapshot>({ limit: 8, budget: 200_000, weigh: snapshotWeight });
/** Forgets every folder's data, when the plugin is disabled. */
export function forgetFolderSnapshots(): void { folderSnapshots.clear(); sceneSnapshots.clear(); }

export function createFolderSession(backend: TraceBackend = traceBackend, snapshots: SnapshotCache<FolderSnapshot> = folderSnapshots, paneId = "") {
  let index = $state.raw<FolderIndex | null>(null);
  let status = $state<SessionStatus>("idle");
  let indexError = $state("");
  let componentErrors = $state.raw<ReadonlyMap<string, string>>(new Map());
  const error = $derived(indexError || [...componentErrors.values()].join("\n"));
  let components = $state.raw<ReadonlyMap<string, ComponentData>>(new Map());
  let directory: string | null = null;
  let started = false;
  let generation = 0;
  let disposed = false;
  const loading = new Map<string, Promise<ComponentData | null>>();
  const loadControllers = new Map<string, { id: string; controller: AbortController }>();
  /** Reveals survive index refreshes, but never a directory change or disposal. */
  let lifetime = new AbortController();
  /** Who wants which components: the view's own (ensure/release, per id) and leases (one per acquireComponents). */
  let viewInterest = new Set<string>();
  const leaseInterests = new Set<ReadonlySet<string>>();
  const isWanted = (id: string) => viewInterest.has(id) || [...leaseInterests].some((ids) => ids.has(id));
  const wantedIds = (): Set<string> => new Set([...viewInterest, ...[...leaseInterests].flatMap((ids) => [...ids])]);
  /** Aborts reads nobody wants any more; a replacement request for the same id starts a fresh read. */
  function dropUnwanted(ids: Iterable<string>): void {
    for (const id of ids) {
      if (isWanted(id)) continue;
      for (const [key, read] of loadControllers) if (read.id === id) { read.controller.abort(); loadControllers.delete(key); loading.delete(key); }
    }
  }
  /** Loaded data predating the index: stays visible until its fresh load completes. */
  let stale = $state.raw<ReadonlySet<string>>(new Set());
  /** Displayed orientations by component and tile width: hysteresis that survives collapse and remount. */
  let orientations = $state.raw(new Map<string, OrientationHistory>());
  let paneState = $state.raw<PaneFolderSnapshot>(emptyPaneSnapshot());
  const stackMembership = $derived.by(() => {
    const available = (node: TraceNode) => !node.discarded && node.state !== "missing" && !node.referenceBadge;
    // A stack is identified by its cover's revision while it has anything present to show, even when
    // the cover image itself is gone: its surviving edits must stay openable.
    const listed = new Set([...(index?.members.values() ?? [])].map((member) => member.componentId));
    const identities = new Map((index?.components ?? []).map((summary) => {
      const data = !stale.has(summary.id) ? components.get(summary.id) : undefined;
      const present = !data || data.nodes.some(available) || listed.has(summary.id);
      return [summary.id, new Set<string>(present ? [revisionIdentity(summary.coverKey)] : [])];
    }));
    for (const [path, member] of index?.members ?? []) {
      identities.get(member.componentId)?.add(pathIdentity(path));
      identities.get(member.componentId)?.add(revisionIdentity(member.key));
    }
    for (const [id, data] of components) if (!stale.has(id)) for (const node of data.nodes) {
      if (!available(node)) continue;
      identities.get(id)?.add(revisionIdentity(node.key));
      if (node.path && !node.earlierRevision) identities.get(id)?.add(pathIdentity(node.path));
    }
    return (index?.components ?? []).map((summary) => ({ coverKey: summary.coverKey, coverIdentity: stackIdentity(summary), aliases: coverAliases(summary, index!.members), identities: identities.get(summary.id)! }));
  });
  const openStacks = $derived(resolveOpenStacks(paneState.openCovers, stackMembership, paneState.openOwners));
  /** Same identity while the open set's contents are unchanged, so consumers (the grid's motion capture) do not re-run on a no-op rewrite of the pane state. */
  let stableOpen: ReadonlySet<string> = new Set();
  const openStackKeys = $derived.by(() => {
    const next = openStacks.open;
    return next.size === stableOpen.size && [...next].every((key) => stableOpen.has(key)) ? stableOpen : (stableOpen = next);
  });
  const openStackSearch = $derived(new Set(index && [...openStacks.unresolved].some((key) =>
    !(key.startsWith("path:") && samePath(parentDir(key.slice(5)), index!.directory)))
    ? index.components.filter((summary) => !components.has(summary.id) || stale.has(summary.id)).map((summary) => summary.id) : []));
  /** Writes stop once the cache is cleared (the plugin was disabled) after this session began. */
  const epoch = snapshots.epoch;

  function cancelLoads(): void {
    for (const { controller } of loadControllers.values()) controller.abort();
    loadControllers.clear();
    loading.clear();
  }

  /** A successful load resolves only its own error; removed components have no unresolved load. */
  function retainErrors(ids: ReadonlySet<string>): void {
    componentErrors = new Map([...componentErrors].filter(([id]) => ids.has(id)));
  }

  /** Keeps what this folder now shows for the next session that opens it. */
  function remember(): void {
    if (disposed || snapshots.epoch !== epoch || !index || index.directory !== directory) return;
    const prior = snapshots.recall(index.directory);
    // Another pane on the same folder state may have loaded components this one has not: keep them.
    const merge = prior && prior.index.token === index.token;
    snapshots.remember(index.directory, {
      index,
      components: merge ? new Map([...prior.components, ...components]) : components,
      stale: merge ? new Set([...[...prior.stale].filter((id) => !components.has(id)), ...stale]) : stale,
      orientations,
      panes: new Map(prior?.panes).set(paneId, paneState),
    });
  }

  /** Retain missing covers; only unlisted identities need fresh node pages to resolve. */
  function reconcileOpenStacks(): void {
    if (!index) return;
    const resolved = openStacks;
    const pending = [...resolved.unresolved].filter((key) =>
      !(key.startsWith("path:") && samePath(parentDir(key.slice(5)), index!.directory)));
    const unread = index.components.filter((summary) => !components.has(summary.id) || stale.has(summary.id));
    paneState = { ...paneState, openCovers: resolved.remembered, openOwners: resolved.owners };
    remember();
    if (pending.length) for (const summary of unread) void ensure(summary.id);
  }

  async function loadIndex(dir: string, current: number, attempt = 0, signal?: AbortSignal): Promise<FolderIndex | null> {
    const summaries: ComponentSummary[] = [];
    let token = "";
    let restarts = 0;
    for (let offset = 0; ;) {
      signal?.throwIfAborted();
      const page = await backend.components(dir, offset);
      signal?.throwIfAborted();
      if (current !== generation) return null;
      if (token && page.token !== token) {
        if (++restarts > MAX_RETRIES) throw new Error("Trace kept changing while it was loading");
        summaries.length = 0; offset = 0; token = page.token; continue;
      }
      token = page.token;
      summaries.push(...page.components);
      offset += page.components.length;
      if (!page.components.length || offset >= page.total) break;
    }
    const members = new Map<string, Member>();
    for (let offset = 0; ;) {
      signal?.throwIfAborted();
      const page = await backend.members(dir, token, offset);
      signal?.throwIfAborted();
      if (current !== generation) return null;
      if (page.stale) {
        if (attempt >= MAX_RETRIES) throw new Error("Trace kept changing while it was loading");
        return loadIndex(dir, current, attempt + 1, signal);
      }
      for (const member of page.members) members.set(member.path, { componentId: member.componentId, key: member.key });
      offset += page.members.length;
      if (!page.members.length || offset >= page.total) break;
    }
    return { directory: dir, token, components: summaries, members };
  }

  /** The component's complete data, or null when the read was abandoned (cancelled, superseded, or the journal moved on). */
  async function loadComponent(id: string, current: number, folder: FolderIndex, signal: AbortSignal): Promise<ComponentData | null> {
    const nodes: TraceNode[] = [];
    for (let offset = 0; ;) {
      const page = await componentRequest(() => current !== generation || disposed || !isWanted(id)
        ? Promise.resolve(null) : backend.nodes(folder.directory, folder.token, id, offset), signal);
      if (current !== generation || disposed || !isWanted(id) || signal.aborted) return null;
      if (!page) return null;
      if (page.stale) { void refresh(); return null; }
      nodes.push(...page.nodes);
      offset += page.nodes.length;
      if (!page.nodes.length || offset >= page.total) break;
    }
    // A newer index arrived while the last page was in flight: this data belongs to the old one.
    if (index?.token !== folder.token) return null;
    const dag = projectDag(nodes);
    const data: ComponentData = { directory: folder.directory, token: folder.token, version: ++componentVersion, nodes, dag, members: dag.order };
    const next = new Map(components);
    next.set(id, data);
    components = next;
    if (stale.has(id)) stale = new Set([...stale].filter((other) => other !== id));
    componentErrors = new Map([...componentErrors].filter(([other]) => other !== id));
    reconcileOpenStacks();
    return data;
  }

  /** The latest index read; `settled` waits for it, since a read replaces component ids and cancels loads. */
  let opening: Promise<void> = Promise.resolve();
  const open = (dir: string | null, keepVisible: boolean): Promise<void> => (opening = openIndex(dir, keepVisible));
  async function settled(): Promise<void> {
    for (let seen: Promise<void> | null = null; seen !== opening;) { seen = opening; await seen; }
  }

  async function openIndex(dir: string | null, keepVisible: boolean): Promise<void> {
    const current = ++generation;
    cancelLoads();
    directory = dir;
    if (!keepVisible) { indexError = ""; componentErrors = new Map(); }
    if (!dir) { index = null; components = new Map(); stale = new Set(); status = "idle"; return; }
    if (!keepVisible) { index = null; components = new Map(); stale = new Set(); }
    status = keepVisible && index ? "ready" : "loading";
    try {
      const next = await loadIndex(dir, current);
      if (!next || current !== generation || disposed) return;
      const previous = components;
      index = next;
      indexError = "";
      status = "ready";
      // Reload what is shown; keep the old graph visible until it is replaced.
      const keep = new Set(next.components.map((component) => component.id));
      retainErrors(keep);
      components = new Map([...previous].filter(([id]) => keep.has(id)));
      // Every kept component may be out of date: wanted ones reload now, the others when wanted again.
      stale = new Set(components.keys());
      reconcileOpenStacks();
      for (const id of wantedIds()) if (keep.has(id)) void read(id, true).catch(() => undefined);
    } catch (cause) {
      if (current !== generation || disposed) return;
      indexError = cause instanceof Error ? cause.message : String(cause);
      status = index ? "ready" : "error";
    }
  }

  /**
   * The shared read of one component: every interest in it awaits the same task, which rejects with the
   * real error (recorded once in `componentErrors`) and resolves null when abandoned.
   */
  function read(id: string, force: boolean): Promise<ComponentData | null> {
    const folder = index;
    if (disposed || !folder) return Promise.resolve(null);
    const have = components.get(id);
    if (!force && have && !stale.has(id)) return Promise.resolve(have);
    const key = `${folder.token}:${id}`;
    const pending = loading.get(key);
    if (pending) return pending;
    const current = generation;
    const controller = new AbortController();
    loadControllers.set(key, { id, controller });
    const task: Promise<ComponentData | null> = loadComponent(id, current, folder, controller.signal)
      .catch((cause) => {
        if (current !== generation || disposed || controller.signal.aborted) return null;
        componentErrors = new Map(componentErrors).set(id, cause instanceof Error ? cause.message : String(cause));
        throw cause;
      })
      .finally(() => {
        if (loading.get(key) === task) loading.delete(key);
        if (loadControllers.get(key)?.controller === controller) loadControllers.delete(key);
      });
    loading.set(key, task);
    return task;
  }

  const facades = new WeakMap<Promise<ComponentData | null>, Promise<void>>();
  /** Facade over the shared read for the view: wants `id` until `release(id)`, and never rejects (errors land in `error`). */
  function ensure(id: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    viewInterest.add(id);
    const task = read(id, force);
    let settledTask = facades.get(task);
    if (!settledTask) facades.set(task, settledTask = task.then(() => undefined, () => undefined));
    return settledTask;
  }

  /**
   * One id's fresh data under `token`. A read abandoned because a refresh replaced the index object
   * (same token) is simply reissued; only reads that fail to settle for other reasons use up attempts.
   */
  async function acquireOne(id: string, token: string, signal: AbortSignal): Promise<ComponentData> {
    for (let attempt = 0; attempt <= MAX_RETRIES;) {
      signal.throwIfAborted();
      const folder = index;
      if (!folder || folder.token !== token) throw new StaleComponentsError();
      const have = components.get(id);
      if (have && !stale.has(id) && matchesIndex(have, folder)) return have;
      const seen = generation;
      if (await abortable(read(id, false), signal) !== null) continue;
      await abortable(settled(), signal);
      if (generation === seen || index?.token !== token) attempt++;
    }
    throw new Error("Trace kept changing while its components were loading");
  }

  /**
   * Claims complete components under one index token. The claim keeps their reads wanted (shared with
   * every other interest, aborted only when the last one withdraws) until `release()`, the signal
   * aborts, the directory changes, or `results` fails. `results` rejects with the read's real error,
   * or `StaleComponentsError` once the index no longer carries `token`; it never yields partial pages.
   */
  function acquireComponents(ids: readonly string[], token: string, signal?: AbortSignal): ComponentLease {
    const wanted: ReadonlySet<string> = new Set(ids);
    const own = new AbortController();
    const joined = AbortSignal.any(signal ? [own.signal, lifetime.signal, signal] : [own.signal, lifetime.signal]);
    const release = () => {
      leaseInterests.delete(wanted);
      own.abort();
      dropUnwanted(wanted);
    };
    joined.addEventListener("abort", release, { once: true });
    const gather = async (): Promise<ReadonlyMap<string, ComponentData>> => {
      joined.throwIfAborted();
      if (disposed) throw new Error("Trace view is no longer available");
      if (!wanted.size) return new Map();
      const known = new Set(index?.components.map((summary) => summary.id));
      const missing = [...wanted].find((id) => index?.token === token && !known.has(id));
      if (missing !== undefined) throw new Error(`Unknown Trace component ${missing}`);
      leaseInterests.add(wanted);
      // Every id must be fresh together: a refresh during a later read can outdate an earlier one (same
      // token, new index object), so re-acquire until one pass finds them all current.
      for (let pass = 0; pass <= MAX_RETRIES; pass++) {
        await Promise.all([...wanted].map((id) => acquireOne(id, token, joined)));
        const folder = index;
        if (!folder || folder.token !== token) throw new StaleComponentsError();
        const current = [...wanted].map((id) => [id, components.get(id)] as const);
        if (current.every(([id, data]) => data && !stale.has(id) && matchesIndex(data, folder))) return new Map(current as [string, ComponentData][]);
      }
      throw new Error("Trace kept changing while its components were loading");
    };
    const results = gather().catch((cause) => { release(); throw cause; });
    // A caller that drops a released lease never sees its rejection; that must not be unhandled.
    results.catch(() => undefined);
    return { results, release };
  }

  function refresh(): Promise<void> {
    return open(directory, true);
  }

  /** Resolve against a fresh index: component ids may have changed since publication. */
  async function resolveArtifact(artifactId: number, signal: AbortSignal): Promise<{ node: TraceNode; componentId: string }> {
    signal = AbortSignal.any([signal, lifetime.signal]);
    signal.throwIfAborted();
    const dir = directory;
    if (!dir || disposed) throw new Error("Trace view is no longer available");
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const current = generation;
      const folder = await loadIndex(dir, current, 0, signal);
      signal.throwIfAborted();
      if (dir !== directory || disposed) throw new Error("Trace folder changed during reveal");
      if (!folder || current !== generation) continue;
      let restart = false;
      for (const summary of folder.components) {
        const nodes: TraceNode[] = [];
        for (let offset = 0; ;) {
          signal.throwIfAborted();
          const page = await componentRequest(() => {
            signal.throwIfAborted();
            return current !== generation || disposed ? Promise.resolve(null) : backend.nodes(dir, folder.token, summary.id, offset);
          }, signal);
          signal.throwIfAborted();
          if (dir !== directory || disposed) throw new Error("Trace folder changed during reveal");
          if (current !== generation || !page) { restart = true; break; }
          if (page.stale) { restart = true; break; }
          nodes.push(...page.nodes);
          offset += page.nodes.length;
          if (!page.nodes.length || offset >= page.total) break;
        }
        if (restart) break;
        const node = nodes.find((node) => node.artifactId === artifactId && !node.discarded && !node.earlierRevision && node.state === "present");
        if (!node) continue;
        // Only commit once the entire target component is loaded and the request is still live.
        signal.throwIfAborted();
        generation += 1;
        cancelLoads();
        const ids = new Set(folder.components.map((component) => component.id));
        retainErrors(new Set([...ids].filter((id) => id !== summary.id)));
        components = new Map([...components].filter(([id]) => ids.has(id)));
        stale = index?.token === folder.token ? new Set([...stale].filter((id) => ids.has(id))) : new Set(components.keys());
        components = new Map(components).set(summary.id, { directory: folder.directory, token: folder.token, version: ++componentVersion, nodes, dag: projectDag(nodes), members: nodes.map((node) => node.key) });
        stale = new Set([...stale].filter((id) => id !== summary.id));
        index = folder;
        status = "ready";
        indexError = "";
        viewInterest.add(summary.id);
        reconcileOpenStacks();
        return { node, componentId: summary.id };
      }
      if (!restart) throw new Error(`Trace image artifact:${artifactId} no longer exists in this folder`);
    }
    throw new Error("Trace kept changing while revealing the image");
  }

  return {
    get index() { return index; },
    get status() { return status; },
    get error() { return error; },
    /** Why the last folder index read failed; empty once a read succeeds. */
    get indexError() { return indexError; },
    get components() { return components; },
    get orientations() { return orientations; },
    get openStackKeys() { return openStackKeys; },
    get openStackSearch() { return openStackSearch; },
    setStackOpen(id: string, opening: boolean) {
      const summary = index?.components.find((component) => component.id === id);
      if (!summary) return;
      let keys = new Set(paneState.openCovers);
      if (opening) {
        for (const key of coverAliases(summary, index!.members)) { keys.delete(key); keys.add(key); }
      }
      else {
        const membership = stackMembership.find((component) => component.coverKey === summary.coverKey);
        if (membership) keys = new Set(forgetOpenStack(openStacks, membership));
      }
      const resolved = resolveOpenStacks(keys, stackMembership, openStacks.owners);
      paneState = { ...paneState, openCovers: resolved.remembered, openOwners: resolved.owners };
      remember();
    },
    /** A new external selection opens its stacks; an explicitly closed selection stays closed on return. */
    followSelection(choice: string, ids: ReadonlySet<string>) {
      if (!index) return;
      const selected = index.components.filter((summary) => ids.has(summary.id)).map((summary) => coverIdentity(summary, index!.members));
      const added = index.components.filter((summary) => ids.has(summary.id) && (choice !== paneState.selectionChoice || !paneState.selectionCovers.has(coverIdentity(summary, index!.members))));
      const keys = new Set(paneState.openCovers);
      for (const summary of added) for (const key of coverAliases(summary, index.members)) { keys.delete(key); keys.add(key); }
      const resolved = resolveOpenStacks(keys, stackMembership, openStacks.owners);
      paneState = { openCovers: resolved.remembered, openOwners: resolved.owners, selectionChoice: choice, selectionCovers: new Set(selected) };
      remember();
    },
    /** Switch folders. Data for the previous folder is never shown for the new one. */
    setDirectory(dir: string | null) {
      if (disposed || dir === directory) return;
      // A remount restores the same pane/folder, but navigation forgets its history.
      if (started) { paneState = emptyPaneSnapshot(); remember(); }
      lifetime.abort();
      lifetime = new AbortController();
      indexError = "";
      componentErrors = new Map();
      viewInterest = new Set();
      leaseInterests.clear();
      const known = dir ? snapshots.recall(dir) : undefined;
      paneState = (!started && known?.panes?.get(paneId)) || emptyPaneSnapshot();
      started = true;
      if (!known) { orientations = new Map(); void open(dir, false); return; }
      // Show what the folder last showed, as it was laid out, while its index is read again; open() reloads what is wanted.
      index = known.index; components = known.components; stale = known.stale; orientations = new Map(known.orientations);
      void open(dir, true);
      // Persist navigation's reset even if the view unmounts before revalidation.
      remember();
    },
    refresh,
    resolveArtifact,
    ensure,
    acquireComponents,
    settled,
    release(id: string) {
      viewInterest.delete(id);
      dropUnwanted([id]);
    },
    componentOf(path: string): Member | null { return index?.members.get(path) ?? null; },
    /** Whether a loaded component's data predates the current index (a refresh skipped it). Reactive. */
    isStale(id: string): boolean { return stale.has(id); },
    dispose() { disposed = true; generation += 1; lifetime.abort(); cancelLoads(); },
  };
}

export type FolderSession = ReturnType<typeof createFolderSession>;
