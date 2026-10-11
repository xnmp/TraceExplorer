import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/folder-grouping.json";
import { folderComponents, folderPage, isDirectFolderSeed, nativeStringOrder } from "../../e2e/harness/folder-snapshot";
import type { TraceNode } from "$lib/domain/trace-graph/model";

describe("native folder grouping parity", () => {
  it.each(fixtures)("matches the Rust golden: $name", ({ nodes: input, expected, members }) => {
    const nodes = input as TraceNode[];
    const actual = (input: readonly TraceNode[]) => folderComponents(input).map((component) => ({
      summary: component.summary, keys: component.members,
      badges: component.nodes.flatMap((node) => node.referenceBadge ? [node.referenceBadge] : []),
    }));
    expect(actual(nodes)).toEqual(expected);
    expect(actual([...nodes].reverse())).toEqual(expected);
    expect(folderComponents(nodes).flatMap((component) => component.nodes.filter(isDirectFolderSeed)
      .map((node) => ({ path: node.path, componentId: component.id, key: node.key })))
      .sort((a, b) => nativeStringOrder(a.path!, b.path!))).toEqual(members);
  });

  const shared = fixtures.find((fixture) => fixture.name === "external-cover")!.nodes[0] as TraceNode;
  const output = (id: number, parents = [shared.key]): TraceNode => ({ ...shared, key: `o:${id}:0`, artifactId: id, runId: id,
    path: `/pictures/${id}.png`, scope: "current", parents, order: id });
  const collect = <T>(items: readonly T[], limit: number) => {
    const all: T[] = [];
    while (all.length < items.length) all.push(...folderPage(items, all.length, limit));
    return all;
  };

  it("pages thousands of shared-reference stacks without duplicate members or IDs", () => {
    const outputs = Array.from({ length: 5_000 }, (_, i) => output(i + 2));
    const started = performance.now();
    const components = folderComponents([shared, ...outputs]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(components).toHaveLength(5_000);
    expect(new Set(components.map((component) => component.id)).size).toBe(5_000);
    expect(components.every((component) => component.summary.imageCount === 1 && component.summary.nodeCount === 2)).toBe(true);
    expect(collect(components.map((component) => component.summary), 200)).toEqual(components.map((component) => component.summary));
    const members = components.flatMap((component) => component.nodes.filter(isDirectFolderSeed));
    expect(new Set(collect(members, 1_000).map((node) => node.key))).toEqual(new Set(outputs.map((node) => node.key)));
    expect(components.every((component) => component.nodes[0].referenceBadge?.consumers.length === 1)).toBe(true);
  });

  it("keeps one reference copy with all consumers when a real root joins paged nodes", () => {
    const root: TraceNode = { ...output(2, []), key: "a:2", runId: null };
    const outputs = Array.from({ length: 1_200 }, (_, i) => output(i + 3, [root.key, shared.key, shared.key]));
    const [component] = folderComponents([shared, root, ...outputs]);
    expect(component.summary).toMatchObject({ id: "c:a:2", imageCount: 1_201, nodeCount: 1_202 });
    expect(collect(component.nodes, 1_000)).toEqual(component.nodes);
    const references = component.nodes.filter((node) => node.referenceBadge);
    expect(references).toHaveLength(1);
    expect(references[0].referenceBadge?.consumers).toEqual(outputs.map((node) => node.key));
  });

  it("stops pages at the byte budget and resumes without dropping long reference records", () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({ ...shared, key: `a:${i}`, path: `/elsewhere/${"long".repeat(1_000)}-${i}.png` }));
    expect(folderPage(nodes, 0, 1_000).length).toBeLessThan(nodes.length);
    expect(collect(nodes, 1_000)).toEqual(nodes);
    expect(folderPage(nodes, nodes.length + 10, 1_000)).toEqual([]);
  });
});
