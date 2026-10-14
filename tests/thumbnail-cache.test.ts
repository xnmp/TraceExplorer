import { describe, expect, it, vi } from "vitest";
import { createThumbnailCache } from "../src/lib/domain/thumbnail-cache";

function fixture(idleLimit = 64, decode?: (url: string) => Promise<unknown>) {
  const requests: Array<{ path: string; resolve: (value: { ok: true; data: string } | { ok: false; error: string }) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((path: string) => new Promise<{ ok: true; data: string } | { ok: false; error: string }>((resolve, reject) => requests.push({ path, resolve, reject })));
  const dispose = vi.fn();
  return { cache: createThumbnailCache(load, dispose, idleLimit, decode), load, dispose, requests };
}
/** Decodes the test settles by hand, by URL. */
function decoder() {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const decode = vi.fn((url: string) => new Promise<unknown>((resolve, reject) => pending.set(url, { resolve: () => resolve({ decoded: url }), reject })));
  return { decode, finish: (url: string) => pending.get(url)!.resolve(), fail: (url: string) => pending.get(url)!.reject(new Error("EncodingError")) };
}
const settles = async (promise: Promise<unknown>) => { let done = false; void promise.then(() => { done = true; }); await new Promise((resolve) => setTimeout(resolve, 0)); return done; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("thumbnail URL ownership and reuse", () => {
  it("shares one request and preserves a decoded URL across view remounts", async () => {
    const { cache, load, dispose, requests } = fixture();
    const first = vi.fn(); const second = vi.fn();
    const release = cache.subscribe("image.png", 1, first);
    const releaseSecond = cache.subscribe("image.png", 1, second);
    requests[0].resolve({ ok: true, data: "blob:image" }); await tick();
    expect(first).toHaveBeenLastCalledWith("blob:image");
    expect(second).toHaveBeenLastCalledWith("blob:image");
    release(); releaseSecond();
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.peek("image.png")).toBe("blob:image");
    const remounted = vi.fn(); cache.subscribe("image.png", 1, remounted);
    expect(remounted).toHaveBeenCalledWith("blob:image");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retains a pending load across remounts and delivers it to the current view", async () => {
    const { cache, load, requests } = fixture();
    const old = vi.fn(); cache.subscribe("image.png", 1, old)();
    const current = vi.fn(); cache.subscribe("image.png", 1, current);
    requests[0].resolve({ ok: true, data: "blob:image" }); await tick();
    expect(load).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalledWith("blob:image");
    expect(current).toHaveBeenLastCalledWith("blob:image");
  });

  it("keeps the previous thumbnail visible while refreshing and discards late stale replies", async () => {
    const { cache, requests, dispose } = fixture();
    const current = vi.fn(); const release = cache.subscribe("image.png", 1, current);
    requests[0].resolve({ ok: true, data: "blob:first" }); await tick(); release();
    const releaseNext = cache.subscribe("image.png", 2, current);
    expect(current).toHaveBeenLastCalledWith("blob:first"); releaseNext();
    cache.subscribe("image.png", 3, current);
    requests[2].resolve({ ok: true, data: "blob:newest" }); await tick();
    requests[1].resolve({ ok: true, data: "blob:stale" }); await tick();
    expect(current).toHaveBeenLastCalledWith("blob:newest");
    expect(dispose.mock.calls).toEqual([["blob:first"], ["blob:stale"]]);
  });

  it("preserves the last good image on failed refresh and allows a retry", async () => {
    const { cache, requests, dispose } = fixture();
    const current = vi.fn(); const first = cache.subscribe("image.png", 1, current);
    requests[0].resolve({ ok: true, data: "blob:first" }); await tick(); first();
    const next = cache.subscribe("image.png", 2, current);
    requests[1].reject(new Error("Offline")); await tick(); next();
    const retry = cache.subscribe("image.png", 2, current);
    requests[2].resolve({ ok: false, error: "Missing" }); await tick(); retry();
    cache.subscribe("image.png", 2, current);
    expect(requests).toHaveLength(4);
    expect(current).toHaveBeenLastCalledWith("blob:first");
    expect(dispose).not.toHaveBeenCalled();
  });

  it("bounds idle resources without revoking images still displayed by a view", async () => {
    const { cache, requests, dispose } = fixture(1);
    const releaseActive = cache.subscribe("active.png", 1, () => {});
    requests[0].resolve({ ok: true, data: "blob:active" }); await tick();
    cache.subscribe("old.png", 1, () => {})();
    requests[1].resolve({ ok: true, data: "blob:old" }); await tick();
    cache.subscribe("recent.png", 1, () => {})();
    requests[2].resolve({ ok: true, data: "blob:recent" }); await tick();
    expect(dispose.mock.calls).toEqual([["blob:old"]]);
    expect(cache.peek("active.png")).toBe("blob:active");
    expect(cache.peek("old.png")).toBe("");
    releaseActive();
    expect(dispose).toHaveBeenCalledWith("blob:active");
  });

  it("clears cached resources on plugin disposal and releases late pending results", async () => {
    const { cache, requests, dispose } = fixture();
    const current = vi.fn(); cache.subscribe("image.png", 1, current);
    requests[0].resolve({ ok: true, data: "blob:first" }); await tick();
    cache.subscribe("pending.png", 1, () => {});
    cache.clear();
    requests[1].resolve({ ok: true, data: "blob:late" }); await tick();
    expect(current).toHaveBeenLastCalledWith("");
    expect(cache.peek("image.png")).toBe("");
    expect(dispose.mock.calls).toEqual([["blob:first"], ["blob:late"]]);
  });
});

describe("decoded thumbnails and scene preparation holds", () => {
  it("publishes an image only once it is decoded", async () => {
    const d = decoder();
    const { cache, requests } = fixture(64, d.decode);
    const view = vi.fn(); cache.subscribe("image.png", 1, view);
    requests[0].resolve({ ok: true, data: "blob:image" }); await tick();
    expect(d.decode).toHaveBeenCalledWith("blob:image");
    expect(cache.peek("image.png"), "loaded but not decoded: not drawable yet").toBe("");
    expect(view).not.toHaveBeenCalledWith("blob:image");
    d.finish("blob:image"); await tick(); await tick();
    expect(cache.peek("image.png")).toBe("blob:image");
    expect(view).toHaveBeenLastCalledWith("blob:image");
  });

  it("a failed decode still publishes the URL (the browser draws what it can)", async () => {
    const d = decoder();
    const { cache, requests } = fixture(64, d.decode);
    const hold = cache.hold(["image.png"], 1)!;
    requests[0].resolve({ ok: true, data: "blob:image" }); await tick();
    d.fail("blob:image");
    expect(await settles(hold.ready)).toBe(true);
    expect(cache.peek("image.png")).toBe("blob:image");
  });

  it("holds nothing when every image is drawable, including one whose newer revision still loads", async () => {
    const { cache, requests, load } = fixture();
    cache.subscribe("a.png", 1, () => {});
    requests[0].resolve({ ok: true, data: "blob:a" }); await tick();
    cache.subscribe("a.png", 2, () => {});
    expect(cache.hold(["a.png"], 2)).toBeNull();
    expect(cache.hold([], 2)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("joins a view's request, settles once every image is drawable, and loads each path once", async () => {
    const { cache, requests, load } = fixture();
    cache.subscribe("a.png", 1, () => {});
    const hold = cache.hold(["a.png", "b.png", "b.png"], 1)!;
    expect(load).toHaveBeenCalledTimes(2);
    requests[0].resolve({ ok: true, data: "blob:a" });
    expect(await settles(hold.ready), "b is still loading").toBe(false);
    requests[1].resolve({ ok: true, data: "blob:b" });
    expect(await settles(hold.ready)).toBe(true);
  });

  it("settles on a failed load (the placeholder is final) and does not wait for that revision again", async () => {
    const { cache, requests, load } = fixture();
    const hold = cache.hold(["missing.png", "broken.png"], 1)!;
    requests[0].resolve({ ok: false, error: "Missing" });
    requests[1].reject(new Error("Offline"));
    expect(await settles(hold.ready)).toBe(true);
    expect(cache.hold(["missing.png", "broken.png"], 1), "a failed revision is not waited for again").toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    // A newer revision is tried again; a view mounting retries as before.
    expect(cache.hold(["missing.png"], 2)).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("follows a newer request for the same image instead of settling on the superseded one", async () => {
    const { cache, requests } = fixture();
    const hold = cache.hold(["a.png"], 1)!;
    cache.subscribe("a.png", 2, () => {});
    requests[0].resolve({ ok: true, data: "blob:old" });
    expect(await settles(hold.ready), "the superseded reply is discarded").toBe(false);
    requests[1].resolve({ ok: true, data: "blob:new" });
    expect(await settles(hold.ready)).toBe(true);
    expect(cache.peek("a.png")).toBe("blob:new");
  });

  it("keeps held images from eviction until released", async () => {
    const { cache, requests, dispose } = fixture(0);
    const hold = cache.hold(["held.png"], 1)!;
    requests[0].resolve({ ok: true, data: "blob:held" });
    expect(await settles(hold.ready)).toBe(true);
    cache.subscribe("other.png", 1, () => {})();
    expect(cache.peek("held.png"), "held: not idle").toBe("blob:held");
    hold.release(); hold.release();
    expect(cache.peek("held.png")).toBe("");
    expect(dispose).toHaveBeenCalledWith("blob:held");
  });

  it("settles a hold when the cache is cleared under it, and releases the late result", async () => {
    const { cache, requests, dispose } = fixture();
    const hold = cache.hold(["a.png"], 1)!;
    cache.clear();
    expect(await settles(hold.ready)).toBe(true);
    requests[0].resolve({ ok: true, data: "blob:late" }); await tick();
    expect(dispose).toHaveBeenCalledWith("blob:late");
    expect(cache.peek("a.png")).toBe("");
  });

  it("holds many images (more than the idle limit) without evicting any of them", async () => {
    const { cache, requests } = fixture(2);
    const paths = Array.from({ length: 50 }, (_, i) => `${i}.png`);
    const hold = cache.hold(paths, 1)!;
    requests.forEach((request, i) => request.resolve({ ok: true, data: `blob:${i}` }));
    expect(await settles(hold.ready)).toBe(true);
    expect(paths.every((path) => cache.peek(path) !== "")).toBe(true);
  });
});
