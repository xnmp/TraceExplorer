import { describe, expect, it, vi } from "vitest";
import { createDefaultEngine, engines, memoizeEngine, CACHE_BYTES, CACHE_ENTRIES, type FolderLayoutEngine } from "$lib/domain/trace-graph/folder-layout";
import { createBoundedCache } from "$lib/domain/trace-graph/folder-layout/bounded-cache";
import { stableKey } from "$lib/domain/trace-graph/folder-layout/stable-key";
import { folderInput, handCase, makeFolder } from "./folder-layout-fixtures";

const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 3 });
const input = (width = 640, focus: string | null = null) => folderInput(folder, { open: ["s0:root", "s1:root"], width, focus });

describe("memoizeEngine", () => {
  it("answers a structurally equal input (rebuilt or cloned) from the cache, with the engine's own output", () => {
    const engine = vi.fn(engines.default), memo = memoizeEngine(engine);
    const first = memo(input());
    expect(memo(input())).toBe(first);
    expect(memo(structuredClone(input()))).toBe(first);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(first).toEqual(engines.default(input()));
    expect(memo(input(900))).not.toBe(first);
    expect(engine).toHaveBeenCalledTimes(2);
  });
  it("keys on the previous layout too", () => {
    const engine = vi.fn(engines.default), memo = memoizeEngine(engine);
    const previous = memo(input(640, "s0:Saffron"));
    const withHistory = memo({ ...input(640, "s0:Ash"), previous });
    expect(memo({ ...input(640, "s0:Ash"), previous: structuredClone(previous) })).toBe(withHistory);
    expect(memo(input(640, "s0:Ash"))).not.toBe(withHistory);
    expect(engine).toHaveBeenCalledTimes(3);
  });
  it("holds at most 48 entries by default and evicts the least recently used", () => {
    const memo = memoizeEngine(engines.default), widths = Array.from({ length: CACHE_ENTRIES + 2 }, (_, i) => 400 + 16 * i);
    const first = memo(input(widths[0]));
    for (const width of widths.slice(1, CACHE_ENTRIES)) memo(input(width));
    expect(memo(input(widths[0]))).toBe(first); // refreshed: now most recent
    memo(input(widths[CACHE_ENTRIES])); memo(input(widths[CACHE_ENTRIES + 1]));
    expect(memo.stats().entries).toBe(CACHE_ENTRIES);
    expect(memo(input(widths[0]))).toBe(first);
    expect(memo.stats().bytes).toBeLessThanOrEqual(CACHE_BYTES);
  });
  it("returns results larger than the byte budget uncached, and identical", () => {
    const engine = vi.fn(engines.default), memo = memoizeEngine(engine, { maxBytes: 1024 });
    const a = memo(input()), b = memo(input());
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
    expect(memo.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(engine).toHaveBeenCalledTimes(2);
  });
  it("does not cache a throwing input", () => {
    const engine = vi.fn(engines.default), memo = memoizeEngine(engine);
    expect(() => memo({ ...input(), width: NaN })).toThrow(RangeError);
    expect(() => memo({ ...input(), width: NaN })).toThrow(RangeError);
    expect(engine).toHaveBeenCalledTimes(2);
    expect(memo.stats().entries).toBe(0);
  });
  it("rejects invalid budgets", () => {
    expect(() => memoizeEngine(engines.default, { maxEntries: -1 })).toThrow(RangeError);
    expect(() => memoizeEngine(engines.default, { maxBytes: NaN })).toThrow(RangeError);
  });
});

describe("default engine band cache", () => {
  it("gives the same output with and without the per-band cache, cold or warm", () => {
    const cached = createDefaultEngine(), uncached: FolderLayoutEngine = createDefaultEngine({ bandCache: null });
    const steps = [null, "s0:Saffron", "s1:ab", "s0:Saffron", null];
    let a = null, b = null;
    for (const focus of steps) {
      const left = cached({ ...input(640, focus), previous: a }), right = uncached({ ...input(640, focus), previous: b });
      expect(left).toEqual(right);
      a = left; b = right;
    }
    // Warm: a second pass over the same inputs reuses band layouts and still agrees.
    expect(cached(input(640, "s1:ab"))).toEqual(uncached(input(640, "s1:ab")));
  });
});

describe("bounded cache", () => {
  it("evicts by bytes, counting keys, and never keeps an oversized value", () => {
    const cache = createBoundedCache<string>((value) => value.length, { maxEntries: 10, maxBytes: 100 });
    cache.set("a", "x".repeat(40)); cache.set("b", "x".repeat(40));
    expect([cache.size, cache.bytes]).toEqual([2, 84]);
    cache.set("c", "x".repeat(40));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    cache.set("d", "x".repeat(200));
    expect(cache.get("d")).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(100);
    cache.set("b", "y");
    expect([cache.get("b"), cache.size]).toEqual(["y", 2]);
    cache.clear();
    expect([cache.size, cache.bytes]).toEqual([0, 0]);
  });
});

describe("stableKey", () => {
  it("distinguishes values JSON would conflate", () => {
    const keys = [NaN, null, undefined, 0, -0, Infinity, "1", 1, [], {}, new Map(), new Set(), [1, 2], [[1], 2], { a: 1 }, new Map([["a", 1]]), new Set(["a"]), ["a"], "a,b", ["a", "b"]].map(stableKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("is equal for structurally equal plain data and rejects non-data", () => {
    const value = () => ({ items: [{ id: "a", kind: "stack" }], open: new Map([["a", { focus: null, members: ["a", "b"] }]]), set: new Set([1]) });
    expect(stableKey(value())).toBe(stableKey(structuredClone(value())));
    const shared = { x: 1 };
    expect(stableKey([shared, shared])).toBe(stableKey([{ x: 1 }, { x: 1 }]));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => stableKey(cyclic)).toThrow(TypeError);
    expect(() => stableKey({ f: () => 1 })).toThrow(TypeError);
    expect(() => stableKey(new Date())).toThrow(TypeError);
  });
});
