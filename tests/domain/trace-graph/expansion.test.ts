import { describe, expect, it } from "vitest";
import { projectDag, projectReferenceBadges } from "$lib/domain/trace-graph/projection";
import { bandCarets, bandVisibleKeys } from "$lib/domain/trace-graph/visibility";
import { planBandScene } from "$lib/domain/trace-graph/scene";
import {
  NO_EXPANSION, MAX_CHOICES, MAX_REVEALS, expandForOutputs, expandNode, expandedKeys, expansionAnchor, isOpen, pruneExpansion, readExpansion, revealNode, revealPath,
  sameExpansion, settleReveal, toggleNode, MAX_UNKNOWN_CHOICES, type Expansion, type ExpansionScope,
} from "$lib/domain/trace-graph/expansion";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { node } from "./fixtures";

const scopeOf = (nodes: TraceNode[], cover = nodes[0].key): ExpansionScope => {
  const graph = projectReferenceBadges(projectDag(nodes));
  return { graph, members: graph.dag.order, cover };
};
const shown = (expansion: Expansion, scope: ExpansionScope) => bandVisibleKeys(scope.graph, scope.members, expandedKeys(expansion, scope)).sort();
const carets = (expansion: Expansion, scope: ExpansionScope) => [...bandCarets(scope.graph, scope.members, expandedKeys(expansion, scope)).togglable].sort();
const opened = (expansion: Expansion, scope: ExpansionScope) => [...bandCarets(scope.graph, scope.members, expandedKeys(expansion, scope)).open].sort();

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

  it("selecting an expanded node changes nothing; a leaf records the intent without changing what is shown or the anchor", () => {
    const scope = recording();
    const open = expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash");
    const leaf = expandNode(open, scope, "Charizard");
    expect(leaf.choices.get("Charizard"), "a leaf's intent").toBe(true);
    expect(shown(leaf, scope)).toEqual(shown(open, scope));
    expect(expansionAnchor(leaf, scope), "a leaf holds nothing still").toBe("Ash");
    expect(expandNode(leaf, scope, "Charizard"), "recorded once").toBe(leaf);
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
    expect(state.choices.get("Ash"), "a hidden node keeps its own expansion").toBe(true);
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
    expect(isOpen(toggleNode(NO_EXPANSION, scope, "cover"), scope, "cover")).toBe(true);
  });

  it("collapsing an ancestor of a revealed selection hides it; the reveal settles into choices", () => {
    const scope = recording();
    const revealed = revealNode(NO_EXPANSION, "Charizard");
    expect(shown(revealed, scope)).toContain("Charizard");
    expect(revealPath(scope, expandedKeys(NO_EXPANSION, scope), "Charizard")).toEqual(["Ash", "Saffron"]);
    const collapsed = toggleNode(revealed, scope, "Saffron");
    expect(collapsed.reveals).toEqual([]);
    expect(shown(collapsed, scope)).not.toContain("Charizard");
    expect(shown(toggleNode(collapsed, scope, "Saffron"), scope)).toContain("Charizard");
    // A reveal in another stack is left pending.
    expect(settleReveal(revealNode(NO_EXPANSION, "elsewhere"), scope).reveals).toEqual(["elsewhere"]);
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
    expect(expansionAnchor({ choices: new Map([["Saffron", true], ["elsewhere", true]]), reveals: [] }, scope)).toBe("Saffron");
    // The band plan reads no selection: the same expansion plans the same tiles and request.
    const plan = (anchor: string | null) => planBandScene(scope.graph, scope.members, anchor, 640, { pinned: { key: "root", x: 80 }, expanded: expandedKeys(state, scope) });
    expect([...plan(null).tiles.keys()]).toEqual([...plan("Cerulean").tiles.keys()]);
    expect([...plan("Charizard").tiles.keys()], "an anchor shows nothing").toEqual([...plan("Cerulean").tiles.keys()]);
  });
});

