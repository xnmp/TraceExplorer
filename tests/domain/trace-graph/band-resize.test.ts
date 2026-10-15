/**
 * A tile changes size when its first output arrives (it gains the expansion hint) and again when
 * its last output leaves (a failed or dismissed placeholder). When that output is out of sight,
 * nothing else in the band changed: the band must keep its geometry, the tile growing or shrinking
 * in place, and stay valid. Graphs come from the generative workflow model and the random corpus.
 */
import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphLayout, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { resizedLayout } from "$lib/domain/trace-graph/band-history";
import { validateLayout, segments, type Measures } from "$lib/domain/trace-graph/layout-quality";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { corpus, node, requestFor, type Case } from "../../../layout-eval/corpus";
import { profiles, provenanceSession, sessionComponents } from "../../../layout-eval/provenance-model";

/** The largest component of one generated session, re-keyed so its first image is the cover. */
function session(profile: string, seed: number): TraceNode[] {
  const component = sessionComponents(provenanceSession(profiles[profile], seed)).sort((a, b) => b.length - a.length)[0];
  const rename = new Map(component.map((n, i) => [n.key, i ? n.key : "root"]));
  return component.map(n => ({ ...n, key: rename.get(n.key)!, parents: n.parents.filter(p => rename.has(p)).map(p => rename.get(p)!) }));
}

const cases: readonly Case[] = [
  ...Object.keys(profiles).flatMap(profile => [1, 2, 3].map(seed => ({ id: `${profile}-${seed}`, nodes: session(profile, seed), focuses: [null] }))),
  ...corpus().filter(c => c.nodes.length <= 40),
];
const WIDTHS = [360, 1400];
const HINT = 16;

const commit = (request: LayoutRequest) => {
  const layout = layoutGraph(request);
  return { signature: bandHistorySignature(request), layout, placed: attachSingleBand(layout, request) };
};

/** Whether the engine reported letting the anchor go (it would make the band far taller, or cannot be held). */
const flagged = (h: ReturnType<typeof commit>) => h.layout.decision?.fallback === "anchor-yield" || h.layout.decision?.fallback === "anchor-infeasible";

const GATES = ["tileIntersections", "overlaps", "directionViolations", "missingEdges", "extraEdges", "missingNodes", "extraNodes",
  "invalidGeometry", "invalidPaths", "terminalViolations", "disconnectedEdges", "sharedLanePx"] as const;
/** The hard gates `after` fails that `before` passed. */
const newlyFailed = (before: Measures, after: Measures) => GATES.filter(gate => after[gate] > 0 && !(before[gate] > 0));

/** Tiles of `before` that `after` moved, other than straight down by at most `down`. */
function movedTiles(before: GraphLayout, after: GraphLayout, down = 0): string[] {
  return [...before.nodes].filter(([key, was]) => {
    const now = after.nodes.get(key);
    return !now || Math.abs(now.x - was.x) > .01 || now.y < was.y - .01 || now.y > was.y + down + .01;
  }).map(([key]) => key);
}

/** The drawing of a layout: tiles, junctions, and each route's points without repeats. */
function drawing(layout: GraphLayout) {
  const points = (path: string) => segments(path).flatMap(([a, b], i) => i ? [b] : [a, b])
    .filter((p, i, all) => !i || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-6).map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]);
  return { nodes: [...layout.nodes.values()], junctions: [...layout.junctions.values()], routes: layout.routes.map(r => points(r.path)) };
}

