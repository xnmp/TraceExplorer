import { describe, expect, it } from "vitest";
import { projectDag, projectReferenceBadges } from "$lib/domain/trace-graph/projection";
import { bandVisibleKeys } from "$lib/domain/trace-graph/visibility";
import { planBandScene } from "$lib/domain/trace-graph/scene";
import {
  NO_EXPANSION, expandNode, expandedKeys, expansionAnchor, isExpanded, pruneExpansion, readExpansion, revealNode, revealPath,
  sameExpansion, settleReveal, toggleNode, MAX_UNKNOWN_CHOICES, type Expansion, type ExpansionScope,
} from "$lib/domain/trace-graph/expansion";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { node } from "./fixtures";

const scopeOf = (nodes: TraceNode[], cover = nodes[0].key): ExpansionScope => {
  const graph = projectReferenceBadges(projectDag(nodes));
  return { graph, members: graph.dag.order, cover };
};
const shown = (expansion: Expansion, scope: ExpansionScope) => bandVisibleKeys(scope.graph, scope.members, expandedKeys(expansion, scope)).sort();

/** The user's recording: a root with two branches, Saffron's with a deeper edit. */
const recording = () => scopeOf([
  node("root"), node("Cerulean", ["root"]), node("Saffron", ["root"]), node("Pikachu", ["Cerulean"]),
  node("Blastoise", ["Saffron"]), node("Ash", ["Saffron"]), node("Charizard", ["Ash"]),
]);

