type ThumbnailResult = { ok: true; data: string } | { ok: false; error: string };
type Listener = (url: string) => void;
interface Entry {
  url: string;
  revision: number | undefined;
  pendingRevision: number | undefined;
  /** The revision whose newest request failed: a preparation does not wait for it again. */
  failed: number | undefined;
  request: number;
  /** The newest request; it settles once loaded and decoded, failed, or superseded. */
  loading: Promise<void> | null;
  /** What `decode` returned for `url`, kept as long as the URL is (it keeps the decoded image alive). */
  retained: unknown;
  listeners: Set<Listener>;
  /** Scene preparations waiting for this image (`hold`): in use, like a listener. */
  holds: number;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A preparation's interest in images: `ready` settles once each one is drawable or has failed. */
export interface ThumbnailHold {
  readonly ready: Promise<void>;
  release(): void;
}

/**
 * Cache owns image URLs; views borrow them. Refreshes retain the previous image.
 *
 * With `decode`, an image is published (to listeners and `peek`) only once it is decoded, so a
 * view never draws an `<img>` that is still loading: until then it draws its placeholder.
 * `decode` returns what keeps the decoded image alive (an image element); it is dropped with the URL.
 */
export function createThumbnailCache(
  load: (path: string) => Promise<ThumbnailResult>,
  dispose: (url: string) => void,
  idleLimit = 64,
  decode?: (url: string) => Promise<unknown>,
) {
  const entries = new Map<string, Entry>();
  /** Settles holds made before the next `clear`: nothing they wait for will be published. */
  let cleared: { promise: Promise<void>; resolve: () => void } = signal();
  const inUse = (entry: Entry) => entry.listeners.size > 0 || entry.holds > 0;

  function drop(entry: Entry): void {
    entry.request += 1;
    if (entry.url) dispose(entry.url);
    entry.retained = undefined;
  }

  function trim(): void {
    let idle = [...entries.values()].filter((entry) => !inUse(entry)).length;
    for (const [path, entry] of entries) {
      if (idle <= idleLimit) break;
      if (inUse(entry)) continue;
      entries.delete(path);
      drop(entry);
      idle -= 1;
    }
  }

  /** The entry for `path`, made the most recently used. */
  function touch(path: string): Entry {
    const entry = entries.get(path) ?? {
      url: "", revision: undefined, pendingRevision: undefined, failed: undefined, request: 0, loading: null, retained: undefined, listeners: new Set<Listener>(), holds: 0,
    };
    entries.delete(path);
    entries.set(path, entry);
    return entry;
  }

  /** Starts loading `revision` unless it is loaded or loading. */
  function request(path: string, entry: Entry, revision: number): void {
    if (entry.revision === revision || entry.pendingRevision === revision) return;
    const request = ++entry.request;
    entry.pendingRevision = revision;
    const current = () => entries.get(path) === entry && entry.request === request;
    entry.loading = (async () => {
      let result: ThumbnailResult;
      try { result = await load(path); }
      catch { if (entry.request === request) { entry.pendingRevision = undefined; entry.failed = revision; } return; }
      if (!current()) { if (result.ok) dispose(result.data); return; }
      if (!result.ok) { entry.pendingRevision = undefined; entry.failed = revision; return; }
      // A failed decode still publishes the URL: the view draws whatever the browser makes of it.
      const retained = decode ? await decode(result.data).catch(() => undefined) : undefined;
      if (!current()) { dispose(result.data); return; }
      entry.pendingRevision = undefined;
      entry.failed = undefined;
      const previous = entry.url;
      entry.url = result.data;
      entry.retained = retained;
      entry.revision = revision;
      for (const subscriber of entry.listeners) subscriber(entry.url);
      if (previous && previous !== entry.url) dispose(previous);
    })();
  }

  function subscribe(path: string, revision: number, listener: Listener): () => void {
    const entry = touch(path);
    entry.listeners.add(listener);
    listener(entry.url);
    request(path, entry, revision);
    trim();
    return () => { entry.listeners.delete(listener); trim(); };
  }

  /** Settles once `entry` has an image, or its newest request has settled without one. */
  function settled(entry: Entry): Promise<void> {
    const loading = entry.loading;
    if (entry.url || !loading || entry.pendingRevision === undefined) return Promise.resolve();
    return loading.then(() => entry.loading === loading ? undefined : settled(entry));
  }

  /**
   * Prepares `paths` for a scene about to draw them. Null when every one already has an image (a
   * newer revision still loading keeps the previous one, as views do), so a ready scene waits for
   * nothing, and so does an image whose load for `revision` already failed. Otherwise their loads
   * start, or are joined, and `ready` settles once each has its image or has failed (a view then
   * draws its placeholder, which is final). Held entries are not evicted until `release`; views
   * that subscribe meanwhile keep them.
   */
  function hold(paths: Iterable<string>, revision: number): ThumbnailHold | null {
    const waiting: Entry[] = [];
    for (const path of new Set(paths)) {
      const known = entries.get(path);
      if (known && (known.url || known.failed === revision)) continue;
      const entry = touch(path);
      request(path, entry, revision);
      entry.holds += 1;
      waiting.push(entry);
    }
    trim();
    if (!waiting.length) return null;
    let released = false;
    return {
      ready: Promise.race([Promise.all(waiting.map(settled)).then(() => undefined), cleared.promise]),
      release() {
        if (released) return;
        released = true;
        for (const entry of waiting) entry.holds -= 1;
        trim();
      },
    };
  }

  function clear(): void {
    cleared.resolve();
    cleared = signal();
    for (const entry of entries.values()) {
      drop(entry);
      entry.loading = null;
      for (const listener of entry.listeners) listener("");
    }
    entries.clear();
  }

  return { subscribe, hold, clear, peek: (path: string): string => entries.get(path)?.url ?? "" };
}
