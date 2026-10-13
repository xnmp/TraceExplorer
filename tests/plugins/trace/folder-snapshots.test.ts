import { describe, expect, it } from "vitest";
import { createSceneStore, createSnapshotCache } from "$lib/plugins/trace/view/folder-snapshots";

describe("folder snapshot cache", () => {
  it("returns what was remembered for a key, and nothing for others", () => {
    const cache = createSnapshotCache<number>({ limit: 2 });
    cache.remember("/a", 1);
    expect(cache.recall("/a")).toBe(1);
    expect(cache.recall("/b")).toBeUndefined();
    cache.remember("/a", 2);
    expect(cache.recall("/a")).toBe(2);
  });

  it("evicts the least recently used folder beyond its limit; recalling counts as use", () => {
    const cache = createSnapshotCache<string>({ limit: 2 });
    cache.remember("/a", "a"); cache.remember("/b", "b");
    cache.recall("/a");
    cache.remember("/c", "c");
    expect(cache.recall("/b")).toBeUndefined();
    expect(cache.recall("/a")).toBe("a");
    expect(cache.recall("/c")).toBe("c");
  });

  it("keeps nothing for a zero, negative or non-integer limit", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = createSnapshotCache<number>({ limit: limit });
      cache.remember("/a", 1);
      expect(cache.recall("/a")).toBeUndefined();
    }
  });

  it("stays bounded under many folders", () => {
    const cache = createSnapshotCache<number>({ limit: 8 });
    for (let i = 0; i < 10_000; i++) cache.remember(`/f${i}`, i);
    expect(cache.recall("/f9999")).toBe(9999);
    expect(cache.recall("/f9991")).toBeUndefined();
    expect(cache.recall("/f9992")).toBe(9992);
  });

  it("clear forgets everything", () => {
    const cache = createSnapshotCache<number>({ limit: 4 });
    cache.remember("/a", 1); cache.clear();
    expect(cache.recall("/a")).toBeUndefined();
  });

  it("evicts least recently used folders to stay within a weight budget, and keeps nothing heavier than it", () => {
    const cache = createSnapshotCache<number>({ limit: 8, budget: 10, weigh: (n) => n });
    cache.remember("/a", 4); cache.remember("/b", 4);
    cache.recall("/a");
    cache.remember("/c", 4);
    expect(cache.recall("/b")).toBeUndefined();
    expect(cache.recall("/a")).toBe(4);
    expect(cache.recall("/c")).toBe(4);
    cache.remember("/huge", 11);
    expect(cache.recall("/huge")).toBeUndefined();
    expect(cache.recall("/a")).toBe(4);
  });

  it("replacing a folder's value re-weighs it", () => {
    const cache = createSnapshotCache<number>({ limit: 8, budget: 10, weigh: (n) => n });
    cache.remember("/a", 9); cache.remember("/a", 2); cache.remember("/b", 8);
    expect(cache.recall("/a")).toBe(2);
    expect(cache.recall("/b")).toBe(8);
  });

  it("clear starts a new epoch, so writers from before it can tell", () => {
    const cache = createSnapshotCache<number>({ limit: 2 });
    const before = cache.epoch;
    cache.clear();
    expect(cache.epoch).not.toBe(before);
  });
});

