import { describe, expect, it } from "vitest";
import { createSnapshotCache } from "$lib/plugins/trace/view/folder-snapshots";

describe("folder snapshot cache", () => {
  it("returns what was remembered for a key, and nothing for others", () => {
    const cache = createSnapshotCache<number>(2);
    cache.remember("/a", 1);
    expect(cache.recall("/a")).toBe(1);
    expect(cache.recall("/b")).toBeUndefined();
    cache.remember("/a", 2);
    expect(cache.recall("/a")).toBe(2);
  });

  it("evicts the least recently used folder beyond its limit; recalling counts as use", () => {
    const cache = createSnapshotCache<string>(2);
    cache.remember("/a", "a"); cache.remember("/b", "b");
    cache.recall("/a");
    cache.remember("/c", "c");
    expect(cache.recall("/b")).toBeUndefined();
    expect(cache.recall("/a")).toBe("a");
    expect(cache.recall("/c")).toBe("c");
  });

  it("keeps nothing for a zero, negative or non-integer limit", () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = createSnapshotCache<number>(limit);
      cache.remember("/a", 1);
      expect(cache.recall("/a")).toBeUndefined();
    }
  });

  it("stays bounded under many folders", () => {
    const cache = createSnapshotCache<number>(8);
    for (let i = 0; i < 10_000; i++) cache.remember(`/f${i}`, i);
    expect(cache.recall("/f9999")).toBe(9999);
    expect(cache.recall("/f9991")).toBeUndefined();
    expect(cache.recall("/f9992")).toBe(9992);
  });

  it("clear forgets everything", () => {
    const cache = createSnapshotCache<number>(4);
    cache.remember("/a", 1); cache.clear();
    expect(cache.recall("/a")).toBeUndefined();
  });
});
