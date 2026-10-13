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

/** Committed scenes kept per pane and folder: few entries, bounded by estimated bytes. */
export const SCENE_SNAPSHOT_LIMIT = 8;
export const SCENE_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/**
 * Immutable committed scenes, one per (pane, folder), kept alongside the folder
 * data so a remounted view can show its last scene before revalidating. The
 * store is generic over the scene and never copies or edits it; callers keep
 * stored values readonly. A value is kept only if `estimate` returns a finite,
 * non-negative size within the budget: malformed, oversized or unmeasurable
 * scenes are dropped (and replace, hence evict, any older scene for that key).
 */
export interface SceneStore<T> {
  /** The scene committed for this pane and folder, which becomes the most recently used. Never another folder's or pane's. */
  recall(paneId: string, directory: string): T | undefined;
  remember(paneId: string, directory: string, scene: T): void;
  /** Forgets everything and starts a new epoch. */
  clear(): void;
  readonly epoch: number;
}

export function createSceneStore<T extends object>(
  estimate: (scene: T) => number,
  { limit = SCENE_SNAPSHOT_LIMIT, bytes = SCENE_SNAPSHOT_BYTES }: { readonly limit?: number; readonly bytes?: number } = {},
): SceneStore<T> {
  const keyOf = (paneId: string, directory: string) => JSON.stringify([paneId, directory]);
  const measure = (scene: T): number => {
    if (!scene || typeof scene !== "object") return Number.NaN;
    try { return estimate(scene); } catch { return Number.NaN; }
  };
  // A non-finite or negative estimate cannot be budgeted: refuse it as oversized.
  const cache = createSnapshotCache<{ readonly scene: T; readonly size: number }>({
    limit, budget: bytes, weigh: (entry) => Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : Infinity,
  });
  return {
    recall(paneId, directory) { return cache.recall(keyOf(paneId, directory))?.scene; },
    remember(paneId, directory, scene) { cache.remember(keyOf(paneId, directory), { scene, size: measure(scene) }); },
    clear() { cache.clear(); },
    get epoch() { return cache.epoch; },
  };
}
