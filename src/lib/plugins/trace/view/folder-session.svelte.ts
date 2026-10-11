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
import type { Orientation } from "$lib/domain/trace-graph/layout";
import { projectDag, type TraceDag } from "$lib/domain/trace-graph/projection";
import { traceBackend, type TraceBackend } from "./backend";
import { createSnapshotCache, type SnapshotCache } from "./folder-snapshots";
import { componentRequest } from "./component-requests";

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

/** What a folder last showed: its index, loaded components and which of them predate it, and each component's orientation. */
export interface FolderSnapshot {
  readonly index: FolderIndex;
  readonly components: ReadonlyMap<string, ComponentData>;
  readonly stale: ReadonlySet<string>;
  readonly orientations: ReadonlyMap<string, Orientation>;
}
/** Members and nodes a snapshot holds, which bound the cache's memory. */
export const snapshotWeight = (snapshot: FolderSnapshot): number =>
  snapshot.index.members.size + [...snapshot.components.values()].reduce((sum, data) => sum + data.nodes.length, 0);
/** Shared by every session, so a remounted view finds what the previous one loaded. */
const folderSnapshots = createSnapshotCache<FolderSnapshot>({ limit: 8, budget: 200_000, weigh: snapshotWeight });
/** Forgets every folder's data, when the plugin is disabled. */
export function forgetFolderSnapshots(): void { folderSnapshots.clear(); }

export function createFolderSession(backend: TraceBackend = traceBackend, snapshots: SnapshotCache<FolderSnapshot> = folderSnapshots) {
  let index = $state.raw<FolderIndex | null>(null);
  let status = $state<SessionStatus>("idle");
  let error = $state("");
  let components = $state.raw<ReadonlyMap<string, ComponentData>>(new Map());
  let directory: string | null = null;
  let generation = 0;
  let disposed = false;
  const loading = new Map<string, Promise<void>>();
  let wanted = new Set<string>();
  /** Loaded data predating the index: stays visible until its fresh load completes. */
  let stale = $state.raw<ReadonlySet<string>>(new Set());
  /** Orientation each component of this folder was last laid out with, by id: hysteresis that survives collapse and remount. The layout writes it. */
  let orientations = $state.raw(new Map<string, Orientation>());
  /** Writes stop once the cache is cleared (the plugin was disabled) after this session began. */
  const epoch = snapshots.epoch;

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
    });
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

  async function loadComponent(id: string, current: number, folder: FolderIndex): Promise<void> {
    const nodes: TraceNode[] = [];
    for (let offset = 0; ;) {
      const page = await componentRequest(() => current !== generation || disposed
        ? Promise.resolve(null) : backend.nodes(folder.directory, folder.token, id, offset));
      if (current !== generation || disposed) return;
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
    error = "";
    remember();
  }

  async function open(dir: string | null, keepVisible: boolean): Promise<void> {
    const current = ++generation;
    loading.clear();
    directory = dir;
    if (!dir) { index = null; components = new Map(); status = "idle"; return; }
    if (!keepVisible) { index = null; components = new Map(); stale = new Set(); }
    status = keepVisible && index ? "ready" : "loading";
    error = "";
    try {
      const next = await loadIndex(dir, current);
      if (!next || current !== generation || disposed) return;
      const previous = components;
      index = next;
      status = "ready";
      // Reload what is shown; keep the old graph visible until it is replaced.
      const keep = new Set(next.components.map((component) => component.id));
      components = new Map([...previous].filter(([id]) => keep.has(id)));
      // Every kept component may be out of date: wanted ones reload now, the others when wanted again.
      stale = new Set(components.keys());
      remember();
      for (const id of wanted) if (keep.has(id)) void ensure(id, true);
    } catch (cause) {
      if (current !== generation || disposed) return;
      error = cause instanceof Error ? cause.message : String(cause);
      status = index ? "ready" : "error";
    }
  }

  function ensure(id: string, force = false): Promise<void> {
    wanted.add(id);
    const folder = index;
    if (!folder || (!force && components.has(id) && !stale.has(id))) return Promise.resolve();
    const key = `${folder.token}:${id}`;
    const pending = loading.get(key);
    if (pending) return pending;
    const current = generation;
    const task = loadComponent(id, current, folder)
      .catch((cause) => { if (current === generation) error = cause instanceof Error ? cause.message : String(cause); })
      .finally(() => { if (loading.get(key) === task) loading.delete(key); });
    loading.set(key, task);
    return task;
  }

  function refresh(): Promise<void> {
    return open(directory, true);
  }

  /** Resolve against a fresh index: component ids may have changed since publication. */
  async function resolveArtifact(artifactId: number, signal: AbortSignal): Promise<{ node: TraceNode; componentId: string }> {
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
          });
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
        loading.clear();
        const ids = new Set(folder.components.map((component) => component.id));
        components = new Map([...components].filter(([id]) => ids.has(id)));
        stale = index?.token === folder.token ? new Set([...stale].filter((id) => ids.has(id))) : new Set(components.keys());
        components = new Map(components).set(summary.id, { nodes, dag: projectDag(nodes), members: nodes.map((node) => node.key) });
        stale = new Set([...stale].filter((id) => id !== summary.id));
        index = folder;
        status = "ready";
        error = "";
        wanted.add(summary.id);
        remember();
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
    /** Switch folders. Data for the previous folder is never shown for the new one. */
    setDirectory(dir: string | null) {
      if (dir === directory) return;
      wanted = new Set();
      const known = dir ? snapshots.recall(dir) : undefined;
      if (!known) { orientations = new Map(); void open(dir, false); return; }
      // Show what the folder last showed, as it was laid out, while its index is read again; open() reloads what is wanted.
      index = known.index; components = known.components; stale = known.stale; orientations = new Map(known.orientations);
      void open(dir, true);
    },
    refresh,
    resolveArtifact,
    ensure,
    release(id: string) { wanted.delete(id); },
    componentOf(path: string): Member | null { return index?.members.get(path) ?? null; },
    /** Whether a loaded component's data predates the current index (a refresh skipped it). Reactive. */
    isStale(id: string): boolean { return stale.has(id); },
    dispose() { disposed = true; generation += 1; loading.clear(); },
  };
}

export type FolderSession = ReturnType<typeof createFolderSession>;
