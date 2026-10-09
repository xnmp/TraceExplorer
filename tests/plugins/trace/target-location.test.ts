import { describe, expect, it } from "vitest";
import { locateTarget, type TargetIndex } from "$lib/plugins/trace/view/target-location";
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
    expect(locateTarget("o:2:0", "c:a:1", index(["c:a:7"], { "c:a:7": ["a:7", "o:2:0"] }, ["c:a:7"]))).toBe("gone");
  });
});
