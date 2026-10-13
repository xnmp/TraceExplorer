import "./svelte-host";
import { describe, it, expect, vi } from "vitest";
import { createFolderVisibility } from "$lib/plugins/trace/folder-visibility.svelte";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe("folder visibility", () => {
  it("answers pending for an unknown folder, then true once the lookup resolves", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    expect(visibility.available("/pics")).toBe("pending");
    expect(lookup).not.toHaveBeenCalled(); // no synchronous side effects while reading
    await flush();
    expect(lookup).toHaveBeenCalledWith("/pics");
    expect(visibility.available("/pics")).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("looks up a folder asked about repeatedly only once", async () => {
    const lookup = vi.fn(async () => false);
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    visibility.available("/a"); visibility.available("/a");
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(visibility.available("/a")).toBe(false);
  });

  it.each(["", "demo://", "keep://some/folder", "DEMO://x"])("never offers or looks up %j", async (directory) => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    expect(visibility.available(directory)).toBe(false);
    await flush();
    visibility.refreshRecent();
    visibility.filesChanged([directory]);
    await flush();
    expect(lookup).not.toHaveBeenCalled();
    expect(visibility.available(directory)).toBe(false);
  });

  it("treats a Windows drive path as a real folder, not virtual", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    visibility.available("C:\\Users\\me");
    await flush();
    expect(visibility.available("C:\\Users\\me")).toBe(true);
  });

  it("keeps the last answer while a known folder is refreshing", async () => {
    let answer = Promise.resolve(true);
    const lookup = vi.fn(() => answer);
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    const next = deferred<boolean>();
    answer = next.promise;
    visibility.filesChanged(["/a"]);
    expect(visibility.available("/a")).toBe(true);
    next.resolve(false);
    await flush();
    expect(visibility.available("/a")).toBe(false);
  });

  it("filesChanged re-checks only matching cached folders, ignoring separators and trailing slashes", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    for (const d of ["C:/x/one", "/two", "/three"]) visibility.available(d);
    await flush();
    lookup.mockClear();
    visibility.filesChanged(["C:\\x\\one\\", "/two/", "/not/cached", "/thre"]);
    await flush();
    expect(lookup.mock.calls.map((c) => (c as unknown as [string])[0]).sort()).toEqual(["/two", "C:/x/one"]);
  });

  it("filesChanged ignores folders that were never looked up", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    visibility.filesChanged(["/never"]);
    await flush();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refreshRecent re-checks only recently asked folders, bounded to 16", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    for (let i = 0; i < 40; i++) visibility.available(`/d${i}`);
    await flush();
    lookup.mockClear();
    visibility.refreshRecent();
    await flush();
    const asked = lookup.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(asked).toHaveLength(16);
    expect(asked).toContain("/d39");
    expect(asked).not.toContain("/d0");
  });

  it("refreshRecent with nothing asked does nothing", async () => {
    const lookup = vi.fn(async () => true);
    createFolderVisibility(lookup).refreshRecent();
    await flush();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refreshes and re-runs once if dirtied", async () => {
    const gates = [deferred<boolean>(), deferred<boolean>()];
    const lookup = vi.fn(() => gates[lookup.mock.calls.length - 1]?.promise ?? Promise.resolve(true));
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);
    visibility.filesChanged(["/a"]);
    visibility.filesChanged(["/a"]);
    visibility.refreshRecent();
    expect(lookup).toHaveBeenCalledTimes(1);
    gates[0].resolve(false); // stale: the folder changed while it was in flight
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(visibility.available("/a")).toBe("pending"); // stale answer was not stored
    gates[1].resolve(true);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(visibility.available("/a")).toBe(true);
  });

  it("treats a rejected lookup as false", async () => {
    const lookup = vi.fn(async () => { throw new Error("nope"); });
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    expect(visibility.available("/a")).toBe(false);
  });

  it("only a literal true is accepted (malformed answers are false)", async () => {
    const lookup = vi.fn(async () => "yes" as unknown as boolean);
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    expect(visibility.available("/a")).toBe(false);
  });

  it("clear drops late results and forgets known folders", async () => {
    const gate = deferred<boolean>();
    const lookup = vi.fn(() => gate.promise);
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    visibility.clear();
    gate.resolve(true);
    await flush();
    expect(visibility.available("/a")).toBe("pending");
  });

  it("clear forgets previously known answers and recents", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    visibility.available("/a");
    await flush();
    expect(visibility.available("/a")).toBe(true);
    visibility.clear();
    lookup.mockClear();
    visibility.refreshRecent();
    await flush();
    expect(lookup).not.toHaveBeenCalled();
    expect(visibility.available("/a")).toBe("pending");
  });

  it("bounds the cache at 128 folders, evicting the oldest", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup);
    for (let i = 0; i < 130; i++) { visibility.available(`/d${i}`); await flush(); }
    lookup.mockClear();
    expect(visibility.available("/d129")).toBe(true);
    expect(visibility.available("/d2")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(visibility.available("/d0")).toBe("pending"); // evicted: unknown again
    await flush();
    expect(lookup).toHaveBeenCalledWith("/d0");
  });
});


