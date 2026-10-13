/**
 * Whether a folder has Trace content (provenance, or active/unsaved work), per
 * directory. The Trace file view is offered only where this is true; elsewhere
 * the host shows the built-in view while keeping the Trace preference.
 *
 * `available` is read from reactive contexts (the host resolves views in a
 * derived), so it never mutates state synchronously: unknown folders are
 * queued for an exact lookup and answer meanwhile from the SQL candidate
 * superset (`true` when it includes them, so a first visit paints the Trace
 * view first), or `"pending"` until the exact answer arrives. A miss is not authoritative: the
 * host may name a folder by an alias (symlink, Windows short name, macOS
 * `/var`) that the canonical superset cannot match, so it is still looked up.
 * Known folders keep their last answer while being refreshed, so views do not flicker.
 */
import { invoke } from "$lib/api/common";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { directoryKey, samePath } from "$lib/domain/path";

import type { FileViewEligibility } from "../../../../integration/plugin-sdk";
import { folderEligibility } from "$lib/domain/folder-eligibility";

type Lookup = (directory: string) => Promise<boolean>;
type CandidateLoader = () => Promise<readonly string[]>;

const CACHE_LIMIT = 128;
/** Folders refreshed when Trace data changes: the ones views asked about most recently. */
const RECENT_LIMIT = 16;

export function createFolderVisibility(lookup: Lookup, loadCandidates?: CandidateLoader) {
  let known = $state.raw<ReadonlyMap<string, boolean>>(new Map());
  // Separate from the bounded exact-answer cache. Only presence is trusted:
  // the SDK exposes no canonical identity for a host directory alias (see integration/README.md).
  let candidates = $state.raw<ReadonlySet<string> | null>(null);
  let candidateRevision = 0;
  let scope = 0;
  const pending = new Set<string>();
  const dirty = new Set<string>();
  let recent: string[] = [];

  function store(directory: string, value: boolean) {
    const next = new Map(known);
    next.delete(directory);
    next.set(directory, value);
    while (next.size > CACHE_LIMIT) next.delete(next.keys().next().value!);
    known = next;
  }

  function refresh(directory: string) {
    if (isVirtualPath(directory)) return;
    if (pending.has(directory)) { dirty.add(directory); return; }
    pending.add(directory);
    const current = scope;
    void lookup(directory)
      .then((value) => { if (current === scope && !dirty.has(directory)) store(directory, value === true); })
      .catch(() => { if (current === scope && !dirty.has(directory)) store(directory, false); })
      .finally(() => {
        if (current !== scope) return;
        pending.delete(directory);
        if (dirty.delete(directory)) refresh(directory);
      });
  }

  async function preload(): Promise<void> {
    if (!loadCandidates) return;
    const current = scope;
    const revision = ++candidateRevision;
    try {
      const paths = await loadCandidates();
      const next = new Set(paths.map(directoryKey));
      if (current === scope && revision === candidateRevision) candidates = next;
    } catch {
      // An unavailable RPC must fall back to exact lookups, never declare all
      // folders ineligible. A failed reload also invalidates the old superset.
      if (current === scope && revision === candidateRevision) candidates = null;
    }
  }

  function remember(directory: string) {
    if (recent[0] === directory) return;
    recent = [directory, ...recent.filter((item) => item !== directory)].slice(0, RECENT_LIMIT);
  }

  return {
    available(directory: string): FileViewEligibility {
      if (!directory || isVirtualPath(directory)) return false;
      remember(directory);
      const value = known.get(directory);
      if (value !== undefined) return value;
      const current = scope;
      if (!pending.has(directory)) queueMicrotask(() => {
        if (current === scope && !known.has(directory) && !pending.has(directory)) refresh(directory);
      });
      return folderEligibility(directory, value, candidates?.has(directoryKey(directory)) === true);
    },
    /** Trace data changed somewhere: re-check folders views are showing. */
    preload,
    refreshRecent() {
      void preload();
      for (const directory of recent) refresh(directory);
    },
    /** Files changed in these folders. */
    filesChanged(directories: readonly string[]) {
      for (const directory of known.keys()) if (directories.some((path) => samePath(path, directory))) refresh(directory);
    },
    clear() { scope += 1; candidates = null; known = new Map(); pending.clear(); dirty.clear(); recent = []; },
  };
}

export const traceFolderVisibility = createFolderVisibility(
  (directory) => invoke<boolean>("folder_has_trace", { directory }),
  () => invoke<string[]>("trace_folder_candidates"),
);
