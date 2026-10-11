import { describe, expect, it } from "vitest";
import { findLoadedNode, locateTarget, unresolvedTargetComponents, type TargetIndex } from "$lib/plugins/trace/view/target-location";
import fixtures from "../../fixtures/folder-grouping.json";
import { folderComponents } from "../../../e2e/harness/folder-snapshot";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const node = (key: string): TraceNode => ({
  key, artifactId: null, runId: 1, parents: [], path: null, scope: "current", location: "Generating…",
  state: "running", temporary: true, discarded: false, earlierRevision: false, order: 1, prompt: "",
});
const component = (...keys: string[]) => ({ dag: { nodes: new Map(keys.map((key) => [key, node(key)])) } });
function index(listed: string[] | null, components: Record<string, string[]>, stale: string[] = []): TargetIndex {
  return {
    listed: listed && new Set(listed),
    components: new Map(Object.entries(components).map(([id, keys]) => [id, component(...keys)])),
    isStale: (id) => stale.includes(id),
  };
}

describe("Preview target location", () => {
  it("finds the node in its own current component", () => {
    const found = locateTarget("o:2:0", "c:a:1", index(["c:a:1"], { "c:a:1": ["a:1", "o:2:0"] }));
    expect(found).toMatchObject({ componentId: "c:a:1", node: { key: "o:2:0" } });
  });

  it("follows the node into the component it merged into", () => {
    const found = locateTarget("o:2:0", "c:a:5", index(["c:a:1"], { "c:a:1": ["a:1", "a:5", "o:2:0"] }));
    expect(found).toMatchObject({ componentId: "c:a:1", node: { key: "o:2:0" } });
  });

  it("is gone when the index no longer lists its component and no current data holds it", () => {
    // A failed generation whose input is left without a visible relationship.
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:9"], { "c:a:9": ["a:9"] }))).toBe("gone");
    expect(locateTarget("o:2:0", "c:a:1", index([], {}))).toBe("gone");
  });

  it("is gone when its own component, loaded current, no longer holds it", () => {
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:1"], { "c:a:1": ["a:1", "o:3:0"] }))).toBe("gone");
  });

  it("is unknown while no index is loaded or its component is not loaded current", () => {
    expect(locateTarget("o:2:0", "c:a:1", index(null, {}))).toBe("unknown");
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:1"], {}))).toBe("unknown");
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:1"], { "c:a:1": ["a:1"] }, ["c:a:1"]))).toBe("unknown");
  });

  it("does not trust a copy of the node in out-of-date data", () => {
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:1"], { "c:a:1": ["a:1", "o:2:0"] }, ["c:a:1"]))).toBe("unknown");
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:7"], { "c:a:7": ["a:7", "o:2:0"] }, ["c:a:7"]))).toBe("unknown");
  });

  it("keeps a target while a merge or split replacement is still loading", () => {
    expect(locateTarget("o:2:0", "old", index(["left", "right"], { left: ["a:1"] }))).toBe("unknown");
    expect(locateTarget("o:2:0", "old", index(["left", "right"], { left: ["a:1"], right: ["o:2:0"] })))
      .toMatchObject({ componentId: "right", node: { key: "o:2:0" } });
    // A split can retain the old ID on the other half. It is still no proof
    // that a key vanished before the newly created half has been read.
    expect(locateTarget("o:2:0", "left", index(["left", "right"], { left: ["a:1"] }))).toBe("unknown");
  });

  it("keeps the issuing component when a shared reference has several copies", () => {
    expect(locateTarget("a:9", "right", index(["left", "right"], { left: ["a:9"], right: ["a:9"] })))
      .toMatchObject({ componentId: "right" });
    expect(locateTarget("a:9", "removed", index(["right"], { removed: ["a:9"], right: ["a:9"] })))
      .toMatchObject({ componentId: "right" });
  });

  it("resolves a Preview input in the subject's stack in two-chains", () => {
    const groups = folderComponents(fixtures.find((fixture) => fixture.name === "two-chains")!.nodes as TraceNode[]);
    const components = new Map(groups.map((group) => [group.id, { dag: { nodes: new Map(group.nodes.map((node) => [node.key, node])) } }]));
    // Stack B loads first; Preview's saved subject is in A, then navigates to
    // style (a different key shared by both stacks).
    expect(findLoadedNode("a:1", components, "c:a:2")).toMatchObject({ componentId: "c:a:2" });
    expect(findLoadedNode("a:1", components, "c:a:4")).toMatchObject({ componentId: "c:a:4" });
    expect(findLoadedNode("absent", components, "c:a:2")).toBeNull();
  });

  it.each([{}, { right: ["a:9"] }])("waits for an unresolved issuing stack before using another copy (%j)", (own) => {
    const pending = index(["left", "right", "unloaded"], { left: ["a:9"], ...own }, ["right"]);
    expect(locateTarget("a:9", "right", pending)).toBe("unknown");
    expect(unresolvedTargetComponents("a:9", "right", pending)).toEqual(["right"]);
    const reloaded = index(["left", "right", "unloaded"], { left: ["a:9"], right: ["a:9"] });
    expect(locateTarget("a:9", "right", reloaded)).toMatchObject({ componentId: "right" });
    expect(unresolvedTargetComponents("a:9", "right", reloaded)).toEqual([]);
    const replaced = index(["left", "right"], { left: ["a:9"], right: [] });
    expect(locateTarget("a:9", "right", replaced)).toMatchObject({ componentId: "left" });
  });

  it("searches unloaded replacements only after the issuing stack no longer owns the target", () => {
    expect(unresolvedTargetComponents("o:2:0", "old", index(["left", "right"], { left: [] }))).toEqual(["right"]);
    expect(unresolvedTargetComponents("o:2:0", "left", index(["left", "right"], { left: [] }))).toEqual(["right"]);
    expect(unresolvedTargetComponents("o:2:0", "old", index([], {}))).toEqual([]);
  });
});