describe("explicit expansion", () => {
  it("opens a stack with its cover's children and nothing else", () => {
    expect(shown(NO_EXPANSION, recording())).toEqual(["Cerulean", "Saffron", "root"]);
  });

  it("a first click opens only the clicked node's children; branches opened earlier stay open (the recording)", () => {
    const scope = recording();
    const saffron = expandNode(NO_EXPANSION, scope, "Saffron");
    expect(shown(saffron, scope)).toEqual(["Ash", "Blastoise", "Cerulean", "Saffron", "root"]);
    const cerulean = expandNode(saffron, scope, "Cerulean");
    expect(shown(cerulean, scope)).toEqual(["Ash", "Blastoise", "Cerulean", "Pikachu", "Saffron", "root"]);
  });

  it("selecting a leaf or an expanded node changes nothing: the same expansion object", () => {
    const scope = recording();
    const open = expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash");
    expect(expandNode(open, scope, "Charizard"), "a leaf").toBe(open);
    expect(expandNode(open, scope, "Ash"), "already expanded").toBe(open);
    expect(expandNode(open, scope, "root"), "the cover").toBe(open);
    expect(expandNode(open, scope, "elsewhere"), "not in the stack").toBe(open);
    expect(expansionAnchor(open, scope)).toBe("Ash");
  });

  it("the caret and a second click toggle one node; re-expanding restores what was open below it", () => {
    const scope = recording();
    let state = expandNode(expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash"), scope, "Cerulean");
    state = toggleNode(state, scope, "Cerulean");
    expect(shown(state, scope)).toEqual(["Ash", "Blastoise", "Cerulean", "Charizard", "Saffron", "root"]);
    state = toggleNode(state, scope, "Saffron");
    expect(shown(state, scope)).toEqual(["Cerulean", "Saffron", "root"]);
    expect(isExpanded(state, scope, "Ash"), "a hidden node keeps its own expansion").toBe(true);
    state = toggleNode(state, scope, "Saffron");
    expect(shown(state, scope)).toEqual(["Ash", "Blastoise", "Cerulean", "Charizard", "Saffron", "root"]);
    expect(expansionAnchor(state, scope)).toBe("Saffron");
  });

  it("toggles any root, but the cover's expansion is its stack's open state", () => {
    const scope = scopeOf([node("cover"), node("other"), node("joined", ["cover", "other"]), node("solo", ["other"])]);
    expect(shown(NO_EXPANSION, scope)).toEqual(["cover", "joined", "other", "solo"]);
    const collapsed = toggleNode(NO_EXPANSION, scope, "other");
    // `joined` stays: the cover still shows it, and it keeps both its inputs.
    expect(shown(collapsed, scope)).toEqual(["cover", "joined", "other"]);
    expect(isExpanded(toggleNode(NO_EXPANSION, scope, "cover"), scope, "cover")).toBe(true);
  });

  it("collapsing an ancestor of a revealed selection hides it; the reveal settles into choices", () => {
    const scope = recording();
    const revealed = revealNode(NO_EXPANSION, "Charizard");
    expect(shown(revealed, scope)).toContain("Charizard");
    expect(revealPath(scope, expandedKeys(NO_EXPANSION, scope), "Charizard")).toEqual(["Ash", "Saffron"]);
    const collapsed = toggleNode(revealed, scope, "Saffron");
    expect(collapsed.reveal).toBeNull();
    expect(shown(collapsed, scope)).not.toContain("Charizard");
    expect(shown(toggleNode(collapsed, scope, "Saffron"), scope)).toContain("Charizard");
    // A reveal in another stack is left pending.
    expect(settleReveal(revealNode(NO_EXPANSION, "elsewhere"), scope).reveal).toBe("elsewhere");
  });

  it("reveals a badge through one of its consumers, and an expanded badge shows only its own stack's consumers", () => {
    const nodes = [node("root"), node("a", ["root"]), node("b", ["a"]), node("style", [], "external"), node("c", ["b", "style"]), node("d", ["root", "style"]),
      node("other"), node("e", ["other", "style"])];
    const graph = projectReferenceBadges(projectDag(nodes));
    const members = ["root", "a", "b", "c", "d"], scope = { graph, members, cover: "root" };
    expect(revealPath(scope, expandedKeys(NO_EXPANSION, scope), "style"), "d shows it already").toEqual([]);
    const badge = toggleNode(NO_EXPANSION, scope, "style");
    expect(bandVisibleKeys(graph, members, expandedKeys(badge, scope))).toEqual(["root", "a", "b", "c", "d"]);
    expect(bandVisibleKeys(graph, members, expandedKeys(badge, scope))).not.toContain("e");
  });

  it("reveals a parentless reference input through one of its outputs", () => {
    const scope = scopeOf([node("root"), node("a", ["root"]), node("outside", [], "external", { path: null }), node("b", ["a", "outside"])]);
    const path = revealPath(scope, expandedKeys(NO_EXPANSION, scope), "outside");
    expect(path).toEqual(["a"]);
    expect(shown(revealNode(NO_EXPANSION, "outside"), scope)).toContain("outside");
  });

  it("anchors the layout on the last node toggled in the stack, never on a selection", () => {
    const scope = recording();
    expect(expansionAnchor(NO_EXPANSION, scope)).toBeNull();
    expect(expansionAnchor(revealNode(NO_EXPANSION, "Ash"), scope)).toBe("Ash");
    const state = toggleNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Cerulean");
    expect(expansionAnchor(state, scope)).toBe("Cerulean");
    expect(expansionAnchor({ choices: new Map([["Saffron", true], ["elsewhere", true]]), reveal: null }, scope)).toBe("Saffron");
    // The band plan reads no selection: the same expansion plans the same tiles and request.
    const plan = (anchor: string | null) => planBandScene(scope.graph, scope.members, anchor, 640, { pinned: { key: "root", x: 80 }, expanded: expandedKeys(state, scope) });
    expect([...plan(null).tiles.keys()]).toEqual([...plan("Cerulean").tiles.keys()]);
    expect([...plan("Charizard").tiles.keys()], "an anchor shows nothing").toEqual([...plan("Cerulean").tiles.keys()]);
  });
});

describe("expansion state hygiene", () => {
  it("drops choices of nodes that are gone, keeps present ones and the most recent unknown ones", () => {
    const choices = new Map<string, boolean>([["gone", true], ["here", false], ...Array.from({ length: 300 }, (_, i) => [`u${i}`, true] as [string, boolean])]);
    const state: Expansion = { choices, reveal: "gone" };
    const pruned = pruneExpansion(state, (key) => key === "gone" ? "gone" : key === "here" ? "present" : "unknown");
    expect(pruned.choices.has("gone")).toBe(false);
    expect(pruned.choices.get("here")).toBe(false);
    expect(pruned.reveal).toBeNull();
    const unknown = [...pruned.choices.keys()].filter((key) => key.startsWith("u"));
    expect(unknown).toHaveLength(MAX_UNKNOWN_CHOICES);
    expect(unknown.at(-1)).toBe("u299");
    expect(unknown[0]).toBe(`u${300 - MAX_UNKNOWN_CHOICES}`);
    expect(pruneExpansion(pruned, () => "present")).toBe(pruned);
  });

  it("reads malformed remembered state as no expansion, keeping well-formed choices", () => {
    for (const value of [null, undefined, 3, "x", [], {}, { choices: [["a", true]] }]) expect(readExpansion(value)).toEqual(NO_EXPANSION);
    const read = readExpansion({ choices: new Map<unknown, unknown>([["a", true], [3, true], ["b", "yes"], ["", true], ["c", false]]), reveal: 7 });
    expect([...read.choices]).toEqual([["a", true], ["c", false]]);
    expect(read.reveal).toBeNull();
  });

  it("compares by contents, not order or identity", () => {
    const a: Expansion = { choices: new Map([["x", true], ["y", false]]), reveal: null };
    expect(sameExpansion(a, { choices: new Map([["y", false], ["x", true]]), reveal: null })).toBe(true);
    expect(sameExpansion(a, { choices: new Map([["x", true]]), reveal: null })).toBe(false);
    expect(sameExpansion(a, { ...a, reveal: "x" })).toBe(false);
  });

  it("ignores keys outside the stack and empty keys", () => {
    const scope = recording();
    expect(toggleNode(NO_EXPANSION, scope, "elsewhere")).toBe(NO_EXPANSION);
    expect(toggleNode(NO_EXPANSION, scope, "")).toBe(NO_EXPANSION);
    expect(revealNode(NO_EXPANSION, "")).toBe(NO_EXPANSION);
    expect(shown({ choices: new Map([["elsewhere", true]]), reveal: "nowhere" }, scope)).toEqual(shown(NO_EXPANSION, scope));
  });

  it("stays linear on a 20,000-step chain and a 5,000-child fan", () => {
    const chain = scopeOf(Array.from({ length: 20_000 }, (_, i) => node(`n${i}`, i ? [`n${i - 1}`] : [], "current", { order: i })));
    let start = performance.now();
    const deep = revealNode(NO_EXPANSION, "n19999");
    expect(shown(deep, chain)).toHaveLength(20_000);
    const collapsed = toggleNode(deep, chain, "n1");
    expect(shown(collapsed, chain)).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(2000);
    const fan = scopeOf([node("root"), ...Array.from({ length: 5000 }, (_, i) => node(`f${i}`, ["root"])), ...Array.from({ length: 5000 }, (_, i) => node(`g${i}`, [`f${i}`]))]);
    start = performance.now();
    let state = NO_EXPANSION;
    for (let i = 0; i < 50; i++) state = expandNode(state, fan, `f${i}`);
    expect(shown(state, fan)).toHaveLength(1 + 5000 + 50);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
