/**
 * Keyed cache for values the Preview info loads from the backend (run details,
 * revision status, per-image traces). Each value is stamped with the Trace
 * invalidation revision it was loaded at.
 *
 * A read for a newer revision keeps returning the last value known for that
 * key, flagged `pending`, until the refresh lands (stale-while-revalidate).
 * Callers therefore never have to clear what they show while a reload is in
 * flight, and revisiting a subject is instant.
 */
import { untrack } from "svelte";
import type { ApiResult } from "$lib/api/common";

export interface CacheRead<V> {
  /** Whether any load for this key has completed. */
  readonly known: boolean;
  /** The newest loaded value; `undefined` until `known`. */
  readonly value: V | undefined;
  /** A load for the requested revision has not completed yet. */
  readonly pending: boolean;
  /** The error of the load for the requested revision, if it failed. */
  readonly error: string;
}

interface Entry<V> {
  readonly revision: number;
  readonly known: boolean;
  readonly value: V | undefined;
  readonly error: string;
}

export interface RevisionCache<K, V> {
  read(key: K, revision: number): CacheRead<V>;
  /** Starts a load unless the key is loaded, or loading, at `revision` or later. A failed load is retried. */
  request(key: K, revision: number): void;
  clear(): void;
}

const UNKNOWN: CacheRead<never> = { known: false, value: undefined, pending: true, error: "" };

export function createRevisionCache<K, V>(load: (key: K) => Promise<ApiResult<V>>, limit = 256): RevisionCache<K, V> {
  let entries = $state.raw<ReadonlyMap<K, Entry<V>>>(new Map());
  // Bookkeeping only; never read reactively.
  const loading = new Map<K, number>();
  let generation = 0;

  const store = (key: K, entry: Entry<V>) => {
    const next = new Map(untrack(() => entries));
    next.delete(key);
    next.set(key, entry);
    // Oldest insertions go first.
    for (const old of next.keys()) { if (next.size <= limit) break; if (old !== key) next.delete(old); }
    entries = next;
  };

  return {
    read(key, revision) {
      const entry = entries.get(key);
      if (!entry) return UNKNOWN;
      const current = entry.revision >= revision;
      return { known: entry.known, value: entry.value, pending: !current, error: current ? entry.error : "" };
    },
    request(key, revision) {
      // Called from effects: what is cached must not become their dependency.
      const entry = untrack(() => entries.get(key));
      if ((entry && !entry.error && entry.revision >= revision) || (loading.get(key) ?? -1) >= revision) return;
      loading.set(key, revision);
      const started = generation;
      const settle = (result: ApiResult<V>) => {
        if (started !== generation) return;
        if (loading.get(key) === revision) loading.delete(key);
        const previous = untrack(() => entries.get(key));
        if (previous && previous.revision > revision) return;
        store(key, result.ok
          ? { revision, known: true, value: result.data, error: "" }
          : { revision, known: previous?.known ?? false, value: previous?.value, error: result.error });
      };
      load(key).then(settle, (error: unknown) => settle({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    },
    clear() {
      generation += 1;
      loading.clear();
      entries = new Map();
    },
  };
}
