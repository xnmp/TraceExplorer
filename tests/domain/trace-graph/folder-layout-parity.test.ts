/**
 * The default engine is a faithful extraction of the view's pipeline. The expected geometry is
 * computed the way StackGrid and TraceGraph computed it, calling the same domain functions in the
 * same order with the components' own formulas; the engine must produce exactly the same cells,
 * bands, tile rectangles and connector paths, display after display.
 *
 * The engine adds one rule the old pipeline did not have: a band whose request is unchanged apart
 * from the committed history and reading-order hint keeps its committed layout. The reference
 * pipeline below does not model it, so parity is checked where the rule cannot apply (every display
 * laid out afresh, and tours where every band's own request changes each display), and the rule is
 * tested by itself against the engine's own output.
 */
import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { attachPackedBand, bandExtent, bandPlacements, estimatedBandExtent, packedGridFlow, type BandPlacement } from "$lib/domain/trace-graph/band-geometry";
import { bandHistorySignature } from "$lib/domain/trace-graph/band-layout";
import { folderCells, gridPins } from "$lib/domain/trace-graph/folder-grid";
import { layoutGraph, type BandHistory, type GraphLayout, type PinnedCover } from "$lib/domain/trace-graph/layout";
import { layoutSignature } from "$lib/domain/trace-graph/layout-signature";
import { tileMetrics, tileSize, type TileMetrics } from "$lib/domain/trace-graph/metrics";
import { connectedComponents, projectDag, projectReferenceBadges } from "$lib/domain/trace-graph/projection";
import { planBandScene, type BandScenePlan, type ComponentFocus } from "$lib/domain/trace-graph/scene";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { belongs, handCase, makeFolder, type Folder } from "./folder-layout-fixtures";
import { mockupNodes } from "./fixtures";

interface HostMetrics { readonly cellWidth: number; readonly cellHeight: number; readonly gap: number; readonly gridPadding: number }
interface Display { readonly paneWidth: number; readonly tile: TileMetrics; readonly host: HostMetrics | null; readonly open: readonly string[]; readonly focus: string | null }
/** What one mounted TraceGraph remembers between commits: its last committed plan, layout and attachment. */
interface Mounted { readonly plan: BandScenePlan; readonly layout: GraphLayout; readonly attached: GraphLayout; readonly bandTop: number; readonly placement: BandPlacement }

/** StackGrid + TraceGraph for one settled display, given what each mounted graph committed before. */
function viewPipeline(folder: Folder, display: Display, mounted: ReadonlyMap<string, Mounted>) {
  const { tile, host, paneWidth } = display;
  // StackGrid: metrics, inner width, columns and cell size.
  const metrics = host ?? { cellWidth: tile.width, cellHeight: tileSize({ foreign: false, hint: true }, tile).height, gap: 8, gridPadding: 0 };
  const innerWidth = Math.max(0, paneWidth - 2 * metrics.gridPadding);
  const columns = Math.max(1, Math.floor((innerWidth + metrics.gap) / (Math.max(metrics.cellWidth, tile.width) + metrics.gap)));
  const cellWidth = Math.max(tile.width, (innerWidth - (columns - 1) * metrics.gap) / columns);
  const cellHeight = Math.max(metrics.cellHeight, tileSize({ foreign: false, hint: true }, tile).height);
  const gridMetrics = { cellWidth, cellHeight, columnGap: metrics.gap, rowGap: metrics.gap };
  const cells = folderCells(folder.entries, folder.index, new Set(), new Set());
  const openKeys = new Set(display.open);
  const openCells = cells.filter((cell) => cell.kind === "stack" && openKeys.has(cell.id));
  // The first flow, before any graph has published its geometry, gives the pins.
  const reserved = packedGridFlow(cells, new Map(openCells.map((cell) => [cell.id, estimatedBandExtent(tile)])), columns, gridMetrics);
  const pins: ReadonlyMap<string, PinnedCover> = gridPins(reserved, openKeys);
  const focus: ComponentFocus | null = display.focus ? { key: display.focus, componentId: "irrelevant" } : null;
  // TraceGraph: plan with the committed history and reading order, then lay out.
  const covers = new Map<string, { plan: BandScenePlan; layout: GraphLayout }>();
  /** Bands whose own request is unchanged apart from history and hint: where the engine's reuse rule applies. */
  const unchanged: string[] = [];
  for (const cell of openCells) {
    const projection = projectReferenceBadges(projectDag(folder.stacks.get(cell.id)!.nodes));
    const known = mounted.get(cell.id);
    const history: BandHistory | undefined = known && { signature: bandHistorySignature(known.plan.request), layout: known.layout, placed: known.attached, attachment: { bandTop: known.bandTop, placement: known.placement } };
    const plan = planBandScene(projection, projection.dag.order, focus?.key ?? null, innerWidth, { pinned: pins.get(cell.id)!, history, hint: known?.layout.readingOrder, tile, badgeHighlight: null });
    if (known && requestBasis(known.plan.request) === requestBasis(plan.request)) unchanged.push(cell.id);
    covers.set(cell.id, { plan, layout: layoutGraph(plan.request) });
  }
  // StackGrid again: the exact extents replace the reservations; TraceGraph attaches.
  const flow = packedGridFlow(cells, new Map(openCells.map((cell) => [cell.id, bandExtent(covers.get(cell.id)!.layout, cell.id)])), columns, gridMetrics);
  const placements = bandPlacements(flow, cellHeight);
  const committed = new Map<string, Mounted>();
  for (const band of flow.bands) {
    const rect = flow.cells.get(band.id)!, { plan, layout } = covers.get(band.id)!;
    const bandTop = band.y - rect.y, placement = placements.get(band.id)!;
    committed.set(band.id, { plan, layout, attached: attachPackedBand(layout, band.id, bandTop, placement), bandTop, placement });
  }
  return { columns, flow, committed, unchanged, innerWidth, grid: { cellWidth: metrics.cellWidth, cellHeight: metrics.cellHeight, gap: metrics.gap } };
}

