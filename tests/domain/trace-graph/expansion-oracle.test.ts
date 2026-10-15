import { describe, expect, it } from "vitest";
import { projectDag, projectReferenceBadges } from "$lib/domain/trace-graph/projection";
import { bandCarets, bandVisibleKeys, componentRoots } from "$lib/domain/trace-graph/visibility";
import {
  NO_EXPANSION, expandForOutputs, expandNode, expandedKeys, expansionAnchor, isOpen, openStack, revealNode, settleReveal, toggleNode,
  type Expansion, type ExpansionScope,
} from "$lib/domain/trace-graph/expansion";
import type { NodeScope, TraceNode } from "$lib/domain/trace-graph/model";
import { node } from "./fixtures";

/**
 * A brute-force oracle over about 2,000 random small stacks (mixed scopes, reference badges, edits
 * of several inputs) and random sequences of first clicks, toggles, reveals and reopenings. Each
 * state is checked against the rules in docs/trace-view-layout.md ("Visible nodes", "Interaction
 * model") by trying every action and comparing what is shown.
 */
// Deterministic PRNG.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

function randomNodes(r: () => number): TraceNode[] {
  const n = 2 + Math.floor(r() * 8);
  const nodes: TraceNode[] = [];
  for (let i = 0; i < n; i++) {
    const scope: NodeScope = r() < 0.7 ? "current" : r() < 0.5 ? "subfolder" : "external";
    const parents: string[] = [];
    if (i > 0) { const k = Math.floor(r() * 4); for (let j = 0; j < k; j++) { const p = `n${Math.floor(r() * i)}`; if (!parents.includes(p)) parents.push(p); } }
    nodes.push(node(`n${i}`, parents, scope, { order: i + 1 }));
  }
  return nodes;
}

function connected(nodes: TraceNode[]): boolean {
  const adj = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const n of nodes) for (const p of n.parents) { adj.get(n.key)!.push(p); adj.get(p)!.push(n.key); }
  const seen = new Set([nodes[0].key]), stack = [nodes[0].key];
  while (stack.length) for (const x of adj.get(stack.pop()!)!) if (!seen.has(x)) { seen.add(x); stack.push(x); }
  return seen.size === nodes.length;
}

function scopeOf(nodes: TraceNode[]): ExpansionScope | null {
  const graph = projectReferenceBadges(projectDag(nodes));
  const members = graph.dag.order;
  const roots = componentRoots(graph.dag, members, "in-folder");
  if (!roots.length) return null;
  return { graph, members, cover: roots[0] };
}

const vis = (s: Expansion, sc: ExpansionScope) => new Set(bandVisibleKeys(sc.graph, sc.members, expandedKeys(s, sc)));
const shownBadges = (v: Set<string>, sc: ExpansionScope) => [...sc.graph.badges.keys()].filter((b) => sc.graph.badges.get(b)!.consumers.some((c) => v.has(c)));
const kids = (sc: ExpansionScope, k: string) => sc.graph.badges.get(k)?.consumers.filter((c) => sc.members.includes(c)) ?? (sc.graph.dag.children.get(k) ?? []);
const eq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const sub = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

type Fail = { kind: string; detail: string };

