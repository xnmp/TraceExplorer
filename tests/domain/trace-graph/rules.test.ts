import { describe, expect, it } from "vitest";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";
import { lineage, toneOf } from "$lib/domain/trace-graph/lineage";
import { planScene } from "$lib/domain/trace-graph/scene";
import { TILE, tileSize } from "$lib/domain/trace-graph/metrics";
import { visibleKeys, componentRoots, hiddenDescendantCount, SIBLING_LIMIT } from "$lib/domain/trace-graph/visibility";
import { layoutGraph } from "$lib/domain/trace-graph/layout";
import { buildInputJunctions, junctionId, normalizeRelationships } from "$lib/domain/trace-graph/junctions";
import { mockupNodes, node, random, sourcesReaching } from "./fixtures";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("graph projection", () => {
  it("derives connected components from the actual relationships", () => {
    const dag = projectDag(mockupNodes());
    const components = connectedComponents(dag).map((members) => members[0]);
    expect(components).toEqual(["village", "forest", "a"]);
  });

  it("drops unknown parents, self-references and duplicate parents", () => {
    const dag = projectDag([node("x"), node("y", ["x", "x", "missing", "y"])]);
    expect(dag.parents.get("y")).toEqual(["x"]);
    expect(dag.children.get("x")).toEqual(["y"]);
  });

  it("breaks malformed cycles deterministically instead of failing", () => {
    const dag = projectDag([node("p", ["q"], "current", { order: 1 }), node("q", ["p"], "current", { order: 2 })]);
    const edges = [...dag.parents].flatMap(([child, parents]) => parents.map((parent) => `${parent}>${child}`));
    expect(edges).toEqual(["q>p"]);
  });

  it("keeps the first node when keys repeat", () => {
    const dag = projectDag([node("x", [], "current", { order: 1, prompt: "first" }), node("x", [], "current", { order: 2, prompt: "second" })]);
    expect(dag.nodes.get("x")!.prompt).toBe("first");
  });
});

describe("focus and lineage", () => {
  const dag = projectDag(mockupNodes());

  it("never sizes a tile by the focus: every tile has one width and image size, whatever is selected", () => {
    const [members] = connectedComponents(dag);
    const sizes = new Map<string, string>();
    for (const focus of [null, ...members]) {
      for (const tile of planScene(dag, members, focus, 900).tiles.values()) {
        expect(tile.size.width, `${tile.key} with focus ${focus}`).toBe(TILE.width);
        expect(tile.size.imageHeight, `${tile.key} with focus ${focus}`).toBe(TILE.image);
        const size = JSON.stringify(tile.size);
        expect(sizes.get(tile.key) ?? size, `${tile.key} with focus ${focus}`).toBe(size);
        sizes.set(tile.key, size);
      }
    }
    // Only rows a node always carries (scope marker, expansion hint) add height.
    expect(tileSize({ foreign: true, hint: true }).height).toBeGreaterThan(tileSize({ foreign: false, hint: false }).height);
    expect(sizes.size).toBe(members.length);
  });

  it("keeps ancestors and descendants related and dims everything else", () => {
    const context = lineage(dag, "daylight");
    expect(toneOf(context, "daylight")).toBe("focus");
    expect(toneOf(context, "village")).toBe("related");
    expect(toneOf(context, "merge")).toBe("related");
    expect(toneOf(context, "palette")).toBe("unrelated");
    expect(toneOf(context, "rain")).toBe("unrelated");
  });

  it("shows no lineage dimming without a focus or with an unknown focus", () => {
    for (const focus of [null, "nope"]) {
      const context = lineage(dag, focus);
      expect(context.related.size).toBe(0);
      expect(toneOf(context, "warm")).toBe("neutral");
    }
  });
});