describe("preloaded folder candidates", () => {
  it("answers pending for a non-candidate, then false when the exact lookup resolves", async () => {
    const lookup = vi.fn(async () => false);
    const loader = vi.fn(async () => ["/pics"]);
    const visibility = createFolderVisibility(lookup, loader);
    await visibility.preload();
    expect(visibility.available("/ordinary")).toBe("pending");
    await flush();
    visibility.refreshRecent();
    await flush();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(visibility.available("/ordinary")).toBe(false);
  });

  it("offers a non-candidate alias once its exact lookup says it has Trace content", async () => {
    // The host may name a folder by a symlink, short name or /var alias the canonical superset cannot match.
    const lookup = vi.fn(async (directory: string) => directory === "/alias");
    const visibility = createFolderVisibility(lookup, async () => ["/real"]);
    await visibility.preload();
    expect(visibility.available("/alias")).toBe("pending");
    await flush();
    expect(lookup).toHaveBeenCalledWith("/alias");
    expect(visibility.available("/alias")).toBe(true);
  });

  it("offers a candidate immediately, then keeps its exact false answer", async () => {
    const gate = deferred<boolean>();
    const lookup = vi.fn(() => gate.promise);
    const visibility = createFolderVisibility(lookup, async () => ["/pics"]);
    await visibility.preload();
    expect(visibility.available("/pics")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    await flush();
    expect(lookup).toHaveBeenCalledOnce();
    gate.resolve(false);
    await flush();
    expect(visibility.available("/pics")).toBe(false);
    await flush();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("answers pending and queues an exact lookup before preload completes", async () => {
    const candidates = deferred<readonly string[]>();
    const exact = deferred<boolean>();
    const lookup = vi.fn(() => exact.promise);
    const visibility = createFolderVisibility(lookup, () => candidates.promise);
    const loading = visibility.preload();
    expect(visibility.available("/pics")).toBe("pending");
    expect(lookup).not.toHaveBeenCalled();
    await flush();
    expect(lookup).toHaveBeenCalledWith("/pics");
    candidates.resolve(["/pics"]);
    await loading;
    expect(visibility.available("/pics")).toBe(true);
    exact.resolve(true);
    await flush();
    expect(visibility.available("/pics")).toBe(true);
  });

  it("reloads on Trace data changes and offers a previously unknown folder", async () => {
    let paths: readonly string[] = [];
    const lookup = vi.fn(() => new Promise<boolean>(() => {}));
    const visibility = createFolderVisibility(lookup, async () => paths);
    await visibility.preload();
    expect(visibility.available("/new")).toBe("pending");
    await flush();
    paths = ["/new"];
    visibility.refreshRecent();
    await flush();
    expect(visibility.available("/new")).toBe(true);
    expect(lookup).toHaveBeenCalledWith("/new");
  });

  it("clear discards an old candidate load even after reactivation", async () => {
    const old = deferred<readonly string[]>();
    const loader = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(["/new"]);
    const lookup = vi.fn(() => new Promise<boolean>(() => {}));
    const visibility = createFolderVisibility(lookup, loader);
    const loading = visibility.preload();
    visibility.clear();
    await visibility.preload();
    old.resolve(["/stale"]);
    await loading;
    expect(visibility.available("/stale")).toBe("pending");
    expect(visibility.available("/new")).toBe(true);
  });

  it("discards an older reload that finishes after a newer one", async () => {
    const old = deferred<readonly string[]>();
    const loader = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(["/new"]);
    const visibility = createFolderVisibility(vi.fn(async () => true), loader);
    const loading = visibility.preload();
    await visibility.preload();
    old.resolve(["/stale"]);
    await loading;
    expect(visibility.available("/stale")).toBe("pending");
    expect(visibility.available("/new")).toBe(true);
    await flush();
  });

  it("falls back to exact lookups when a candidate load fails", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup, async () => { throw new Error("offline"); });
    await visibility.preload();
    expect(visibility.available("/pics")).toBe("pending");
    await flush();
    expect(visibility.available("/pics")).toBe(true);
    expect(lookup).toHaveBeenCalledWith("/pics");
  });

  it.each([
    [["/pics"], "/pics///", true],
    [["/"], "/", true],
    [["C:\\Users\\ME\\"], "c:/users/me/", true],
    [["C:/"], "c:\\", true],
    [["\\\\Server\\Share\\Pictures"], "//server/share/pictures/", true],
    [["/Pics"], "/pics", false],
    [["//WSL.LOCALHOST/Ubuntu/Pics"], "//wsl.localhost/Ubuntu/pics", false],
  ] as const)("compares candidates %j to %j as %j", async (paths, directory, expected) => {
    const lookup = vi.fn(() => new Promise<boolean>(() => {}));
    const visibility = createFolderVisibility(lookup, async () => paths);
    await visibility.preload();
    expect(visibility.available(directory)).toBe(expected ? true : "pending");
    expect(lookup).not.toHaveBeenCalled();
    await flush();
    expect(lookup).toHaveBeenCalledOnce(); // a miss is not authoritative: aliases are still looked up
  });

  it("keeps candidates outside the bounded exact cache", async () => {
    const paths = Array.from({ length: 130 }, (_, i) => `/d${i}`);
    const lookup = vi.fn(async () => false);
    const visibility = createFolderVisibility(lookup, async () => paths);
    await visibility.preload();
    for (const path of paths) { visibility.available(path); await flush(); }
    expect(visibility.available("/d129")).toBe(false);
    expect(visibility.available("/d0")).toBe(true); // exact answer evicted, still a candidate
    await flush();
    expect(visibility.available("/d0")).toBe(false);
  });

  it("clear also drops an exact lookup queued by available", async () => {
    const lookup = vi.fn(async () => true);
    const visibility = createFolderVisibility(lookup, async () => ["/pics"]);
    await visibility.preload();
    expect(visibility.available("/pics")).toBe(true);
    visibility.clear();
    await flush();
    expect(lookup).not.toHaveBeenCalled();
    expect(visibility.available("/pics")).toBe("pending");
    await flush();
  });
});
