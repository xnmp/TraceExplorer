type ThumbnailResult = { ok: true; data: string } | { ok: false; error: string };
type Listener = (url: string) => void;
interface Entry {
  url: string;
  revision: number | undefined;
  pendingRevision: number | undefined;
  request: number;
  listeners: Set<Listener>;
}

/** Cache owns image URLs; views borrow them. Refreshes retain the previous image. */
export function createThumbnailCache(
  load: (path: string) => Promise<ThumbnailResult>,
  dispose: (url: string) => void,
  idleLimit = 64,
) {
  const entries = new Map<string, Entry>();

  function trim(): void {
    let idle = [...entries.values()].filter((entry) => entry.listeners.size === 0).length;
    for (const [path, entry] of entries) {
      if (idle <= idleLimit) break;
      if (entry.listeners.size) continue;
      entries.delete(path);
      entry.request += 1;
      if (entry.url) dispose(entry.url);
      idle -= 1;
    }
  }

  function subscribe(path: string, revision: number, listener: Listener): () => void {
    const entry = entries.get(path) ?? {
      url: "", revision: undefined, pendingRevision: undefined, request: 0, listeners: new Set<Listener>(),
    };
    entries.delete(path);
    entries.set(path, entry);
    entry.listeners.add(listener);
    listener(entry.url);
    if (entry.revision !== revision && entry.pendingRevision !== revision) {
      const request = ++entry.request;
      entry.pendingRevision = revision;
      void load(path).then((result) => {
        if (entries.get(path) !== entry || entry.request !== request) {
          if (result.ok) dispose(result.data);
          return;
        }
        entry.pendingRevision = undefined;
        if (!result.ok) return;
        const previous = entry.url;
        entry.url = result.data;
        entry.revision = revision;
        for (const subscriber of entry.listeners) subscriber(entry.url);
        if (previous && previous !== entry.url) dispose(previous);
      }).catch(() => {
        if (entry.request === request) entry.pendingRevision = undefined;
      });
    }
    trim();
    return () => { entry.listeners.delete(listener); trim(); };
  }

  function clear(): void {
    for (const entry of entries.values()) {
      entry.request += 1;
      if (entry.url) dispose(entry.url);
      for (const listener of entry.listeners) listener("");
    }
    entries.clear();
  }

  return { subscribe, clear, peek: (path: string): string => entries.get(path)?.url ?? "" };
}
