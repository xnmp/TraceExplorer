/**
 * Entry lineage ("Show traces"): feeds the host's built-in views the provenance
 * of a folder's files. Registered only where the host announces `entryLineage`;
 * on older hosts nothing here runs.
 */
import { buildEntryLineage, type LineageNode } from "$lib/domain/entry-lineage";
import { samePath } from "$lib/domain/path";
import { hostSupportsEntryLineage } from "../../../sdk";
import type { EntryLineage, EntryLineageContribution, FileViewEligibility, PluginContext } from "../../../../integration/plugin-sdk";
import type { FolderMemberRecord } from "$lib/api/trace";
import type { TraceBackend } from "./view/backend";
import { componentRequest } from "./view/component-requests";

export const LINEAGE_ID = "xnmp.trace-explorer.lineage";
/** Restarts allowed when the folder index changes under a read. */
const MAX_RESTARTS = 3;

class Restart extends Error {}

/** Reads the folder's members and the nodes of the components that own them. */
export async function loadFolderLineage(backend: TraceBackend, directory: string, signal: AbortSignal): Promise<EntryLineage> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    // Each attempt owns a signal, so a failed or restarted attempt cancels its queued node reads.
    const attemptAbort = new AbortController();
    const forward = () => attemptAbort.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    try { return await readOnce(backend, directory, attemptAbort.signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Restart)) throw error;
      if (attempt >= MAX_RESTARTS) throw new Error("Trace kept changing while it was loading");
    } finally {
      signal.removeEventListener("abort", forward);
      attemptAbort.abort();
    }
  }
}

async function readOnce(backend: TraceBackend, directory: string, signal: AbortSignal): Promise<EntryLineage> {
  signal.throwIfAborted();
  // The first components page names the index; members and node pages are checked against its token
  // and report `stale` when the index moves on, so the remaining summary pages are not needed.
  const first = await backend.components(directory, 0);
  signal.throwIfAborted();
  const token = first.token;
  const members: FolderMemberRecord[] = [];
  for (let offset = 0; ;) {
    const page = await backend.members(directory, token, offset);
    signal.throwIfAborted();
    if (page.stale) throw new Restart();
    const batch = Array.isArray(page.members) ? page.members : [];
    members.push(...batch);
    offset += batch.length;
    if (!batch.length || offset >= page.total) break;
  }
  const owners = new Set(members.map((member) => member?.componentId).filter((id): id is string => typeof id === "string"));
  const nodes: LineageNode[] = [];
  const read = async (componentId: string) => {
    for (let offset = 0; ;) {
      const page = await componentRequest(() => backend.nodes(directory, token, componentId, offset), signal);
      signal.throwIfAborted();
      if (page.stale) throw new Restart();
      const batch = Array.isArray(page.nodes) ? page.nodes : [];
      nodes.push(...batch);
      offset += batch.length;
      if (!batch.length || offset >= page.total) break;
    }
  };
  await Promise.all([...owners].map(read));
  return buildEntryLineage(members, nodes);
}

/** Who wants to hear that lineage may have changed, per directory. Over-notifying is safe: the host compares revisions. */
export function createLineageSubscriptions() {
  const listeners = new Map<string, Set<() => void>>();
  const fire = (set: Iterable<() => void>) => { for (const listener of [...set]) { try { listener(); } catch { /* one listener must not starve the rest */ } } };
  return {
    subscribe(directory: string, changed: () => void): () => void {
      const set = listeners.get(directory) ?? new Set();
      set.add(changed);
      listeners.set(directory, set);
      return () => {
        set.delete(changed);
        if (!set.size && listeners.get(directory) === set) listeners.delete(directory);
      };
    },
    notifyAll() { for (const set of [...listeners.values()]) fire(set); },
    notifyDirectories(directories: readonly string[]) {
      for (const [directory, set] of [...listeners]) if (directories.some((path) => samePath(path, directory))) fire(set);
    },
    clear() { listeners.clear(); },
  };
}

export const lineageSubscriptions = createLineageSubscriptions();

export function lineageContribution(
  backend: TraceBackend,
  available: (directory: string) => FileViewEligibility,
  subscriptions = lineageSubscriptions,
): EntryLineageContribution {
  return {
    id: LINEAGE_ID,
    title: "Traces",
    available,
    load: (directory, signal) => loadFolderLineage(backend, directory, signal),
    subscribe: (directory, changed) => subscriptions.subscribe(directory, changed),
  };
}

/** Registers the contribution and its command; does nothing on hosts without `entryLineage`. */
export function registerLineage(ctx: PluginContext, backend: TraceBackend, available: (directory: string) => FileViewEligibility): boolean {
  if (!hostSupportsEntryLineage(ctx)) return false;
  ctx.registerEntryLineage!(lineageContribution(backend, available));
  ctx.registerCommand({
    id: "plugin.trace.show-traces", label: "Show Traces", category: "view",
    handler: () => ctx.workspace.toggleEntryLineage?.(LINEAGE_ID),
  });
  return true;
}
