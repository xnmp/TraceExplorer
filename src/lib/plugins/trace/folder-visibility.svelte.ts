/**
 * Whether a folder has Trace content (provenance, or active/unsaved work), per
 * directory. The Trace file view is offered only where this is true; elsewhere
 * the host shows the built-in view while keeping the Trace preference.
 *
 * `available` is read from reactive contexts (the host resolves views in a
 * derived), so it never mutates state synchronously: unknown folders are
 * queued and answer `false` until their result arrives. Known folders keep
 * their last answer while being refreshed, so views do not flicker.
 */
import { invoke } from "$lib/api/common";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { samePath } from "$lib/domain/path";

type Lookup = (directory: string) => Promise<boolean>;

const CACHE_LIMIT = 128;
/** Folders refreshed when Trace data changes: the ones views asked about most recently. */
const RECENT_LIMIT = 16;

export function createFolderVisibility(lookup: Lookup) {
  let known = $state.raw<ReadonlyMap<string, boolean>>(new Map());
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

  function remember(directory: string) {
    if (recent[0] === directory) return;
    recent = [directory, ...recent.filter((item) => item !== directory)].slice(0, RECENT_LIMIT);
  }

  return {
    available(directory: string): boolean {
      if (!directory || isVirtualPath(directory)) return false;
      remember(directory);
      const value = known.get(directory);
      if (value === undefined && !pending.has(directory)) queueMicrotask(() => { if (!known.has(directory) && !pending.has(directory)) refresh(directory); });
      return value === true;
    },
    /** Trace data changed somewhere: re-check folders views are showing. */
    refreshRecent() { for (const directory of recent) refresh(directory); },
    /** Files changed in these folders. */
    filesChanged(directories: readonly string[]) {
      for (const directory of known.keys()) if (directories.some((path) => samePath(path, directory))) refresh(directory);
    },
    clear() { scope += 1; known = new Map(); pending.clear(); dirty.clear(); recent = []; },
  };
}

export const traceFolderVisibility = createFolderVisibility((directory) => invoke<boolean>("folder_has_trace", { directory }));