describe("an output arriving out of sight", () => {
  it("grows its input's tile in place: no tile moves, and the band stays valid", () => {
    let tried = 0;
    for (const c of cases) for (const width of WIDTHS) {
      const focus = c.nodes.find(n => n.parents.length)?.key;
      if (!focus) continue;
      const selected = commit({ ...requestFor(c, focus, width, 96), anchorKey: focus, history: commit(requestFor(c, null, width, 96)) });
      const request = { ...requestFor(c, focus, width, 96), anchorKey: focus };
      const visible = new Set(request.items.map(i => i.key));
      const leaves = request.items.filter(i => i.key !== focus && i.key !== request.band!.key && !c.nodes.some(n => n.parents.includes(i.key)));
      for (const leaf of leaves.slice(0, 2)) {
        const grown: Case = { ...c, nodes: [...c.nodes, node(`${leaf.key}-output`, [leaf.key], 1e6)] };
        const next = { ...requestFor(grown, focus, width, 96), anchorKey: focus, history: selected };
        if (next.items.some(i => !visible.has(i.key))) continue; // the output is visible: not this case
        tried++;
        const after = commit(next);
        expect(after.placed.nodes.get(leaf.key)!.height, `${c.id} w=${width} ${leaf.key}`).toBeGreaterThan(selected.placed.nodes.get(leaf.key)!.height);
        expect(movedTiles(selected.placed, after.placed, HINT), `${c.id} w=${width} ${leaf.key}`).toEqual([]);
        expect(newlyFailed(validateLayout(selected.placed, next.band!.key, width, request.items), validateLayout(after.placed, next.band!.key, width, next.items)), `${c.id} w=${width} ${leaf.key}`).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(20);
  });

  it("an edit on the selected image that fails leaves the selected tile where it was, unless a flagged fallback moved it", () => {
    let tried = 0;
    for (const c of cases) for (const width of WIDTHS) {
      const children = new Set(c.nodes.flatMap(n => n.parents));
      for (const x of c.nodes.filter(n => n.parents.length && !children.has(n.key)).slice(0, 2)) {
        tried++;
        const selected = commit({ ...requestFor(c, x.key, width, 96), anchorKey: x.key, history: commit(requestFor(c, null, width, 96)) });
        const running: Case = { ...c, nodes: [...c.nodes, { ...node("placeholder", [x.key], 1e6), state: "running" }] };
        const started = commit({ ...requestFor(running, x.key, width, 96), anchorKey: x.key, history: selected });
        const failed = commit({ ...requestFor(c, x.key, width, 96), anchorKey: x.key, history: started });
        const where = (h: typeof selected) => { const n = h.placed.nodes.get(x.key)!; return [n.x, n.y]; };
        if (!flagged(started)) expect(where(started), `${c.id} w=${width} ${x.key} started`).toEqual(where(selected));
        if (!flagged(failed)) expect(where(failed), `${c.id} w=${width} ${x.key} failed`).toEqual(where(started));
      }
    }
    expect(tried).toBeGreaterThan(20);
  });
});

describe("resizedLayout on the engine's own layouts", () => {
  /** Every layout of the sample, laid out from scratch, with its leaves (tiles without outputs). */
  const layouts = cases.flatMap(c => WIDTHS.map(width => {
    const request = requestFor(c, null, width, 96), children = new Set(c.nodes.flatMap(n => n.parents));
    return { id: `${c.id} w=${width}`, request, placed: attachSingleBand(layoutGraph(request), request),
      leaves: request.items.filter(i => i.key !== request.band!.key && !children.has(i.key)) };
  }));

  it("growing any leaf by the hint keeps every hard gate the layout passed", () => {
    let tried = 0;
    for (const { id, request, placed, leaves } of layouts) {
      const before = validateLayout(placed, request.band!.key, request.maxWidth, request.items);
      for (const leaf of leaves) {
        tried++;
        const grown = resizedLayout(placed, new Map([[leaf.key, leaf.height + HINT]]));
        const items = request.items.map(i => i.key === leaf.key ? { ...i, height: i.height + HINT } : i);
        expect(newlyFailed(before, validateLayout(grown, request.band!.key, request.maxWidth, items)), `${id} grow ${leaf.key}`).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(200);
  });

  it("growing a leaf and shrinking it back restores the drawing", () => {
    for (const { id, placed, leaves } of layouts) for (const leaf of leaves) {
      const grown = resizedLayout(placed, new Map([[leaf.key, leaf.height + HINT]]));
      expect(drawing(resizedLayout(grown, new Map([[leaf.key, leaf.height]]))), `${id} ${leaf.key}`).toEqual(drawing(placed));
    }
  });
});
