/**
 * Property tests on seeded random provenance DAGs: the engine's invariants hold for every graph,
 * not only the hand cases. Graphs come from the generative workflow model
 * (`layout-eval/provenance-model.ts`, every profile) and from unstructured random DAGs; each is
 * laid out from scratch, along a tour of clicks, and along its growth (one image arriving at a
 * time below its selected input), as the view requests them.
 */
import { describe, expect, it } from "vitest";
import { layoutGraph, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { measure } from "$lib/domain/trace-graph/layout-quality";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { node, requestFor, rng, type Case } from "../../../layout-eval/corpus";
import { profiles, provenanceSession, sessionComponents } from "../../../layout-eval/provenance-model";

const WIDTHS = [360, 454, 640, 900, 1400];

/** A DAG with no workflow structure: each image has 1–3 inputs among any earlier ones. */
function randomDag(seed: number): TraceNode[] {
  const random = rng(seed), n = 2 + Math.floor(random() * 28), nodes = [node("root")];
  for (let i = 1; i < n; i++) {
    const parents = new Set([nodes[Math.floor(random() * i)].key]);
    if (random() < .3) for (let j = Math.floor(random() * 2); j >= 0; j--) parents.add(nodes[Math.floor(random() * i)].key);
    nodes.push(node(`n${i}`, [...parents], i));
  }
  return nodes;
}

/** The largest component of one generated session, re-keyed so its first image is the cover. */
function session(profile: string, seed: number): TraceNode[] {
  const component = sessionComponents(provenanceSession(profiles[profile], seed)).sort((a, b) => b.length - a.length)[0];
  const rename = new Map(component.map((n, i) => [n.key, i ? n.key : "root"]));
  return component.map(n => ({ ...n, key: rename.get(n.key)!, parents: n.parents.filter(p => rename.has(p)).map(p => rename.get(p)!) }));
}

const graphs: { readonly id: string; readonly nodes: TraceNode[]; readonly width: number }[] = [
  ...Object.keys(profiles).flatMap(profile => [1, 2, 3, 4].map(seed => ({ id: `${profile}-${seed}`, nodes: session(profile, seed), width: WIDTHS[(seed * 7) % WIDTHS.length] }))),
  ...Array.from({ length: 16 }, (_, seed) => ({ id: `dag-${seed}`, nodes: randomDag(4100 + seed), width: WIDTHS[seed % WIDTHS.length] })),
];

const commit = (request: LayoutRequest) => {
  const layout = layoutGraph(request);
  return { layout, history: { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) } };
};

/**
 * Every hard gate, shared lanes only as a listed fallback, and the anchors kept unless a flagged
 * fallback moved them. `pushed`: how far tiles above the anchor grew (a tile's first output gives
 * it the expansion hint, and it grows in place), which the anchor may move straight down by.
 */
function check(request: LayoutRequest, previous?: ReturnType<typeof commit>["history"], anchor?: string, pushed = 0) {
  const { layout, history } = commit(request);
  const metrics = measure(history.placed, request.band!.key, request.maxWidth, request.items, previous?.placed, anchor);
  expect([metrics.tileIntersections, metrics.overlaps, metrics.directionViolations, metrics.missingEdges, metrics.extraEdges, metrics.missingNodes,
    metrics.extraNodes, metrics.invalidGeometry, metrics.invalidPaths, metrics.terminalViolations, metrics.disconnectedEdges]).toEqual(Array(11).fill(0));
  const fallback = layout.decision?.fallback;
  if (fallback !== "lane-infeasible") expect(metrics.sharedLanePx).toBe(0);
  if (anchor && previous && fallback !== "anchor-yield" && fallback !== "anchor-infeasible") {
    const was = previous.placed.nodes.get(anchor)!, now = history.placed.nodes.get(anchor)!;
    expect(now.x).toBeCloseTo(was.x, 6);
    expect(now.y - was.y).toBeGreaterThanOrEqual(0);
    expect(now.y - was.y).toBeLessThanOrEqual(pushed);
  }
  return { history, metrics, fallback };
}

describe("layout properties on seeded random DAGs", () => {
  it.each(graphs)("$id: valid from scratch, deterministic, and independent of input order", ({ nodes, width }) => {
    const c: Case = { id: "p", nodes, focuses: [null] };
    const request = requestFor(c, null, width, 96);
    const { metrics } = check(request);
    // A tree always fits the pane: only lanes for merges may widen the margins (docs/trace-view-layout.md).
    if (nodes.every(n => n.parents.length <= 1)) expect(metrics.overflow).toBe(0);
    const first = layoutGraph(request);
    expect(layoutGraph(request)).toEqual(first);
    expect(layoutGraph({ ...request, items: [...request.items].reverse(), band: { ...request.band!, items: [...request.band!.items].reverse() } })).toEqual(first);
  });

  it.each(graphs)("$id: clicks keep the clicked tile and its ancestors still unless flagged", ({ nodes, width }) => {
    const random = rng(nodes.length * 31 + width);
    const c: Case = { id: "p", nodes, focuses: [null] };
    let previous = commit(requestFor(c, null, width, 96)).history;
    for (let step = 0; step < 6; step++) {
      // Only a shown tile can be clicked.
      const shown = [...previous.placed.nodes.keys()], focus = shown[Math.floor(random() * shown.length)];
      const request = { ...requestFor(c, focus, width, 96), anchorKey: focus, history: previous };
      previous = check(request, previous, focus).history;
    }
  });

  it.each(graphs)("$id: growth keeps the selected input still unless flagged, and stays valid", ({ nodes, width }) => {
    const limit = Math.min(nodes.length, 24);
    let yielded = 0, steps = 0;
    for (let k = 2; k < limit; k++) {
      const input = nodes[k].parents[0];
      if (!input) continue;
      const before: Case = { id: "p", nodes: nodes.slice(0, k), focuses: [null] }, after: Case = { id: "p", nodes: nodes.slice(0, k + 1), focuses: [null] };
      const first = requestFor(before, input, width, 96), previous = commit(first).history, next = requestFor(after, input, width, 96);
      const top = previous.placed.nodes.get(input)!.y, grew = new Map(next.items.map(n => [n.key, n.height]));
      // A tile the arrival hides (its branch collapsed under explicit expansion) pushes nothing.
      const pushed = first.items.reduce((sum, n) => sum + (previous.placed.nodes.get(n.key)!.y < top ? Math.max(0, (grew.get(n.key) ?? n.height) - n.height) : 0), 0);
      const { fallback } = check({ ...next, anchorKey: input, history: previous }, previous, input, pushed);
      steps++;
      if (fallback === "anchor-yield" || fallback === "anchor-infeasible") yielded++;
    }
    // Yields are exceptions (a cap fired), not the rule.
    expect(yielded).toBeLessThanOrEqual(Math.max(2, steps / 4));
  });
});