const requestBasis = (request: BandScenePlan["request"]) => layoutSignature({ ...request, history: undefined, hint: undefined });

function engineDisplay(folder: Folder, display: Display, previous: FolderLayout | null, innerWidth: number, grid: { cellWidth: number; cellHeight: number; gap: number }): FolderLayout {
  const open = new Map(display.open.flatMap((id) => {
    const stack = folder.stacks.get(id);
    return stack ? [[id, { id, graph: stack.graph, members: stack.graph.dag.order, focus: belongs(stack, display.focus) ? display.focus : null }] as const] : [];
  }));
  return engines.default({ items: folderCells(folder.entries, folder.index), open, width: innerWidth, tile: display.tile, grid, previous });
}

/**
 * Runs a sequence of displays through both pipelines and compares every one. `fresh` lays every
 * display out with no history; otherwise each display carries the previous one's, and the tour must
 * change every band's own request each display (the reuse rule is outside the reference pipeline).
 */
function expectParity(folder: Folder, displays: readonly Display[], mode: "fresh" | "history"): number {
  let mounted: ReadonlyMap<string, Mounted> = new Map(), previous: FolderLayout | null = null, compared = 0;
  for (const display of displays) {
    const view = viewPipeline(folder, display, mode === "fresh" ? new Map() : mounted);
    expect(view.unchanged, "a history tour must change every band's own request").toEqual([]);
    const out = engineDisplay(folder, display, mode === "fresh" ? null : previous, view.innerWidth, view.grid);
    expect(out.columns).toBe(view.columns);
    expect(out.cells).toEqual(view.flow.cells);
    expect(out.bands).toEqual(view.flow.bands);
    expect(out.rowBands).toEqual(view.flow.rowBands);
    expect([...out.graphs.keys()]).toEqual([...view.committed.keys()]);
    for (const [id, expected] of view.committed) {
      const graph = out.graphs.get(id)!;
      expect(graph.layout).toEqual(expected.layout);
      expect(graph.placement).toEqual(expected.placement);
      expect(graph.attached).toEqual(expected.attached);
      expect(graph.plan.request).toEqual(expected.plan.request);
      // The drawn geometry, spelled out: tile rectangles and connector paths.
      expect([...graph.attached.nodes].map(([key, node]) => [key, node.x, node.y + graph.origin.y, node.width, node.height]))
        .toEqual([...expected.attached.nodes].map(([key, node]) => [key, node.x, node.y + view.flow.cells.get(id)!.y, node.width, node.height]));
      expect(graph.attached.routes.map((route) => route.path)).toEqual(expected.attached.routes.map((route) => route.path));
      compared++;
    }
    mounted = view.committed;
    previous = out;
  }
  return compared;
}

const splitComponents = (nodes: readonly TraceNode[]): TraceNode[][] => {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return connectedComponents(projectDag(nodes)).map((keys) => keys.map((key) => byKey.get(key)!));
};

