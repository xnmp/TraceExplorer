import { expectArrivalPinned } from './arrival-contract';
/**
 * A tile changes size when its first output arrives (it gains the expansion hint) and again when
 * its last output leaves (a failed or dismissed placeholder). When that output is out of sight,
 * nothing else in the band changed: the band keeps x, and only tiles below a newly hinted tile
 * in its column may descend by exactly the hint height. Shrink keeps positions. Graphs come from
 * the generative workflow model and the random corpus.
 */
import { describe, expect, it } from "vitest";
import { layoutGraph, type GraphLayout, type LayoutRequest } from "$lib/domain/trace-graph/layout";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { attachSingleBand } from "$lib/domain/trace-graph/band-geometry";
import { resizedLayout, resizedTiles } from "$lib/domain/trace-graph/band-history";
import { validateLayout, segments, type Measures } from "$lib/domain/trace-graph/layout-quality";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { corpus, node, requestFor, type Case } from "../../../layout-eval/corpus";
import { profiles, provenanceSession, sessionComponents } from "../../../layout-eval/provenance-model";
import { createDefaultEngine, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { folderInput, makeFolder } from "./folder-layout-fixtures";

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
/** The default tile (48, where a stack gap is only 16 px) and a larger one. */
const IMAGE_PX = [48, 96];
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

/** Tiles of `before` that `after` moved, other than an exact hint shift below `hintKey` in its column. */
function movedTiles(before: GraphLayout, after: GraphLayout, down = 0, hintKey?: string): string[] {
  const upper = hintKey ? before.nodes.get(hintKey) : undefined;
  return [...before.nodes].filter(([key, was]) => {
    const now = after.nodes.get(key);
    const inColumn = upper && key !== hintKey && was.y >= upper.y + upper.height && was.x < upper.x + upper.width && upper.x < was.x + was.width;
    return !now || now.x !== was.x || !(inColumn ? [0, down] : [0]).includes(now.y - was.y);
  }).map(([key]) => key);
}

/** Retained columns keep their order and never overlap; routing clearance has its own gate. */
function overlappingColumns(before: GraphLayout, after: GraphLayout): string[] {
  const out: string[] = [];
  for (const [ka, a] of after.nodes) for (const [kb, b] of after.nodes) {
    const wa = before.nodes.get(ka), wb = before.nodes.get(kb);
    if (ka === kb || !wa || !wb || wb.y < wa.y + wa.height || !(a.x < b.x + b.width && b.x < a.x + a.width)) continue;
    if (b.y < a.y + a.height) out.push(`${ka} overlaps ${kb}`);
  }
  return out;
}

/** The drawing of a layout: tiles, junctions, and each route's points without repeats. */
function drawing(layout: GraphLayout) {
  const points = (path: string) => segments(path).flatMap(([a, b], i) => i ? [b] : [a, b])
    .filter((p, i, all) => !i || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 1e-6).map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]);
  return { nodes: [...layout.nodes.values()], junctions: [...layout.junctions.values()], routes: layout.routes.map(r => points(r.path)) };
}

describe("an output arriving out of sight", () => {
  it("grows only the input hint and permits exact hint descent in its column", () => {
    let tried = 0;
    for (const c of cases) for (const width of WIDTHS) for (const imagePx of IMAGE_PX) {
      const focus = c.nodes.find(n => n.parents.length)?.key;
      if (!focus) continue;
      const selected = commit({ ...requestFor(c, focus, width, imagePx), anchorKey: focus, history: commit(requestFor(c, null, width, imagePx)) });
      const request = { ...requestFor(c, focus, width, imagePx), anchorKey: focus };
      const visible = new Set(request.items.map(i => i.key));
      const leaves = request.items.filter(i => i.key !== focus && i.key !== request.band!.key && !c.nodes.some(n => n.parents.includes(i.key)));
      for (const leaf of leaves.slice(0, 2)) {
        const grown: Case = { ...c, nodes: [...c.nodes, node(`${leaf.key}-output`, [leaf.key], 1e6)] };
        const next = { ...requestFor(grown, focus, width, imagePx), anchorKey: focus, history: selected };
        if (next.items.some(i => !visible.has(i.key))) continue; // the output is visible: not this case
        const after = commit(next);
        tried++;
        const where = `${c.id} w=${width} px=${imagePx} ${leaf.key}`;
        expect(after.placed.nodes.get(leaf.key)!.height, where).toBe(selected.placed.nodes.get(leaf.key)!.height + HINT);
        expectArrivalPinned(selected.placed, after.placed, where);
        expect(overlappingColumns(selected.placed, after.placed), where).toEqual([]);
        expect(newlyFailed(validateLayout(selected.placed, next.band!.key, width, request.items), validateLayout(after.placed, next.band!.key, width, next.items)), where).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(40);
  }, 60_000); // Exhaustive geometry corpus; request latency is gated separately by layout:eval.

  it("an edit on the selected image obeys arrival pins and pins its selection after failure", () => {
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
        expectArrivalPinned(selected.placed, started.placed, `${c.id} w=${width} ${x.key}`);
        if (!flagged(failed)) expect(where(failed), `${c.id} w=${width} ${x.key} failed`).toEqual(where(started));
      }
    }
    expect(tried).toBeGreaterThan(20);
  }, 60_000);
});

