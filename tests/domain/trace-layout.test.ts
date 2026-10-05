import { describe, expect, it } from "vitest";
import { layoutTraceGraph } from "$lib/domain/trace-layout";

describe("Trace graph layout", () => {
  it("keeps one artifact node per revision and connects a fork followed by a merge", () => {
    const layout = layoutTraceGraph({
      artifacts: [
        { id: 1, generatingRun: null },
        { id: 3, generatingRun: 2 },
        { id: 5, generatingRun: 4 },
        { id: 7, generatingRun: 6 },
      ],
      runs: [
        { id: 2, inputIds: [1] },
        { id: 4, inputIds: [1] },
        { id: 6, inputIds: [3, 5] },
      ],
    });
    expect(layout.nodes.map((node) => node.key).sort()).toEqual(["a:1", "a:3", "a:5", "a:7"]);
    expect(layout.edges.map(({ from, to }) => `${from}->${to}`).sort()).toEqual([
      "a:1->a:3", "a:1->a:5", "a:3->a:7", "a:5->a:7",
    ]);
    const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
    expect(byKey.get("a:7")!.y).toBeGreaterThan(byKey.get("a:3")!.y);
  });

  it("shows one connection when the same revision fills two input positions", () => {
    const layout = layoutTraceGraph({
      artifacts: [{ id: 1, generatingRun: null }, { id: 2, generatingRun: 3 }],
      runs: [{ id: 3, inputIds: [1, 1] }],
    });
    expect(layout.edges.map(({ from, to }) => `${from}->${to}`)).toEqual(["a:1->a:2"]);
  });
  it("retains running and failed attempts without inventing output images", () => {
    const layout = layoutTraceGraph({ artifacts: [{ id: 1, generatingRun: null }], runs: [{ id: 2, inputIds: [1] }, { id: 3, inputIds: [1] }] });
    expect(layout.nodes.map((node) => node.key)).toEqual(["a:1", "r:2", "r:3"]);
    expect(layout.edges.map(({ from, to }) => `${from}->${to}`)).toEqual(["a:1->r:2", "a:1->r:3"]);
  });
  it("bounds a malformed cycle and ignores absent inputs", () => {
    const layout = layoutTraceGraph({ artifacts: [{ id: 1, generatingRun: 2 }], runs: [{ id: 2, inputIds: [1, 99] }] });
    expect(layout.nodes.every((node) => Number.isFinite(node.y))).toBe(true);
    expect(layout.width).toBeLessThan(1000);
  });
});
