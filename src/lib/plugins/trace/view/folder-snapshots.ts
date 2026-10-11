/**
 * The last data each folder showed, kept across Trace view mounts. The host
 * mounts a fresh view each time its tab is shown again; a session seeded from
 * here shows the folder at once and revalidates it in the background
 * (stale-while-revalidate) instead of showing "Loading Trace…" on every tab
 * switch. Least recently used folders are evicted beyond `limit`.
 */
export interface SnapshotCache<T> {
  /** The value kept for `key`, which becomes the most recently used. */
  recall(key: string): T | undefined;
  remember(key: string, value: T): void;
  clear(): void;
}

export function createSnapshotCache<T>(limit: number): SnapshotCache<T> {
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const entries = new Map<string, T>();
  return {
    recall(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    remember(key, value) {
      entries.delete(key);
      if (!capacity) return;
      entries.set(key, value);
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
    },
    clear() { entries.clear(); },
  };
}