describe("an output leaving out of sight", () => {
  it("removes its hint when its last hidden output leaves", () => {
    let tried = 0;
    for (const c of cases) for (const width of WIDTHS) for (const imagePx of IMAGE_PX) {
      const focus = c.nodes.find(n => n.parents.length)?.key;
      if (!focus) continue;
      const request = { ...requestFor(c, focus, width, imagePx), anchorKey: focus };
      const visible = new Set(request.items.map(i => i.key));
      // A visible tile whose outputs are all hidden leaves of it alone: they leave without
      // orphaning anything or taking another tile's hint.
      const childrenOf = (key: string) => c.nodes.filter(n => n.parents.includes(key));
      const shrinking = request.items.filter(i => {
        const children = childrenOf(i.key);
        return i.key !== request.band!.key && children.length && children.every(k => !visible.has(k.key) && !childrenOf(k.key).length && k.parents.length === 1);
      });
      if (!shrinking.length) continue;
      const selected = commit({ ...request, history: commit(requestFor(c, null, width, imagePx)) });
      for (const tile of shrinking.slice(0, 2)) {
        const gone = new Set(childrenOf(tile.key).map(n => n.key));
        const after = commit({ ...requestFor({ ...c, nodes: c.nodes.filter(n => !gone.has(n.key)) }, focus, width, imagePx), anchorKey: focus, history: selected });
        if (flagged(after)) continue;
        tried++;
        const where = `${c.id} w=${width} px=${imagePx} ${tile.key}`;
        expect(after.placed.nodes.get(tile.key)!.height, where).toBe(selected.placed.nodes.get(tile.key)!.height - HINT);
        expect(movedTiles(selected.placed, after.placed), where).toEqual([]);
        expect(overlappingColumns(selected.placed, after.placed), where).toEqual([]);
        const items = requestFor({ ...c, nodes: c.nodes.filter(n => !gone.has(n.key)) }, focus, width, imagePx).items;
        expect(newlyFailed(validateLayout(selected.placed, request.band!.key, width, request.items), validateLayout(after.placed, request.band!.key, width, items)), where).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(20);
  }, 30_000); // Corpus sweep; request latency is gated separately by layout:eval.
});

describe("resizedLayout on the engine's own layouts", () => {
  /** Every layout of the sample, laid out from scratch, with its leaves (tiles without outputs). */
  const layouts = cases.flatMap(c => WIDTHS.flatMap(width => IMAGE_PX.map(imagePx => {
    const request = requestFor(c, null, width, imagePx), children = new Set(c.nodes.flatMap(n => n.parents));
    return { id: `${c.id} w=${width} px=${imagePx}`, imagePx, request, placed: attachSingleBand(layoutGraph(request), request),
      leaves: request.items.filter(i => i.key !== request.band!.key && !children.has(i.key)) };
  })));

  it("growing any leaf by the hint keeps every hard gate the layout passed, and nonoverlapping columns", () => {
    let tried = 0, declined = 0;
    for (const { id, imagePx, request, placed, leaves } of layouts) {
      const before = validateLayout(placed, request.band!.key, request.maxWidth, request.items);
      for (const leaf of leaves) {
        tried++;
        const grown = resizedLayout(placed, new Map([[leaf.key, leaf.height + HINT]]));
        // A column-local edit may need rerouting. Its fallback must keep the same exact pins.
        if (!grown) {
          declined++;
          expectArrivalPinned(placed, resizedTiles(placed, new Map([[leaf.key, leaf.height + HINT]])));
          continue;
        }
        const items = request.items.map(i => i.key === leaf.key ? { ...i, height: i.height + HINT } : i);
        expect(newlyFailed(before, validateLayout(grown, request.band!.key, request.maxWidth, items)), `${id} grow ${leaf.key}`).toEqual([]);
        expect(overlappingColumns(placed, grown), `${id} grow ${leaf.key}`).toEqual([]);
        expect(movedTiles(placed, grown, HINT, leaf.key), `${id} grow ${leaf.key}`).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(400);
    expect(tried - declined).toBeGreaterThan(0);
  });

  it("growing a leaf and shrinking it back restores the drawing, or keeps the space it took", () => {
    let restored = 0, tried = 0;
    for (const { id, imagePx, request, placed, leaves } of layouts) {
      const before = validateLayout(placed, request.band!.key, request.maxWidth, request.items);
      for (const leaf of leaves) {
        const grown = resizedLayout(placed, new Map([[leaf.key, leaf.height + HINT]]));
        const back = grown && resizedLayout(grown, new Map([[leaf.key, leaf.height]]));
        if (!back) continue;
        tried++;
        if (JSON.stringify(drawing(back)) === JSON.stringify(drawing(placed))) { restored++; continue; }
        // The space stayed: nothing rose above where it was, nothing sank further than the hint.
        expect(movedTiles(placed, back, HINT, leaf.key), `${id} ${leaf.key}`).toEqual([]);
        expect(overlappingColumns(placed, back), `${id} ${leaf.key}`).toEqual([]);
        expect(newlyFailed(before, validateLayout(back, request.band!.key, request.maxWidth, request.items)), `${id} ${leaf.key}`).toEqual([]);
      }
    }
    expect(tried).toBeGreaterThan(400);
    // Every accepted result above either restores the drawing or safely retains its space.
  }, 30_000); // Engine layouts across the corpus; about 2 s locally, slower on shared CI runners.

  it("repeated growing and shrinking never drifts: the second cycle ends where the first did", () => {
    for (const { id, placed, leaves } of layouts) for (const leaf of leaves.slice(0, 3)) {
      const cycle = (layout: GraphLayout | null) => {
        const grown = layout && resizedLayout(layout, new Map([[leaf.key, leaf.height + HINT]]));
        return grown && resizedLayout(grown, new Map([[leaf.key, leaf.height]]));
      };
      const once = cycle(placed), twice = cycle(once);
      if (once && twice) expect(drawing(twice), `${id} ${leaf.key}`).toEqual(drawing(once));
    }
  });
});

describe("through the folder engine, whose committed histories carry their attachment", () => {
  const engine = createDefaultEngine({ bandCache: null });
  /** The one stack of `nodes`, open, laid out after `previous`: its band as attached, and how it was chosen. */
  function step(nodes: readonly TraceNode[], focus: string, width: number, imagePx: number, previous: FolderLayout | null) {
    const folder = makeFolder({ stacks: [nodes] }), id = [...folder.stacks.keys()][0];
    const tile = tileMetrics(imagePx);
    const out = engine(folderInput(folder, { open: [id], focus: `s0:${focus}`, width, tile, grid: { cellWidth: tile.width, cellHeight: 0, gap: 8 }, previous }));
    const graph = out.graphs.get(id)!;
    return { out, graph, cover: id, decision: graph.layout.decision };
  }
  /** `layout` with the stack's key prefix taken off its tiles. */
  const plain = (layout: GraphLayout): GraphLayout => ({ ...layout, nodes: new Map([...layout.nodes].map(([k, n]) => [k.slice(3), { ...n, key: k.slice(3) }])) });

  it("an output arriving and then leaving out of sight keeps all retained rectangles", () => {
    let resized = 0;
    for (const c of cases.filter(c => c.nodes.length <= 30)) for (const width of [360, 900]) for (const imagePx of IMAGE_PX) {
      const focus = c.nodes.find(n => n.parents.length)?.key;
      if (!focus) continue;
      const first = step(c.nodes, focus, width, imagePx, null);
      const visible = new Set([...first.graph.layout.nodes.keys()].map(k => k.slice(3)));
      const leaf = [...visible].find(k => k !== focus && k !== first.cover.slice(3) && !c.nodes.some(n => n.parents.includes(k)));
      if (!leaf) continue;
      const output = node(`${leaf}-output`, [leaf], 1e6);
      const arrived = step([...c.nodes, output], focus, width, imagePx, first.out);
      if (arrived.graph.layout.nodes.has(`s0:${output.key}`)) continue; // the output is visible: not this case
      const left = step(c.nodes, focus, width, imagePx, arrived.out);
      for (const [before, after, down] of [[first, arrived, HINT], [arrived, left, -HINT]] as const) {
        expect(after.graph.attached.nodes.get(`s0:${leaf}`)!.height).toBe(before.graph.attached.nodes.get(`s0:${leaf}`)!.height + down);
        resized++;
        const where = `${c.id} w=${width} px=${imagePx} ${leaf} ${down > 0 ? "arrives" : "leaves"}`;
        if (down > 0) expectArrivalPinned(plain(before.graph.attached), plain(after.graph.attached));
        else expect(movedTiles(plain(before.graph.attached), plain(after.graph.attached)), where).toEqual([]);
        expect(overlappingColumns(plain(before.graph.attached), plain(after.graph.attached)), where).toEqual([]);
      }
    }
    expect(resized).toBeGreaterThan(40);
  });
});
