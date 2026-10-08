import "./svelte-host";
import { describe, it, expect } from "vitest";
import { createRevisionCache } from "$lib/plugins/trace/view/revision-cache.svelte";
import type { ApiResult } from "$lib/api/common";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

/** A loader whose calls are answered by the test, in any order. */
function controlled<K, V>() {
  const calls: Array<{ key: K; answer: (result: ApiResult<V>) => void }> = [];
  const load = (key: K) => { const pending = deferred<ApiResult<V>>(); calls.push({ key, answer: pending.resolve }); return pending.promise; };
  return { calls, load };
}

describe("createRevisionCache", () => {
  it("reports an unknown key as pending until its load completes", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    expect(cache.read(1, 0)).toEqual({ known: false, value: undefined, pending: true, error: "" });
    cache.request(1, 0);
    calls[0].answer({ ok: true, data: "one" });
    await flush();
    expect(cache.read(1, 0)).toEqual({ known: true, value: "one", pending: false, error: "" });
  });

  it("loads each key once per revision", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    cache.request(1, 0);
    cache.request(1, 0);
    expect(calls).toHaveLength(1);
    calls[0].answer({ ok: true, data: "one" });
    await flush();
    cache.request(1, 0);
    expect(calls).toHaveLength(1);
    cache.request(2, 0);
    expect(calls.map((call) => call.key)).toEqual([1, 2]);
  });

  it("keeps the previous value while a newer revision loads, then replaces it", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    cache.request(1, 0);
    calls[0].answer({ ok: true, data: "old" });
    await flush();
    cache.request(1, 1);
    expect(cache.read(1, 1)).toEqual({ known: true, value: "old", pending: true, error: "" });
    calls[1].answer({ ok: true, data: "new" });
    await flush();
    expect(cache.read(1, 1)).toEqual({ known: true, value: "new", pending: false, error: "" });
  });

  it("never lets an older revision's late answer replace a newer one", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    cache.request(1, 0);
    cache.request(1, 1);
    calls[1].answer({ ok: true, data: "new" });
    await flush();
    calls[0].answer({ ok: true, data: "old" });
    await flush();
    expect(cache.read(1, 1).value).toBe("new");
  });

  it("reports a failed load with the last good value, and retries it when requested again", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    cache.request(1, 0);
    calls[0].answer({ ok: true, data: "good" });
    await flush();
    cache.request(1, 1);
    calls[1].answer({ ok: false, error: "offline" });
    await flush();
    expect(cache.read(1, 1)).toEqual({ known: true, value: "good", pending: false, error: "offline" });
    cache.request(1, 1);
    expect(calls).toHaveLength(3);
    calls[2].answer({ ok: true, data: "back" });
    await flush();
    expect(cache.read(1, 1)).toEqual({ known: true, value: "back", pending: false, error: "" });
  });

  it("treats a rejected load as a failure", async () => {
    const cache = createRevisionCache<number, string>(() => Promise.reject(new Error("backend died")));
    cache.request(1, 0);
    await flush();
    expect(cache.read(1, 0)).toEqual({ known: false, value: undefined, pending: false, error: "backend died" });
  });

  it("stores null as a known value", async () => {
    const cache = createRevisionCache<string, null>(async () => ({ ok: true, data: null }));
    cache.request("/a.png", 0);
    await flush();
    expect(cache.read("/a.png", 0)).toEqual({ known: true, value: null, pending: false, error: "" });
  });

  it("drops loads that complete after a clear", async () => {
    const { calls, load } = controlled<number, string>();
    const cache = createRevisionCache(load);
    cache.request(1, 0);
    cache.clear();
    calls[0].answer({ ok: true, data: "stale" });
    await flush();
    expect(cache.read(1, 0).known).toBe(false);
    cache.request(1, 0);
    expect(calls).toHaveLength(2);
  });

  it("evicts the oldest keys beyond its limit", async () => {
    const cache = createRevisionCache<number, number>(async (key) => ({ ok: true, data: key }), 3);
    for (const key of [1, 2, 3, 4, 5]) cache.request(key, 0);
    await flush();
    expect([1, 2, 3, 4, 5].map((key) => cache.read(key, 0).known)).toEqual([false, false, true, true, true]);
  });
});