describe("scene store", () => {
  interface Scene { readonly name: string; readonly bytes: number }
  const scene = (name: string, bytes = 1): Scene => ({ name, bytes });
  const store = (limit = 8, bytes = 100) => createSceneStore<Scene>((value) => value.bytes, { limit, bytes });

  it("returns the committed scene itself for its pane and folder only", () => {
    const scenes = store();
    const a = scene("a");
    scenes.remember("p1", "/a", a);
    expect(scenes.recall("p1", "/a")).toBe(a);
    expect(scenes.recall("p1", "/b")).toBeUndefined();
    expect(scenes.recall("p2", "/a")).toBeUndefined();
    scenes.remember("p2", "/a", scene("other pane"));
    expect(scenes.recall("p1", "/a")).toBe(a);
  });

  it("does not confuse pane and folder names that concatenate alike", () => {
    const scenes = store();
    scenes.remember("a", "b/c", scene("one"));
    scenes.remember("a/b", "c", scene("two"));
    expect(scenes.recall("a", "b/c")?.name).toBe("one");
    expect(scenes.recall("a/b", "c")?.name).toBe("two");
  });

  it("replaces a folder's scene without touching what it held", () => {
    const scenes = store();
    const first = scene("first");
    scenes.remember("p", "/a", first);
    scenes.remember("p", "/a", scene("second"));
    expect(scenes.recall("p", "/a")?.name).toBe("second");
    expect(first).toEqual({ name: "first", bytes: 1 });
  });

  it("evicts the least recently used scene beyond eight entries by default", () => {
    const scenes = createSceneStore<Scene>(() => 1);
    for (let i = 0; i < 8; i++) scenes.remember("p", `/f${i}`, scene(`${i}`));
    scenes.recall("p", "/f0");
    scenes.remember("p", "/f8", scene("8"));
    expect(scenes.recall("p", "/f1")).toBeUndefined();
    expect(scenes.recall("p", "/f0")).toBeDefined();
    expect([...Array(9).keys()].filter((i) => scenes.recall("p", `/f${i}`)).length).toBe(8);
  });

  it("evicts by estimated bytes, oldest first", () => {
    const scenes = store(8, 100);
    scenes.remember("p", "/a", scene("a", 60));
    scenes.remember("p", "/b", scene("b", 30));
    scenes.remember("p", "/c", scene("c", 30));
    expect(scenes.recall("p", "/a")).toBeUndefined();
    expect(scenes.recall("p", "/b")).toBeDefined();
    expect(scenes.recall("p", "/c")).toBeDefined();
  });

  it("defaults to a 16 MiB budget", () => {
    const scenes = createSceneStore<Scene>((value) => value.bytes);
    scenes.remember("p", "/fits", scene("fits", 16 * 1024 * 1024));
    scenes.remember("p", "/huge", scene("huge", 16 * 1024 * 1024 + 1));
    expect(scenes.recall("p", "/fits")).toBeDefined();
    expect(scenes.recall("p", "/huge")).toBeUndefined();
  });

  it("refuses an oversized scene, and forgets the older scene it would have replaced", () => {
    const scenes = store(8, 100);
    scenes.remember("p", "/a", scene("old", 10));
    scenes.remember("p", "/a", scene("huge", 101));
    expect(scenes.recall("p", "/a")).toBeUndefined();
  });

  it("refuses scenes it cannot measure", () => {
    const badSizes = [Number.NaN, -1, Number.POSITIVE_INFINITY];
    for (const bytes of badSizes) {
      const scenes = store();
      scenes.remember("p", "/a", scene("bad", bytes));
      expect(scenes.recall("p", "/a")).toBeUndefined();
    }
    const throwing = createSceneStore<Scene>(() => { throw new Error("cyclic"); });
    throwing.remember("p", "/a", scene("a"));
    expect(throwing.recall("p", "/a")).toBeUndefined();
    const nothing = createSceneStore<Scene>(() => 1);
    nothing.remember("p", "/a", null as never);
    expect(nothing.recall("p", "/a")).toBeUndefined();
  });

  it("keeps nothing for an invalid limit, and forgets everything on clear with a new epoch", () => {
    const none = createSceneStore<Scene>(() => 1, { limit: 0 });
    none.remember("p", "/a", scene("a"));
    expect(none.recall("p", "/a")).toBeUndefined();
    const scenes = store();
    const before = scenes.epoch;
    scenes.remember("p", "/a", scene("a"));
    scenes.clear();
    expect(scenes.recall("p", "/a")).toBeUndefined();
    expect(scenes.epoch).toBe(before + 1);
  });
});
