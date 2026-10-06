import { describe, expect, it, vi } from "vitest";
import { createThumbnailCache } from "../src/lib/domain/thumbnail-cache";

function fixture(idleLimit = 64) {
  const requests: Array<{ path: string; resolve: (value: { ok: true; data: string } | { ok: false; error: string }) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((path: string) => new Promise<{ ok: true; data: string } | { ok: false; error: string }>((resolve, reject) => requests.push({ path, resolve, reject })));
  const dispose = vi.fn();
  return { cache: createThumbnailCache(load, dispose, idleLimit), load, dispose, requests };
}
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
