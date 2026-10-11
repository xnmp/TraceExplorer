import { describe, expect, it } from "vitest";
import { displayedNodes, isDirectFolderSeed, type FolderNode } from "../../e2e/harness/folder-snapshot";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const node = (key: string, patch: Partial<FolderNode> = {}): FolderNode => ({
  key, artifactId: 1, runId: 1, parents: [], path: `/pictures/${key}.png`,
  scope: "current", location: `./${key}.png`, state: "present", temporary: false,
  discarded: false, earlierRevision: false, order: 1, prompt: "Edit", ...patch,
});
const keys = (nodes: FolderNode[], dismissed = new Set<number>()) => displayedNodes(nodes, dismissed).map((node) => node.key);

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
    const output = node("output", { scope: "external", temporary: true, contextDirectory: "/pictures", parents: [input.key] });
    expect(keys([input, output])).toEqual(["input", "output"]);
    expect([input, output].filter(isDirectFolderSeed)).toEqual([]);
    for (const state of ["running", "uncertain"] as const) {
      const placeholder = node("job", { artifactId: null, path: null, state, parents: [input.key] });
      expect(keys([input, placeholder])).toEqual(["input", "job"]);
      expect(keys([input, placeholder], new Set([1]))).toEqual(state === "running" ? ["input", "job"] : []);
    }
    expect(keys([])).toEqual([]);
  });

  it("does not seed a foreign draft or placeholder solely because it is temporary", () => {
    const foreign = node("draft", { scope: "external", temporary: true, contextDirectory: "/other" });
    expect(keys([foreign])).toEqual([]);
    expect(keys([foreign, node("child", { parents: [foreign.key] })])).toEqual(["draft", "child"]);
    expect(keys([{ ...foreign, artifactId: null, path: null, state: "running" }])).toEqual([]);
    expect(displayedNodes([{ ...foreign, contextDirectory: "/pictures" }], new Set())).toHaveLength(1);
  });
});