function check(nodes: TraceNode[], sc: ExpansionScope, s: Expansion, fails: Fail[], hist: string[]) {
  const V = vis(s, sc);
  const E = expandedKeys(s, sc);
  const C = bandCarets(sc.graph, sc.members, E);
  const ctx = () => JSON.stringify({ nodes: nodes.map((n) => [n.key, n.parents, n.scope]), hist, choices: [...s.choices], reveals: s.reveals, V: [...V] });
  const keys = [...[...V].filter((k) => sc.members.includes(k)), ...shownBadges(V, sc)];
  for (const k of keys) {
    const ch = kids(sc, k);
    if (!ch.length) continue;
    if (C.open.has(k) !== isOpen(s, sc, k)) fails.push({ kind: "open-mismatch", detail: `${k} ${ctx()}` });
    if (k === sc.cover) continue;
    const t = toggleNode(s, sc, k);
    const changed = !eq(vis(t, sc), V);
    if (changed !== C.togglable.has(k)) {
      const badge = sc.graph.badges.has(k);
      const coverShared = ch.every((c) => (sc.graph.dag.parents.get(c) ?? []).includes(sc.cover));
      fails.push({ kind: (changed ? "caret-missing" : "caret-noop") + (badge ? "-badge" : "-member") + (coverShared ? "-coverchild" : ""), detail: `${k} ${ctx()}` });
    }
  }
  // First click on any shown member.
  for (const k of [...V].filter((x) => sc.members.includes(x))) {
    const f = expandNode(s, sc, k);
    const V2 = vis(f, sc);
    if (!sub(V, V2)) fails.push({ kind: "first-click-hides", detail: `${k} ${ctx()}` });
    if (!kids(sc, k).every((c) => V2.has(c))) fails.push({ kind: "first-click-not-all-children", detail: `${k} ${ctx()}` });
    const leafOrOpen = !kids(sc, k).length || kids(sc, k).every((c) => V.has(c));
    if (leafOrOpen) {
      if (!eq(V, V2)) fails.push({ kind: "leaf/open-click-changes-visible", detail: `${k} ${ctx()}` });
      const C2 = bandCarets(sc.graph, sc.members, expandedKeys(f, sc));
      if (!eq(new Set(C.togglable), new Set(C2.togglable)) || !eq(new Set(C.open), new Set(C2.open))) fails.push({ kind: "leaf/open-click-changes-carets", detail: `${k} ${ctx()}` });
      if (expansionAnchor(f, sc) !== expansionAnchor(s, sc)) fails.push({ kind: "leaf/open-click-moves-anchor", detail: `${k} ${ctx()}` });
    }
  }
  // Reveal any member; settling keeps what is shown.
  for (const m of sc.members) {
    const rv = revealNode(s, m);
    const V3 = vis(rv, sc);
    if (!V3.has(m)) fails.push({ kind: "reveal-not-shown", detail: `${m} ${ctx()}` });
    if (!sub(V, V3)) fails.push({ kind: "reveal-hides", detail: `${m} ${ctx()}` });
    const st = settleReveal(rv, sc);
    if (!eq(vis(st, sc), V3)) fails.push({ kind: "settle-changes-visible", detail: `${m} ${ctx()}` });
  }
  // Determinism: shuffle node order in input and parents.
  const shuffled = nodes.map((n) => ({ ...n, parents: [...n.parents].reverse() })).reverse();
  const sc2 = scopeOf(shuffled);
  if (sc2) {
    const sc2c = { ...sc2, cover: sc.cover };
    if (!eq(vis(s, sc2c), V)) fails.push({ kind: "order-dependent", detail: ctx() });
  }
  // Own AI edit outputs: a new node with 1-2 random inputs (members or badges) becomes visible.
  const inputs = [...sc.members, ...sc.graph.badges.keys()];
  for (let i = 0; i < inputs.length; i++) for (let j = i; j < inputs.length; j++) {
    const ins = [...new Set([inputs[i], inputs[j]])];
    let e = s;
    for (const k of ins) e = expandForOutputs(e, sc, k);
    const out = node("OUT", ins, "current", { order: 1000 });
    const nodes2 = [...nodes, out];
    const g = projectReferenceBadges(projectDag(nodes2));
    const sc3: ExpansionScope = { graph: g, members: g.dag.order, cover: sc.cover };
    if (!vis(e, sc3).has("OUT")) fails.push({ kind: "own-output-hidden", detail: `inputs=${ins} ${ctx()}` });
    const Vb = vis(e, sc);
    if (!sub(V, Vb)) fails.push({ kind: "expandForOutputs-hides", detail: `inputs=${ins} ${ctx()}` });
  }
}

const SEEDS = 2500;

describe("expansion oracle: random stacks and random actions", () => {
  it("every offered caret changes what is shown, carets read what is shown, first clicks and reveals only show, and the result is deterministic", () => {
    const fails: Fail[] = [];
    const counts = new Map<string, number>();
    let cases = 0;
    for (let seed = 1; seed < SEEDS; seed++) {
      const r = rng(seed);
      const nodes = randomNodes(r);
      if (!connected(nodes)) continue;
      const sc = scopeOf(nodes);
      if (!sc) continue;
      cases++;
      // The stack opens: its cover's expansion is the latest choice.
      let s = openStack(NO_EXPANSION, sc.cover);
      const hist: string[] = [];
      const steps = Math.floor(r() * 7);
      for (let i = 0; i <= steps; i++) {
        check(nodes, sc, s, fails, [...hist]);
        const V = [...vis(s, sc)];
        const pool = [...V, ...shownBadges(new Set(V), sc)];
        const k = pool[Math.floor(r() * pool.length)];
        const a = r();
        if (a < 0.4) { s = toggleNode(s, sc, k); hist.push(`toggle ${k}`); }
        else if (a < 0.8) { s = expandNode(s, sc, k); hist.push(`expand ${k}`); }
        else if (a < 0.93) { const m = sc.members[Math.floor(r() * sc.members.length)]; s = revealNode(s, m); hist.push(`reveal ${m}`); }
        else { s = openStack(s, sc.cover); hist.push("reopen"); }
      }
    }
    for (const f of fails) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    // The smallest example of each kind, to reproduce it.
    const best = new Map<string, string>();
    for (const f of fails) { const b = best.get(f.kind); if (!b || f.detail.length < b.length) best.set(f.kind, f.detail); }
    expect(cases).toBeGreaterThan(1000);
    expect(Object.fromEntries(counts), [...best].map(([kind, detail]) => `${kind}: ${detail}`).join("\n")).toEqual({});
  }, 60_000); // 2500 seeds take ~2.5 s alone; a loaded machine running the suite in parallel can take several times that.
});
