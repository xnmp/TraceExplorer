import { describe, expect, it } from "vitest";
import { createSnapshotCache } from "$lib/plugins/trace/view/folder-snapshots";

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
