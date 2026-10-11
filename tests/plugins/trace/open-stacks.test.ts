import { describe, expect, it } from "vitest";
import type { ComponentSummary } from "$lib/domain/trace-graph/model";
import { coverIdentity, forgetOpenStack, MAX_UNRESOLVED_OPEN_STACKS, pathIdentity, revisionIdentity, resolveOpenStacks, type OpenStackComponent } from "$lib/plugins/trace/view/open-stacks";

const component = (coverKey: string, ...identities: string[]): OpenStackComponent => ({ coverKey, identities: new Set(identities) });
const a = pathIdentity("/p/a.png"), b = pathIdentity("/p/b.png");
const separate = [component("a:1", a), component("a:2", b)];

describe("remembered open stacks", () => {
  it("opens only the remembered stacks, independently of component IDs", () => {
    expect(resolveOpenStacks(new Set([b]), separate).open).toEqual(new Set(["a:2"]));
  });
  it("opens a merged stack if either predecessor was open, even when its cover changes", () => {
    const merged = [component("a:new", a, b)];
    for (const keys of [[a], [b], [a, b]]) expect(resolveOpenStacks(keys, merged).open).toEqual(new Set(["a:new"]));
  });
  it("follows remembered covers through a merge and subsequent split", () => {
    const keys = new Set([a, b]);
    const merged = resolveOpenStacks(keys, [component("a:new", a, b)]);
    expect(resolveOpenStacks(merged.remembered, separate).open).toEqual(new Set(["a:1", "a:2"]));
    const onlyB = resolveOpenStacks([b], [component("a:new", a, b)]);
    expect(resolveOpenStacks(onlyB.remembered, separate).open).toEqual(new Set(["a:2"]));
    expect(keys).toEqual(new Set([a, b]));
  });
  it("reopens a disappeared cover when it returns, even if another member remained", () => {
    const result = resolveOpenStacks([a, b], [component("a:1", b)]);
    expect(result.open).toEqual(new Set(["a:1"]));
    expect(result.remembered).toEqual(new Set([a, b]));
    expect(result.unresolved).toEqual(new Set([a]));
    expect(resolveOpenStacks(result.remembered, separate).open).toEqual(new Set(["a:1", "a:2"]));
  });
  it("reopens an unsaved placeholder after its entire component disappears and returns", () => {
    const key = revisionIdentity("o:8:0");
    const missing = resolveOpenStacks([key], []);
    expect(missing.open.size).toBe(0);
    expect(resolveOpenStacks(missing.remembered, [component("o:8:0", key)]).open).toEqual(new Set(["o:8:0"]));
  });
  it("evicts the oldest unresolved identities without evicting resolved stacks", () => {
    const keys = Array.from({ length: MAX_UNRESOLVED_OPEN_STACKS + 2 }, (_, i) => revisionIdentity(`o:${i}:0`));
    const missing = resolveOpenStacks([keys[0], a, ...keys.slice(1)], [component("a:1", a)]);
    expect(missing.open).toEqual(new Set(["a:1"]));
    expect(missing.unresolved.size).toBe(MAX_UNRESOLVED_OPEN_STACKS);
    const restored = resolveOpenStacks(missing.remembered, [component("a:1", a), ...keys.map((key) => component(key, key))]);
    expect(restored.open).toEqual(new Set(["a:1", ...keys.slice(2)]));
  });
  it("preserves recency when identities disappear at different times", () => {
    const keys = Array.from({ length: MAX_UNRESOLVED_OPEN_STACKS + 1 }, (_, i) => pathIdentity(`/p/${i}.png`));
    const first = resolveOpenStacks(keys, [component("newest", keys.at(-1)!)]);
    const missing = resolveOpenStacks(first.remembered, []);
    expect(resolveOpenStacks(missing.remembered, keys.map((key) => component(key, key))).open).toEqual(new Set(keys.slice(1)));
  });
  it("explicit close forgets a missing predecessor even when the merged cover changes", () => {
    const c = pathIdentity("/p/c.png");
    const merged = resolveOpenStacks([a, b], [{ ...component("b", a, b), coverIdentity: b }]);
    const changed = { ...component("c", b, c), coverIdentity: c };
    const missing = resolveOpenStacks(merged.remembered, [changed], merged.owners);
    const closed = forgetOpenStack(missing, changed);
    expect(resolveOpenStacks(closed, [component("a", a), component("c", b, c)]).open.size).toBe(0);
    expect(merged.remembered).toEqual(new Set([a, b]));
  });
  it("closing one stack forgets its missing cover without forgetting unrelated missing covers", () => {
    const previous = resolveOpenStacks([a, b], separate);
    const missing = resolveOpenStacks(previous.remembered, [], previous.owners);
    const closed = forgetOpenStack(missing, separate[0]);
    expect(resolveOpenStacks(closed, separate).open).toEqual(new Set(["a:2"]));
  });
  it("resolves revision keys for covers without a file path, including merged covers", () => {
    const revision = revisionIdentity("o:8:0");
    expect(resolveOpenStacks([revision], [component("o:9:0", revision)]).open).toEqual(new Set(["o:9:0"]));
    expect(coverIdentity({ id: "c:unrelated", coverKey: "o:8:0", cover: null } as any, new Map())).toBe(revision);
  });
  it("uses file paths so an in-place edit can change the revision without closing the stack", () => {
    const identity = coverIdentity({ id: "old", coverKey: "a:1", cover: { path: "/p/a.png", present: true } } as any,
      new Map([["/p/a.png", { componentId: "old" }]]));
    expect(resolveOpenStacks([identity], [component("o:9:0", a)]).open).toEqual(new Set(["o:9:0"]));
  });
  it("uses distinct drawn-cover revisions when stacks share a reference as their title image", () => {
    const summaries = ["o:2:0", "o:3:0"].map((coverKey): ComponentSummary => ({
      id: `c:${coverKey}`, coverKey, cover: { path: "/outside/style.png", present: true },
      title: "style", imageCount: 0, nodeCount: 2, active: true, unsaved: false,
    }));
    const keys = summaries.map((summary) => coverIdentity(summary, new Map()));
    expect(keys).toEqual([revisionIdentity("o:2:0"), revisionIdentity("o:3:0")]);
    expect(resolveOpenStacks([keys[0]], summaries.map((summary, i) => component(summary.coverKey, keys[i]))).open)
      .toEqual(new Set(["o:2:0"]));
  });
  it("handles empty and malformed remembered state", () => {
    for (const state of [null, undefined, "path:/p/a.png", {}, 42, new Map(), [], new Set(), [null, 1, {}, "", "path:", "revision:", "c:old"]]) {
      const result = resolveOpenStacks(state, separate);
      expect(result.open.size).toBe(0);
      expect(result.remembered.size).toBe(0);
      expect(result.unresolved.size).toBe(0);
    }
    expect(resolveOpenStacks([a, false, b, a], separate).open).toEqual(new Set(["a:1", "a:2"]));
    expect(resolveOpenStacks([a], []).open.size).toBe(0);
  });
  it("resolves a large remembered set without losing any stack", () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => pathIdentity(`/p/${i}.png`));
    expect(resolveOpenStacks(keys, keys.map((key, i) => component(`a:${i}`, key))).open.size).toBe(keys.length);
  });
});
