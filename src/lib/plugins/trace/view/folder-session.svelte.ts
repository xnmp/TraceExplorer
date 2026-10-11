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
import { projectDag, type TraceDag } from "$lib/domain/trace-graph/projection";
import { traceBackend, type TraceBackend } from "./backend";
import { createSnapshotCache, type SnapshotCache } from "./folder-snapshots";

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

export interface FolderSnapshot { readonly index: FolderIndex; readonly components: ReadonlyMap<string, ComponentData> }
/** Shared by every session, so a remounted view finds what the previous one loaded. */
const folderSnapshots = createSnapshotCache<FolderSnapshot>(8);
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
  /** Loaded components a refresh did not reload (not wanted then): shown until reloaded, reloaded when wanted again. */
  let stale = $state.raw<ReadonlySet<string>>(new Set());

  /** Keeps what this folder now shows for the next session that opens it. */
  function remember(): void {
    if (!disposed && index && index.directory === directory) snapshots.remember(index.directory, { index, components });
  }

  async function loadIndex(dir: string, current: number, attempt = 0): Promise<FolderIndex | null> {
    const summaries: ComponentSummary[] = [];
    let token = "";
    let restarts = 0;
    for (let offset = 0; ;) {
      const page = await backend.components(dir, offset);
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
      const page = await backend.members(dir, token, offset);
      if (current !== generation) return null;
      if (page.stale) {
        if (attempt >= MAX_RETRIES) throw new Error("Trace kept changing while it was loading");
        return loadIndex(dir, current, attempt + 1);
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
      const page = await backend.nodes(folder.directory, folder.token, id, offset);
      if (current !== generation || disposed) return;
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
      remember();
      // Every kept component may be out of date: wanted ones reload now, the others when wanted again.
      stale = new Set([...components.keys()].filter((id) => !wanted.has(id)));
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
      .finally(() => loading.delete(key));
    loading.set(key, task);
    return task;
  }

  function refresh(): Promise<void> {
    return open(directory, true);
  }

  return {
    get index() { return index; },
    get status() { return status; },
    get error() { return error; },
    get components() { return components; },
    /** Switch folders. Data for the previous folder is never shown for the new one. */
    setDirectory(dir: string | null) {
      if (dir === directory) return;
      wanted = new Set();
      const known = dir ? snapshots.recall(dir) : undefined;
      if (!known) { void open(dir, false); return; }
      // Show what the folder last showed while its index is read again; open() reloads what is wanted.
      index = known.index; components = known.components; stale = new Set();
      void open(dir, true);
    },
    refresh,
    ensure,
    release(id: string) { wanted.delete(id); },
    componentOf(path: string): Member | null { return index?.members.get(path) ?? null; },
    /** Whether a loaded component's data predates the current index (a refresh skipped it). Reactive. */
    isStale(id: string): boolean { return stale.has(id); },
    dispose() { disposed = true; generation += 1; loading.clear(); },
  };
}

export type FolderSession = ReturnType<typeof createFolderSession>;
