/**
 * The last data each folder showed, kept across Trace view mounts. The host
 * mounts a fresh view each time its tab is shown again; a session seeded from
 * here shows the folder at once and revalidates it in the background
 * (stale-while-revalidate) instead of showing "Loading Trace…" on every tab
 * switch. Least recently used folders are evicted beyond `limit` folders or,
 * when a `weigh` function is given, beyond `budget` total weight.
 */
export interface SnapshotCache<T> {
  /** The value kept for `key`, which becomes the most recently used. */
  recall(key: string): T | undefined;
  remember(key: string, value: T): void;
  /** Forgets everything and starts a new epoch. */
  clear(): void;
  /** Bumped by `clear`: a writer that started in an earlier epoch must not write. */
  readonly epoch: number;
}

export interface SnapshotLimits<T> {
  /** Most entries kept. */
  readonly limit: number;
  /** Most total weight kept; an entry heavier than this alone is not kept. */
  readonly budget?: number;
  readonly weigh?: (value: T) => number;
}

const positive = (value: number | undefined): number => value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

export function createSnapshotCache<T>({ limit, budget, weigh }: SnapshotLimits<T>): SnapshotCache<T> {
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const maxWeight = weigh ? positive(budget) : Infinity;
  const entries = new Map<string, { value: T; weight: number }>();
  let total = 0;
  let epoch = 0;
  const drop = (key: string) => { const entry = entries.get(key); if (entry) { total -= entry.weight; entries.delete(key); } };
  return {
    recall(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    remember(key, value) {
      drop(key);
      const weight = weigh ? Math.max(0, weigh(value)) : 0;
      if (!capacity || weight > maxWeight) return;
      entries.set(key, { value, weight });
      total += weight;
      while (entries.size > capacity || total > maxWeight) drop(entries.keys().next().value!);
    },
    clear() { entries.clear(); total = 0; epoch += 1; },
    get epoch() { return epoch; },
  };
}
