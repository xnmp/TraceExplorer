import { describe, expect, it } from "vitest";
import { displayedNodes, isDirectFolderSeed } from "../../e2e/harness/folder-snapshot";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const node = (key: string, patch: Partial<TraceNode> = {}): TraceNode => ({
  key, artifactId: 1, runId: 1, parents: [], path: `/pictures/${key}.png`,
  scope: "current", location: `./${key}.png`, state: "present", temporary: false,
  discarded: false, earlierRevision: false, order: 1, prompt: "Edit", ...patch,
});
const keys = (nodes: TraceNode[], dismissed = new Set<number>()) => displayedNodes(nodes, dismissed).map((node) => node.key);

describe("native folder seed filtering in the browser harness", () => {
  it.each([
    { state: "missing" }, { state: "unavailable" }, { earlierRevision: true },
    { discarded: true }, { scope: "external" }, { scope: "subfolder" },
  ] satisfies Partial<TraceNode>[])("retains %j only as a direct parent of a seed", (status) => {
    const parent = node("parent", status);
    expect(keys([parent])).toEqual([]);
    expect([parent, node("child", { parents: [parent.key] })].filter(isDirectFolderSeed).map((node) => node.key)).toEqual(["child"]);
    expect(keys([parent, node("child", { parents: [parent.key] })])).toEqual(["parent", "child"]);
    // Loading a parent doesn't recursively promote its ancestors to seeds.
    expect(keys([parent, node("child", { ...status, parents: [parent.key] }), node("grandchild", { parents: ["child"] })]))
      .toEqual(["child", "grandchild"]);
  });

  it("seeds present unsaved outputs and active placeholders, respecting dismissals", () => {
    const input = node("input", { scope: "external" });
    const output = node("output", { scope: "external", temporary: true, parents: [input.key] });
    expect(keys([input, output])).toEqual(["input", "output"]);
    expect([input, output].filter(isDirectFolderSeed)).toEqual([]);
    for (const state of ["running", "uncertain"] as const) {
      const placeholder = node("job", { artifactId: null, path: null, state, parents: [input.key] });
      expect(keys([input, placeholder])).toEqual(["input", "job"]);
      expect(keys([input, placeholder], new Set([1]))).toEqual(state === "running" ? ["input", "job"] : []);
    }
    expect(keys([])).toEqual([]);
  });
});
