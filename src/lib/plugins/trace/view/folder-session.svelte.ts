/**
 * Pane-owned Trace data for one folder: component summaries first, members
 * (Explorer path → node) next, and a component's nodes only when it is shown.
 * Every load is tagged with a generation; results for an older directory or
 * index are discarded. Refreshes keep the previous data visible until the new
 * index arrives, so graph views never flash empty. A new session for a folder
 * another session already loaded starts from that data and revalidates it, so
 * returning to a Trace tab never shows "Loading Trace…" again.
 */
import type { ComponentSummary, NodeKey, TraceNode } from "$lib/domain/trace-graph/model";
import type { OrientationHistory } from "$lib/domain/trace-graph/orientation";
import { projectDag, type TraceDag } from "$lib/domain/trace-graph/projection";
import { traceBackend, type TraceBackend } from "./backend";
import { createSnapshotCache, type SnapshotCache } from "./folder-snapshots";
import { componentRequest } from "./component-requests";
import { parentDir, samePath } from "$lib/domain/path";
import { coverIdentity, forgetOpenStack, pathIdentity, revisionIdentity, resolveOpenStacks } from "./open-stacks";

export interface ComponentData {
  readonly nodes: readonly TraceNode[];
  readonly dag: TraceDag;
  readonly members: readonly NodeKey[];
}

export interface Member { readonly componentId: string; readonly key: NodeKey }

export interface FolderIndex {
  readonly directory: string;
  readonly token: string;
  readonly components: readonly ComponentSummary[];
  readonly members: ReadonlyMap<string, Member>;
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
export function forgetFolderSnapshots(): void { folderSnapshots.clear(); }

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
  const loading = new Map<string, Promise<void>>();
  const loadControllers = new Map<string, AbortController>();
  /** Reveals survive index refreshes, but never a directory change or disposal. */
  let lifetime = new AbortController();
  let wanted = new Set<string>();
  /** Loaded data predating the index: stays visible until its fresh load completes. */
  let stale = $state.raw<ReadonlySet<string>>(new Set());
  /** Displayed orientations by component and tile width: hysteresis that survives collapse and remount. */
  let orientations = $state.raw(new Map<string, OrientationHistory>());
  let paneState = $state.raw<PaneFolderSnapshot>(emptyPaneSnapshot());
  const stackMembership = $derived.by(() => {
    const available = (node: TraceNode) => !node.discarded && node.state !== "missing" && !node.referenceBadge;
    const identities = new Map((index?.components ?? []).map((summary) => {
      const data = !stale.has(summary.id) ? components.get(summary.id) : undefined;
      const cover = data?.dag.nodes.get(summary.coverKey);
      return [summary.id, new Set<string>(!data || (cover && available(cover)) ? [revisionIdentity(summary.coverKey)] : [])];
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
    return (index?.components ?? []).map((summary) => ({ coverKey: summary.coverKey, coverIdentity: coverIdentity(summary, index!.members), identities: identities.get(summary.id)! }));
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
    for (const controller of loadControllers.values()) controller.abort();
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

  async function loadComponent(id: string, current: number, folder: FolderIndex, signal: AbortSignal): Promise<void> {
    const nodes: TraceNode[] = [];
    for (let offset = 0; ;) {
      const page = await componentRequest(() => current !== generation || disposed || !wanted.has(id)
        ? Promise.resolve(null) : backend.nodes(folder.directory, folder.token, id, offset), signal);
      if (current !== generation || disposed || !wanted.has(id) || signal.aborted) return;
      if (!page) return;
      if (page.stale) { void refresh(); return; }
      nodes.push(...page.nodes);
      offset += page.nodes.length;
      if (!page.nodes.length || offset >= page.total) break;
    }
    const dag = projectDag(nodes);
    const next = new Map(components);
    next.set(id, { nodes, dag, members: dag.order });
    components = next;
    if (stale.has(id)) stale = new Set([...stale].filter((other) => other !== id));
    componentErrors = new Map([...componentErrors].filter(([other]) => other !== id));
    reconcileOpenStacks();
  }

  async function open(dir: string | null, keepVisible: boolean): Promise<void> {
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
      for (const id of wanted) if (keep.has(id)) void ensure(id, true);
    } catch (cause) {
      if (current !== generation || disposed) return;
      indexError = cause instanceof Error ? cause.message : String(cause);
      status = index ? "ready" : "error";
    }
  }

  function ensure(id: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    wanted.add(id);
    const folder = index;
    if (!folder || (!force && components.has(id) && !stale.has(id))) return Promise.resolve();
    const key = `${folder.token}:${id}`;
    const pending = loading.get(key);
    if (pending) return pending;
    const current = generation;
    const controller = new AbortController();
    loadControllers.set(key, controller);
    const task = loadComponent(id, current, folder, controller.signal)
      .catch((cause) => {
        if (current === generation && !disposed && !controller.signal.aborted) {
          componentErrors = new Map(componentErrors).set(id, cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (loading.get(key) === task) loading.delete(key);
        if (loadControllers.get(key) === controller) loadControllers.delete(key);
      });
    loading.set(key, task);
    return task;
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
        components = new Map(components).set(summary.id, { nodes, dag: projectDag(nodes), members: nodes.map((node) => node.key) });
        stale = new Set([...stale].filter((id) => id !== summary.id));
        index = folder;
        status = "ready";
        indexError = "";
        wanted.add(summary.id);
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
    get components() { return components; },
    get orientations() { return orientations; },
    get openStackKeys() { return openStackKeys; },
    get openStackSearch() { return openStackSearch; },
    setStackOpen(id: string, opening: boolean) {
      const summary = index?.components.find((component) => component.id === id);
      if (!summary) return;
      let keys = new Set(paneState.openCovers);
      if (opening) {
        const key = coverIdentity(summary, index!.members);
        keys.delete(key); keys.add(key);
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
      const added = selected.filter((key) => choice !== paneState.selectionChoice || !paneState.selectionCovers.has(key));
      const keys = new Set(paneState.openCovers);
      for (const key of added) { keys.delete(key); keys.add(key); }
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
      wanted = new Set();
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
    release(id: string) {
      wanted.delete(id);
      const key = index ? `${index.token}:${id}` : null;
      if (!key) return;
      loadControllers.get(key)?.abort();
      loadControllers.delete(key);
      loading.delete(key);
    },
    componentOf(path: string): Member | null { return index?.members.get(path) ?? null; },
    /** Whether a loaded component's data predates the current index (a refresh skipped it). Reactive. */
    isStale(id: string): boolean { return stale.has(id); },
    dispose() { disposed = true; generation += 1; lifetime.abort(); cancelLoads(); },
  };
}

export type FolderSession = ReturnType<typeof createFolderSession>;