describe("default engine parity with the view pipeline", () => {
  const screenshot = handCase("screenshot"), merges = handCase("merges-3"), fan = handCase("fan-8"), mixedDepth = handCase("mixed-depth");
  const fallback = (imagePx = 96): Pick<Display, "tile" | "host"> => ({ tile: tileMetrics(imagePx), host: null });
  const hosted = (imagePx: number): Pick<Display, "tile" | "host"> => ({ tile: tileMetrics(imagePx), host: { cellWidth: imagePx + 24, cellHeight: imagePx + 52, gap: 12, gridPadding: 10 } });
  const mockup = () => makeFolder({ stacks: splitComponents(mockupNodes()), files: 3, directories: 1, seed: 5 });
  const mixed = () => makeFolder({ stacks: [screenshot, merges, fan, mixedDepth, handCase("chain-20")], files: 6, directories: 2, seed: 9 });
  const nameKey = (folder: Folder, name: string) => [...folder.stacks.values()].flatMap((s) => s.graph.dag.order).find((k) => k.endsWith(`:${name}`))!;

  it("matches on the mockup folder across a click tour, with and without host metrics", () => {
    const folder = mockup(), ids = [...folder.stacks.keys()], key = (name: string) => nameKey(folder, name);
    for (const metrics of [fallback(), hosted(64)]) for (const paneWidth of [454, 900, 1400]) {
      const tour = [null, key("daylight"), key("warm"), key("forest-mist"), key("d"), key("evening"), null]
        .map((focus) => ({ paneWidth, ...metrics, open: ids, focus }));
      expect(expectParity(folder, tour, "fresh")).toBeGreaterThan(0);
    }
  });

  it("matches on mixed listings with wrapped rows and several bands per row", () => {
    const folder = mixed(), ids = [...folder.stacks.keys()];
    for (const metrics of [fallback(48), fallback(128), hosted(96)]) for (const paneWidth of [360, 640, 1400]) {
      const tour = [null, "s0:Saffron", "s0:Ash", "s1:ab", "s3:long7", "s4:n10", "s0:Cerulean"].map((focus) => ({ paneWidth, ...metrics, open: ids, focus }));
      expect(expectParity(folder, tour, "fresh")).toBeGreaterThan(0);
    }
  });

  it("matches with committed history when every band's request changes between displays", () => {
    const folder = mockup(), ids = [...folder.stacks.keys()], key = (name: string) => nameKey(folder, name);
    for (const metrics of [fallback(), hosted(64)]) {
      const tour = ([[454, null], [900, key("daylight")], [1400, key("warm")], [640, key("forest-mist")], [1100, key("evening")], [500, null]] as const)
        .map(([paneWidth, focus]) => ({ paneWidth, ...metrics, open: ids, focus }));
      expect(expectParity(folder, tour, "history")).toBeGreaterThan(0);
    }
    const wrapped = mixed(), all = [...wrapped.stacks.keys()];
    const tour = ([[360, null], [640, "s0:Saffron"], [1400, "s1:ab"], [800, "s3:long7"], [1000, "s4:n10"]] as const)
      .map(([paneWidth, focus]) => ({ paneWidth, ...fallback(96), open: all, focus }));
    expect(expectParity(wrapped, tour, "history")).toBeGreaterThan(0);
  });

  it("matches when stacks open and close between clicks", () => {
    const folder = makeFolder({ stacks: [screenshot, merges, fan], files: 2 });
    const displays: Display[] = [
      { paneWidth: 900, ...fallback(), open: ["s0:root"], focus: null },
      { paneWidth: 900, ...fallback(), open: ["s0:root"], focus: "s0:Saffron" },
      { paneWidth: 900, ...fallback(), open: ["s0:root", "s1:root"], focus: "s1:a" },
      { paneWidth: 900, ...fallback(), open: ["s1:root", "s2:root"], focus: "s2:f3" },
      { paneWidth: 640, ...fallback(), open: ["s1:root", "s2:root"], focus: "s1:abc" },
    ];
    expect(expectParity(folder, displays, "fresh")).toBeGreaterThan(0);
  });
});

describe("default engine: a band with an unchanged request keeps its committed layout", () => {
  it("over a click tour, keeps exactly the bands whose own request is unchanged and attaches them where they are now drawn", () => {
    const folder = makeFolder({ stacks: splitComponents(mockupNodes()), files: 3, directories: 1, seed: 5 });
    const ids = [...folder.stacks.keys()], key = (name: string) => [...folder.stacks.values()].flatMap((s) => s.graph.dag.order).find((k) => k.endsWith(`:${name}`))!;
    const tour = [null, key("daylight"), key("warm"), key("forest-mist"), key("d"), key("evening"), null];
    const view = viewPipeline(folder, { paneWidth: 900, tile: tileMetrics(96), host: null, open: ids, focus: null }, new Map());
    let previous: FolderLayout | null = null, kept = 0, relaid = 0;
    for (const focus of tour) {
      const out = engineDisplay(folder, { paneWidth: 900, tile: tileMetrics(96), host: null, open: ids, focus }, previous, view.innerWidth, view.grid);
      for (const [id, graph] of out.graphs) {
        const before = previous?.graphs.get(id);
        const same = !!before && requestBasis(before.plan.request) === requestBasis(graph.plan.request);
        if (same) { expect(graph.layout, `${id} keeps its layout`).toBe(before!.layout); kept++; }
        else { expect(graph.layout).toEqual(layoutGraph(graph.plan.request)); relaid++; }
        // Kept or not, a band is attached at its current place in the grid.
        const cell = out.cells.get(id)!, band = out.bands.find((candidate) => candidate.id === id)!;
        expect(graph.attached).toEqual(attachPackedBand(graph.layout, id, band.y - cell.y, graph.placement));
      }
      previous = out;
    }
    expect(kept).toBeGreaterThan(0);
    expect(relaid).toBeGreaterThan(0);
  });
});