describe("outputs, reveals and carets", () => {
  it("a leaf selected before an AI edit shows the edit's placeholder once it appears", () => {
    const scope = recording();
    const state = expandNode(expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash"), scope, "Charizard");
    const grown = scopeOf([
      node("root"), node("Cerulean", ["root"]), node("Saffron", ["root"]), node("Pikachu", ["Cerulean"]),
      node("Blastoise", ["Saffron"]), node("Ash", ["Saffron"]), node("Charizard", ["Ash"]), node("gen1", ["Charizard"]),
    ]);
    expect(shown(state, grown)).toContain("gen1");
    // It anchors on the leaf once it has children to show.
    expect(expansionAnchor(state, grown)).toBe("Charizard");
  });

  it("a job started on an input in a collapsed branch reveals and expands it; one already shown and open changes nothing", () => {
    const scope = recording();
    const collapsed = toggleNode(expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash"), scope, "Saffron");
    expect(shown(collapsed, scope)).not.toContain("Charizard");
    const started = expandForOutputs(collapsed, scope, "Charizard");
    expect(shown(started, scope)).toEqual(["Ash", "Blastoise", "Cerulean", "Charizard", "Saffron", "root"]);
    expect(isOpen(started, scope, "Charizard")).toBe(true);
    expect(started.reveals, "settled into choices").toEqual([]);
    expect(expandForOutputs(started, scope, "Charizard")).toBe(started);
    expect(expandForOutputs(started, scope, "elsewhere")).toBe(started);
  });

  it("a job never expands a reference badge among its inputs", () => {
    // The style badge also feeds unrelated edits, morning and dusk, under lantern.
    const scope = scopeOf([node("root"), node("lantern", ["root"]), node("style", [], "external"), node("morning", ["lantern", "style"]), node("dusk", ["lantern", "style"]), node("cat", ["root"])], "root");
    expect(expandForOutputs(NO_EXPANSION, scope, "style")).toBe(NO_EXPANSION);
    const started = expandForOutputs(NO_EXPANSION, scope, "cat");
    expect(shown(started, scope)).not.toContain("morning");
  });

  it("keeps an earlier reveal pending while its stack is not loaded, and forgets the oldest past the limit", () => {
    const scope = recording();
    let state = revealNode(NO_EXPANSION, "unloaded");
    state = revealNode(state, "Charizard");
    expect(state.reveals).toEqual(["unloaded", "Charizard"]);
    expect(shown(state, scope)).toContain("Charizard");
    // Settling this stack leaves the other stack's reveal pending.
    expect(settleReveal(state, scope).reveals).toEqual(["unloaded"]);
    for (let i = 0; i < 40; i++) state = revealNode(state, `n${i}`);
    expect(state.reveals).toHaveLength(MAX_REVEALS);
    expect(state.reveals.at(-1)).toBe("n39");
  });

  it("the latest choice wins for a child of two parents: either parent's caret shows or hides it", () => {
    // C is an edit of A and B.
    const scope = scopeOf([node("root"), node("A", ["root"]), node("B", ["root"]), node("C", ["A", "B"])]);
    let state = expandNode(NO_EXPANSION, scope, "A");
    expect(shown(state, scope)).toEqual(["A", "B", "C", "root"]);
    expect(expandNode(state, scope, "B"), "selecting B, whose child is shown, changes nothing").toBe(state);
    expect(carets(state, scope), "both parents offer a caret").toEqual(["A", "B", "root"]);
    expect(opened(state, scope)).toEqual(["A", "B", "root"]);
    // Collapsing B hides C although A expanded it earlier.
    state = toggleNode(state, scope, "B");
    expect(shown(state, scope)).toEqual(["A", "B", "root"]);
    expect(carets(state, scope)).toEqual(["A", "B", "root"]);
    expect(opened(state, scope), "neither reads expanded").toEqual(["root"]);
    // Expanding B shows it again; then collapsing A hides it while B is expanded.
    state = toggleNode(state, scope, "B");
    expect(shown(state, scope)).toContain("C");
    state = toggleNode(state, scope, "A");
    expect(shown(state, scope)).toEqual(["A", "B", "root"]);
    expect(isOpen(state, scope, "B"), "B's caret reads collapsed for C").toBe(false);
    state = toggleNode(state, scope, "B");
    expect(shown(state, scope)).toEqual(["A", "B", "C", "root"]);
  });

  it("every caret press changes what is shown", () => {
    // Charizard is an edit of Ash and Blastoise; Mew of Ash; Ditto an in-folder root fed by a reference input.
    const scope = scopeOf([node("root"), node("Saffron", ["root"]), node("Blastoise", ["Saffron"]), node("Ash", ["Saffron"]), node("Charizard", ["Ash", "Blastoise"]),
      node("Mew", ["Ash"]), node("outside", [], "external", { path: null }), node("Ditto", ["outside"])]);
    let state = expandNode(expandNode(NO_EXPANSION, scope, "Saffron"), scope, "Ash");
    for (let step = 0; step < 12; step++) {
      const offered = carets(state, scope);
      // The cover's caret closes its stack instead.
      for (const key of offered.filter((key) => key !== scope.cover)) expect(shown(toggleNode(state, scope, key), scope), `${key} changes something`).not.toEqual(shown(state, scope));
      // Nothing without a caret could change anything.
      for (const key of shown(state, scope).filter((key) => !offered.includes(key))) expect(shown(toggleNode(state, scope, key), scope), `${key} has no caret`).toEqual(shown(state, scope));
      const choices = offered.filter((key) => key !== scope.cover);
      state = toggleNode(state, scope, choices[step % choices.length]);
    }
    // A reference input whose only children are roots holds nothing back: it offers no caret.
    expect(carets(revealNode(NO_EXPANSION, "outside"), scope)).not.toContain("outside");
  });

  it("an unrelated collapse never takes a child shown through another parent", () => {
    // C is an edit of A and of B, which sits under P.
    const scope = scopeOf([node("root"), node("A", ["root"]), node("P", ["root"]), node("B", ["P"]), node("C", ["A", "B"])]);
    let state = expandNode(NO_EXPANSION, scope, "A");
    expect(shown(state, scope)).toEqual(["A", "B", "C", "P", "root"]);
    // B is shown as C's input; collapsing P would hide nothing, so P offers no caret.
    expect(carets(state, scope)).not.toContain("P");
    expect(shown(toggleNode(state, scope, "P"), scope)).toEqual(shown(state, scope));
    // Collapsing B (the latest choice for C) hides C, and B with it: it was shown only as C's input.
    state = toggleNode(state, scope, "B");
    expect(shown(state, scope)).toEqual(["A", "P", "root"]);
  });

  it("a first click only ever shows things, whatever was chosen before", () => {
    const scope = scopeOf([node("root"), node("A", ["root"]), node("B", ["root"]), node("C", ["A", "B"]), node("D", ["C"]), node("E", ["B"])]);
    const states: Expansion[] = [NO_EXPANSION];
    for (const key of ["A", "B", "C", "root"]) for (const state of [...states]) states.push(toggleNode(state, scope, key));
    for (const state of states) for (const key of scope.members) {
      const before = shown(state, scope), after = shown(expandNode(state, scope, key), scope);
      expect(before.every((shownKey) => after.includes(shownKey)), `clicking ${key} hides nothing`).toBe(true);
    }
  });

  it("an expanded reference badge follows the same rule as a parent", () => {
    const nodes = [node("root"), node("a", ["root"]), node("style", [], "external"), node("c", ["a", "style"]), node("d", ["root", "style"])];
    const scope = scopeOf(nodes, "root");
    let state = expandNode(NO_EXPANSION, scope, "style");
    expect(shown(state, scope)).toEqual(["a", "c", "d", "root"]);
    expect(carets(state, scope)).toContain("style");
    // Collapsing a hides c, the badge's consumer, as the latest choice for it.
    state = toggleNode(state, scope, "a");
    expect(shown(state, scope)).toEqual(["a", "d", "root"]);
    expect(isOpen(state, scope, "style")).toBe(false);
  });

  it("finds carets in linear-ish time on a 20,000-step revealed chain", () => {
    const chain = scopeOf(Array.from({ length: 20_000 }, (_, i) => node(`n${i}`, i ? [`n${i - 1}`] : [], "current", { order: i })));
    const state = revealNode(NO_EXPANSION, "n19999");
    const start = performance.now();
    const { togglable } = bandCarets(chain.graph, chain.members, expandedKeys(state, chain));
    expect(togglable.size).toBe(19_999);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("expansion state hygiene", () => {
  it("drops choices of nodes that are gone, keeps present ones and the most recent unknown ones", () => {
    const choices = new Map<string, boolean>([["gone", true], ["here", false], ...Array.from({ length: 300 }, (_, i) => [`u${i}`, true] as [string, boolean])]);
    const state: Expansion = { choices, reveals: ["gone", "here"] };
    const pruned = pruneExpansion(state, (key) => key === "gone" ? "gone" : key === "here" ? "present" : "unknown");
    expect(pruned.choices.has("gone")).toBe(false);
    expect(pruned.choices.get("here")).toBe(false);
    expect(pruned.reveals).toEqual(["here"]);
    const unknown = [...pruned.choices.keys()].filter((key) => key.startsWith("u"));
    expect(unknown).toHaveLength(MAX_UNKNOWN_CHOICES);
    expect(unknown.at(-1)).toBe("u299");
    expect(unknown[0]).toBe(`u${300 - MAX_UNKNOWN_CHOICES}`);
    expect(pruneExpansion(pruned, () => "present")).toBe(pruned);
  });

  it("keeps at most MAX_CHOICES choices, forgetting the oldest", () => {
    const scope = recording();
    const many: Expansion = { choices: new Map(Array.from({ length: MAX_CHOICES }, (_, i) => [`u${i}`, true] as [string, boolean])), reveals: [] };
    const next = toggleNode(many, scope, "Saffron");
    expect(next.choices.size).toBe(MAX_CHOICES);
    expect(next.choices.has("u0"), "the oldest is forgotten").toBe(false);
    expect([...next.choices.keys()].at(-1)).toBe("Saffron");
    expect(readExpansion({ choices: new Map(Array.from({ length: MAX_CHOICES + 5 }, (_, i) => [`r${i}`, false])) }).choices.size).toBe(MAX_CHOICES);
  });

  it("reads malformed remembered state as no expansion, keeping well-formed choices", () => {
    for (const value of [null, undefined, 3, "x", [], {}, { choices: [["a", true]] }]) expect(readExpansion(value)).toEqual(NO_EXPANSION);
    const read = readExpansion({ choices: new Map<unknown, unknown>([["a", true], [3, true], ["b", "yes"], ["", true], ["c", false]]), reveals: ["x", 7, "", "x", "y"] });
    expect([...read.choices]).toEqual([["a", true], ["c", false]]);
    expect(read.reveals).toEqual(["x", "y"]);
    // An older snapshot's single reveal, and a malformed one.
    expect(readExpansion({ choices: new Map(), reveal: "old" }).reveals).toEqual(["old"]);
    expect(readExpansion({ choices: new Map(), reveal: 7 }).reveals).toEqual([]);
  });

  it("compares by contents and order (the latest choice decides), not identity", () => {
    const a: Expansion = { choices: new Map([["x", true], ["y", false]]), reveals: [] };
    expect(sameExpansion(a, { choices: new Map([["x", true], ["y", false]]), reveals: [] })).toBe(true);
    expect(sameExpansion(a, { choices: new Map([["y", false], ["x", true]]), reveals: [] }), "the same choices made in another order").toBe(false);
    expect(sameExpansion(a, { choices: new Map([["x", true]]), reveals: [] })).toBe(false);
    expect(sameExpansion(a, { ...a, reveals: ["x"] })).toBe(false);
  });

  it("ignores keys outside the stack and empty keys", () => {
    const scope = recording();
    expect(toggleNode(NO_EXPANSION, scope, "elsewhere")).toBe(NO_EXPANSION);
    expect(toggleNode(NO_EXPANSION, scope, "")).toBe(NO_EXPANSION);
    expect(revealNode(NO_EXPANSION, "")).toBe(NO_EXPANSION);
    expect(shown({ choices: new Map([["elsewhere", true]]), reveals: ["nowhere"] }, scope)).toEqual(shown(NO_EXPANSION, scope));
  });

  it("stays linear on a 20,000-step chain and a 5,000-child fan", () => {
    const chain = scopeOf(Array.from({ length: 20_000 }, (_, i) => node(`n${i}`, i ? [`n${i - 1}`] : [], "current", { order: i })));
    let start = performance.now();
    const deep = revealNode(NO_EXPANSION, "n19999");
    expect(shown(deep, chain)).toHaveLength(20_000);
    // Settling keeps at most MAX_CHOICES choices: toggle within a chain that fits.
    const fits = scopeOf(chain.members.slice(0, MAX_CHOICES).map((key, i) => node(key, i ? [`n${i - 1}`] : [], "current", { order: i })));
    const collapsed = toggleNode(revealNode(NO_EXPANSION, `n${MAX_CHOICES - 1}`), fits, "n1");
    expect(shown(collapsed, fits)).toHaveLength(2);
    expect(performance.now() - start).toBeLessThan(2000);
    const fan = scopeOf([node("root"), ...Array.from({ length: 5000 }, (_, i) => node(`f${i}`, ["root"])), ...Array.from({ length: 5000 }, (_, i) => node(`g${i}`, [`f${i}`]))]);
    start = performance.now();
    let state = NO_EXPANSION;
    for (let i = 0; i < 50; i++) state = expandNode(state, fan, `f${i}`);
    expect(shown(state, fan)).toHaveLength(1 + 5000 + 50);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