describe("limited visibility", () => {
  const nodes = [node("root"), node("a", ["root"]), node("b", ["a"]), node("c", ["b"]), node("d", ["c"]), node("side", ["root"]), node("ref", [], "external"), node("x", ["b", "ref"])];
  const dag = projectDag(nodes);
  const members = connectedComponents(dag)[0];

  it("shows roots and immediate children without a focus", () => {
    expect(sorted(visibleKeys(dag, members, null))).toEqual(["a", "root", "side"]);
  });

  it("shows the focus ancestry and direct children plus parents that explain them", () => {
    expect(sorted(visibleKeys(dag, members, "b"))).toEqual(sorted(["root", "a", "side", "b", "c", "x", "ref"]));
  });

  it("does not accumulate previously expanded branches", () => {
    expect(sorted(visibleKeys(dag, members, "d"))).toEqual(sorted(["root", "a", "side", "b", "c", "d"]));
    expect(sorted(visibleKeys(dag, members, "root"))).toEqual(["a", "root", "side"]);
  });

  it("shows a selected node's siblings: the other children of its folder parents, not a reference input's other outputs", () => {
    // b2 is b's sibling through a. c2 combines b with the reference input r, whose other outputs y and z are no siblings of c2.
    const family = projectDag([node("root"), node("a", ["root"]), node("b", ["a"]), node("b2", ["a"]), node("c", ["b"]), node("r", [], "external"),
      node("y0", ["root"]), node("y", ["y0", "r"]), node("z", ["b2", "r"]), node("c2", ["b", "r"])]);
    const [all] = connectedComponents(family);
    expect(visibleKeys(family, all, "b")).toContain("b2");
    expect(visibleKeys(family, all, "c")).toContain("c2");
    const shownWithC2 = visibleKeys(family, all, "c2");
    // c through b; r as c2's own input.
    for (const key of ["c", "b", "r"]) expect(shownWithC2, key).toContain(key);
    for (const key of ["y", "z"]) expect(shownWithC2, key).not.toContain(key);
    // Only the selected node's own siblings: not its parents' siblings, nor its siblings' children.
    expect(visibleKeys(family, all, "c")).not.toContain("b2");
    expect(visibleKeys(family, all, "b2")).not.toContain("c");
  });

  it("shows only the siblings nearest the selection in a large fan-out, and its parent hints at the rest", () => {
    const variations = Array.from({ length: 50 }, (_, index) => node(`v${index}`, ["edit"]));
    const family = projectDag([node("root"), node("edit", ["root"]), ...variations]);
    const [all] = connectedComponents(family);
    const shown = new Set(visibleKeys(family, all, "v25"));
    const siblings = variations.map((entry) => entry.key).filter((key) => key !== "v25" && shown.has(key));
    expect(siblings.length).toBe(SIBLING_LIMIT);
    // The nearest in creation order, either side of the selection.
    expect(siblings).toEqual(["v19", "v20", "v21", "v22", "v23", "v24", "v26", "v27", "v28", "v29", "v30", "v31"]);
    // Near the end of the list the window shifts instead of shrinking.
    expect(visibleKeys(family, all, "v49").filter((key) => key.startsWith("v") && key !== "v49")).toHaveLength(SIBLING_LIMIT);
    // The parent's tile says more edits exist; selecting it shows them all.
    expect(planScene(family, all, "v25", 900).tiles.get("edit")!.hiddenDescendants).toBe(50 - 1 - SIBLING_LIMIT);
    expect(visibleKeys(family, all, "edit").filter((key) => key.startsWith("v"))).toHaveLength(50);
  });

  it("keeps a large refined batch in bounds: no siblings through a shared reference, at most the nearest 12 through a folder parent", () => {
    // 300 variations of a base edit (not a root, so its children are not all shown anyway);
    // each is refined with the same external style image.
    const nodes = [node("R"), node("base", ["R"]), node("style", [], "external"),
      ...Array.from({ length: 300 }, (_, index) => node(`a${index}`, ["base"])),
      ...Array.from({ length: 300 }, (_, index) => node(`s${index}`, [`a${index}`, "style"]))];
    const family = projectDag(nodes);
    const [all] = connectedComponents(family);
    const width = 900;
    const check = (focus: string, expected: number) => {
      const scene = planScene(family, all, focus, width);
      expect(scene.tiles.size, focus).toBe(expected);
      const start = performance.now();
      const layout = layoutGraph(scene.request);
      // Generous for CI variance; the 602-tile neighbourhood this replaced took over half a second here.
      expect(performance.now() - start, focus).toBeLessThan(1500);
      expect(layout.width, focus).toBeLessThanOrEqual(width * 1.05);
      return scene;
    };
    // A refinement: its own lineage only (R, base, a0, s0, style), not the 299 other refinements of style.
    check("s0", 5);
    // A variation: its lineage, its refinement and its input, plus 12 sibling variations; base hints at the rest.
    const variation = check("a150", 5 + SIBLING_LIMIT);
    const shownVariations = [...variation.tiles.keys()].filter((key) => /^a\d+$/.test(key)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(shownVariations).toEqual(Array.from({ length: 13 }, (_, index) => `a${144 + index}`));
    expect(variation.tiles.get("base")!.hiddenDescendants).toBeGreaterThanOrEqual(300 - 13);
  });

  it("treats only folder images without folder parents as roots", () => {
    expect(componentRoots(dag, members)).toEqual(["root"]);
  });

  it("counts hidden descendants once", () => {
    expect(hiddenDescendantCount(dag, "a", new Set(["root", "a"]))).toBe(4);
  });
});

describe("input junctions", () => {
  const relationships = mockupNodes().map(({ key, parents }) => ({ child: key, parents }));

  it("reuses one junction for identical input sets", () => {
    const plan = buildInputJunctions([{ child: "e", parents: ["a", "b"] }, { child: "h", parents: ["b", "a"] }]);
    expect(plan.joins.map((join) => join.id)).toEqual([junctionId(["a", "b"])]);
    expect(plan.routes.filter((route) => route.to.kind === "node").map((route) => route.to.id).sort()).toEqual(["e", "h"]);
  });

  it("combines a shared subset before joining the remaining input", () => {
    const plan = buildInputJunctions([{ child: "e", parents: ["a", "b"] }, { child: "d", parents: ["a", "b", "c"] }]);
    const abc = plan.joins.find((join) => join.parents.length === 3)!;
    expect(abc.inputs).toEqual([{ kind: "junction", id: junctionId(["a", "b"]) }, { kind: "node", id: "c" }]);
  });

  it("keeps partially overlapping sets distinct", () => {
    const plan = buildInputJunctions([{ child: "x", parents: ["a", "b"] }, { child: "y", parents: ["b", "c"] }]);
    expect(plan.joins.map((join) => join.parents)).toEqual([["a", "b"], ["b", "c"]]);
    expect(sorted(sourcesReaching(plan, "x"))).toEqual(["a", "b"]);
    expect(sorted(sourcesReaching(plan, "y"))).toEqual(["b", "c"]);
  });

  it("preserves exact parentage with one terminal arrow per output on the mockup set", () => {
    const plan = buildInputJunctions(relationships);
    for (const { child, parents } of relationships) {
      expect(sorted(sourcesReaching(plan, child))).toEqual(sorted(parents));
      expect(plan.routes.filter((route) => route.to.kind === "node" && route.to.id === child)).toHaveLength(parents.length ? 1 : 0);
    }
  });

  it("records the underlying parent relationships on every route", () => {
    const plan = buildInputJunctions(relationships);
    const consumers = new Set(plan.routes.flatMap((route) => route.consumers.map((item) => `${item.parent}>${item.child}`)));
    const expected = new Set(relationships.flatMap(({ child, parents }) => parents.map((parent) => `${parent}>${child}`)));
    expect(consumers).toEqual(expected);
  });

  it("preserves exact parentage on random multi-parent DAGs", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = random(seed);
      const rows = Array.from({ length: 24 }, (_, index) => {
        const pool = Array.from({ length: index }, (_, parent) => `n${parent}`);
        const count = index === 0 ? 0 : Math.min(pool.length, Math.floor(next() * 4));
        const parents = [...new Set(Array.from({ length: count }, () => pool[Math.floor(next() * pool.length)]))];
        return { child: `n${index}`, parents };
      });
      const plan = buildInputJunctions(rows);
      for (const { child, parents } of rows) {
        expect(sorted(sourcesReaching(plan, child)), `seed ${seed} child ${child}`).toEqual(sorted(parents));
        expect(plan.routes.filter((route) => route.to.kind === "node" && route.to.id === child)).toHaveLength(parents.length ? 1 : 0);
      }
    }
  });

  it("gives junctions identities that depend only on their parent set", () => {
    const first = buildInputJunctions([{ child: "x", parents: ["a", "b"] }]);
    const second = buildInputJunctions([{ child: "z", parents: ["q"] }, { child: "y", parents: ["b", "a"] }]);
    expect(first.joins[0].id).toBe(second.joins[0].id);
  });

  it("rejects malformed, conflicting and cyclic relationships", () => {
    expect(() => normalizeRelationships(null as never)).toThrow(TypeError);
    expect(() => normalizeRelationships([{ child: "", parents: [] }])).toThrow(TypeError);
    expect(() => normalizeRelationships([{ child: "x", parents: [3 as never] }])).toThrow(TypeError);
    expect(() => normalizeRelationships([{ child: "x", parents: ["a"] }, { child: "x", parents: ["b"] }])).toThrow(/conflicting/);
    expect(() => normalizeRelationships([{ child: "x", parents: ["y"] }, { child: "y", parents: ["x"] }])).toThrow(/acyclic/);
  });
});
