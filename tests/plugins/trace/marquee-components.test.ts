import { describe, expect, it } from "vitest";
import { pendingMarqueeComponents } from "$lib/plugins/trace/view/marquee-components";
import type { TargetIndex } from "$lib/plugins/trace/view/target-location";

const index = (listed: string[], stale: string[] = []): TargetIndex => ({
  listed: new Set(listed), components: new Map(), isStale: (id) => stale.includes(id),
});

describe("pending marquee cover resolution", () => {
  it("loads a cold unlisted cover from the latest summary", () => {
    expect(pendingMarqueeComponents(["draft"], new Set(), new Map([["draft", { id: "new-draft" }]]), index(["other", "new-draft"])))
      .toEqual(["new-draft"]);
  });

  it("searches current components after the stable key stops being a cover", () => {
    expect(pendingMarqueeComponents(["draft", "draft"], new Set(), new Map(), index(["merged", "other"])))
      .toEqual(["merged", "other"]);
  });

  it("does not load ordinary entries or covers whose path is listed", () => {
    expect(pendingMarqueeComponents(["/plain", "old-revision"], new Set(["/plain", "/cover"]),
      new Map([["old-revision", { id: "stack", cover: { path: "/cover" } }]]), index(["stack"]))).toEqual([]);
  });

  it("has no reads for empty hits, absent indexes, or a removed node in fully read components", () => {
    expect(pendingMarqueeComponents([], new Set(), new Map(), index(["stack"]))).toEqual([]);
    expect(pendingMarqueeComponents(["draft"], new Set(), new Map(), { ...index([]), listed: null })).toEqual([]);
    const loaded = { ...index(["stack"]), components: new Map([["stack", { dag: { nodes: new Map() } }]]) };
    expect(pendingMarqueeComponents(["draft"], new Set(), new Map(), loaded)).toEqual([]);
    expect(pendingMarqueeComponents(["draft"], new Set(), new Map(), { ...loaded, isStale: () => true })).toEqual(["stack"]);
  });
});
