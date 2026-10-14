/**
 * The folder layout contract, run against every registered engine and the memoised default.
 * Any engine that passes may replace the default: these are the geometry guarantees the
 * renderer, motion and navigation rely on.
 */
import { describe, expect, it } from "vitest";
import { engines, memoizeEngine, type FolderLayout, type FolderLayoutEngine, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { validateLayout } from "$lib/domain/trace-graph/layout-quality";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import { cellsOf, corpusNode, folderInput, handCase, makeFolder, randomFolder, smallCorpus, type Folder, type InputOptions } from "./folder-layout-fixtures";

const EPS = 1e-6;
const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.width - EPS && b.x < a.x + a.width - EPS && a.y < b.y + b.height - EPS && b.y < a.y + a.height - EPS;
const contains = (outer: GridRect, inner: GridRect) => inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
  && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
const finiteRect = (r: GridRect) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 0 && r.height >= 0;

/** Pairs of overlapping rectangles, by a sweep over x (a 2,000-item folder stays fast). */
function overlappingPairs(rects: readonly (readonly [string, GridRect])[]): string[] {
  const sorted = [...rects].sort((a, b) => a[1].x - b[1].x), found: string[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j][1].x < sorted[i][1].x + sorted[i][1].width - EPS; j++)
    if (overlaps(sorted[i][1], sorted[j][1])) found.push(`${sorted[i][0]} × ${sorted[j][0]}`);
  return found;
}

const GATES = ["tileIntersections", "overlaps", "directionViolations", "missingEdges", "extraEdges", "missingNodes", "extraNodes", "invalidGeometry", "invalidPaths", "terminalViolations", "disconnectedEdges"] as const;

/** Every contract property of one output for its input. */
function expectContract(input: FolderLayoutInput, out: FolderLayout): void {
  expect(Number.isSafeInteger(out.columns) && out.columns >= 1).toBe(true);
  // Cells: one per input item, in input order, finite and positive.
  expect([...out.cells.keys()]).toEqual(input.items.map((item) => item.id));
  for (const [id, cell] of out.cells) { expect(cell.id).toBe(id); expect(finiteRect(cell) && cell.width > 0 && cell.height > 0).toBe(true); }
  // Bands: exactly the open stacks whose cover is drawable, in grid order, below their cover's row.
  const drawable = (id: string) => { const stack = input.open.get(id); return !!stack && stack.graph.dag.nodes.has(id) && stack.members.includes(id); };
  const expectedOpen = input.items.filter((item) => item.kind === "stack" && drawable(item.id)).map((item) => item.id);
  expect(out.bands.map((band) => band.id)).toEqual(expectedOpen);
  expect([...out.graphs.keys()]).toEqual(expectedOpen);
  const rowCells = new Map<number, GridRect[]>();
  for (const cell of out.cells.values()) rowCells.set(cell.row, [...(rowCells.get(cell.row) ?? []), cell]);
  for (const band of [...out.bands, ...out.rowBands]) {
    expect(finiteRect(band)).toBe(true);
    const row = rowCells.get(band.row)!;
    expect(row).toBeDefined();
    expect(band.y).toBeGreaterThanOrEqual(Math.max(...row.map((cell) => cell.y + cell.height)) - EPS);
    for (const cell of out.cells.values()) expect(overlaps(band, cell), `${band.id} over cell ${cell.id}`).toBe(false);
  }
  const rowsWithBands = [...new Set(out.bands.map((band) => band.row))].sort((a, b) => a - b);
  expect(out.rowBands.map((band) => band.row)).toEqual(rowsWithBands);
  // Every drawn rectangle, in folder coordinates: cells (covers included) and band tiles.
  const drawn: (readonly [string, GridRect])[] = [...out.cells].map(([id, cell]) => [`cell:${id}`, cell] as const);
  for (const [id, graph] of out.graphs) {
    const cell = out.cells.get(id)!, { attached, plan } = graph;
    expect(graph.id).toBe(id);
    expect(graph.origin).toEqual({ x: 0, y: cell.y });
    // The cover is placed exactly once: on its own cell, never again inside its band.
    const cover = attached.nodes.get(id)!;
    expect(cover.x + cover.width / 2).toBeCloseTo(cell.x + cell.width / 2, 6);
    expect(cover.y).toBeCloseTo(0, 6);
    expect(cover.height).toBe(cell.height);
    expect([...attached.nodes.values()].filter((node) => node.key === id)).toHaveLength(1);
    // Every visible node exactly once, at its planned size.
    expect(new Set(attached.nodes.keys())).toEqual(new Set(plan.tiles.keys()));
    expect(new Set(plan.request.items.map((item) => item.key))).toEqual(new Set(plan.tiles.keys()));
    for (const [key, node] of attached.nodes) {
      expect(node.key).toBe(key);
      expect(finiteRect(node)).toBe(true);
      if (key === id) continue;
      expect([node.width, node.height]).toEqual([plan.tiles.get(key)!.size.width, plan.tiles.get(key)!.size.height]);
      const rect = { x: node.x + graph.origin.x, y: node.y + graph.origin.y, width: node.width, height: node.height };
      expect(contains(out.bounds, rect)).toBe(true);
      drawn.push([`${id}/${key}`, rect]);
    }
    // Connectors start and end on their own tiles or junctions, with arrows at tiles (the layout gates).
    for (const route of attached.routes) for (const end of [route.from, route.to])
      expect(end.kind === "node" ? attached.nodes.has(end.id) : attached.junctions.has(end.id), `${route.id} ${end.kind}:${end.id}`).toBe(true);
    if (attached.decision?.fallback !== "gate-infeasible") {
      // The cover is drawn by its cell, at the cell's height, which can exceed the tile's (host metrics,
      // or a lone cover without the expand hint) and the band canvas: check the band, not the cell.
      const canvas = { ...attached, height: Math.max(attached.height, cover.y + cover.height) };
      const gates = validateLayout(canvas, id, input.width, plan.request.items.map((item) => item.key === id ? { ...item, height: cell.height } : item));
      for (const gate of GATES) expect(gates[gate], `${id} ${gate}`).toBe(0);
    }
    for (const junction of attached.junctions.values()) expect(contains(out.bounds, { x: junction.x, y: junction.y + graph.origin.y, width: 0, height: 0 })).toBe(true);
    for (const route of attached.routes) {
      const numbers = pathNumbers(route.path);
      for (let i = 0; i + 1 < numbers.length; i += 2) expect(contains(out.bounds, { x: numbers[i] - 12, y: numbers[i + 1] + graph.origin.y - 12, width: 24, height: 24 }), route.id).toBe(true);
    }
  }
  expect(overlappingPairs(drawn)).toEqual([]);
  // Bounds contain everything drawn.
  for (const rect of [...out.cells.values(), ...out.bands, ...out.rowBands]) expect(contains(out.bounds, rect)).toBe(true);
}

const snapshot = <T>(value: T): T => structuredClone(value);

const subjects: [string, () => FolderLayoutEngine][] = [
  ...Object.entries(engines).map(([name, engine]) => [name, () => engine] as [string, () => FolderLayoutEngine]),
  ["memoised default", () => memoizeEngine(engines.default)],
];

const handFolders: [string, Folder, InputOptions][] = (() => {
  const screenshot = handCase("screenshot"), merges = handCase("merges-3"), fan = handCase("fan-8"), chain = handCase("chain-20");
  const mixed = makeFolder({ stacks: [screenshot, merges, fan, chain], files: 5, directories: 2, seed: 3 });
  const covers = [...mixed.stacks.keys()];
  return [
    ["one open stack", makeFolder({ stacks: [screenshot], files: 2 }), { open: ["s0:root"] }],
    ["one open stack with a focus", makeFolder({ stacks: [screenshot], files: 2 }), { open: ["s0:root"], focus: "s0:Saffron" }],
    ["four stacks in one row, all open", makeFolder({ stacks: [screenshot, merges, fan, chain] }), { open: ["s0:root", "s1:root", "s2:root", "s3:root"], focus: "s3:n10", width: 1400 }],
    ["mixed listing, wrapped rows", mixed, { open: covers, focus: "s1:ab", width: 454 }],
    ["mixed listing, host metrics", mixed, { open: covers.slice(1), width: 640, tile: tileMetrics(64), grid: { cellWidth: 110, cellHeight: 150, gap: 12 } }],
    ["unsaved stack after the listing", makeFolder({ stacks: [screenshot, fan], files: 3, unsaved: [1] }), { open: ["s0:root", "s1:root"] }],
    ["narrow pane, one column", makeFolder({ stacks: [screenshot, merges], files: 2 }), { open: ["s0:root", "s1:root"], width: 120 }],
    ["foreign and placeholder nodes", makeFolder({ stacks: [handCase("foreign-and-placeholder"), handCase("malformed-cycle")] }), { open: ["s0:root", "s1:root"], focus: "s0:edited" }],
  ];
})();

describe.each(subjects)("folder layout contract: %s", (_, make) => {
  describe("hand folders", () => {
    it.each(handFolders)("%s", (_, folder, options) => {
      const engine = make(), input = folderInput(folder, options), before = snapshot(input);
      const out = engine(input);
      expectContract(input, out);
      expect(input).toEqual(before);
    });
  });

  it("holds on seeded random folders built from the layout-eval corpus", () => {
    const engine = make();
    for (let seed = 1; seed <= 24; seed++) {
      const { folder, options } = randomFolder(seed);
      const input = folderInput(folder, options);
      expectContract(input, engine(input));
    }
  });

  it("holds for every small corpus case as an open stack beside others", () => {
    const engine = make(), pool = smallCorpus();
    for (let i = 0; i < pool.length; i += 3) {
      const folder = makeFolder({ stacks: pool.slice(i, i + 3), files: 1, seed: i });
      const input = folderInput(folder, { open: [...folder.stacks.keys()], width: 900 });
      expectContract(input, engine(input));
    }
  });

  it("holds across a click tour that feeds each output back as the previous layout", () => {
    const engine = make(), folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3"), handCase("mixed-depth")], files: 2 });
    let previous: FolderLayout | null = null;
    for (const focus of [null, "s0:Saffron", "s0:Ash", "s1:ab", "s2:long7", "s0:Cerulean", null]) {
      const input = folderInput(folder, { open: [...folder.stacks.keys()], focus, width: 640, previous });
      const before = snapshot(input);
      const out = engine(input);
      expectContract(input, out);
      expect(input).toEqual(before);
      previous = out;
    }
  });

  it("is deterministic, cache-agnostic and survives structured cloning", () => {
    const { folder, options } = randomFolder(7);
    const input = folderInput(folder, options);
    const first = make()(input), second = make()(snapshot(input));
    expect(second).toEqual(first);
    expect(make()(input)).toEqual(first);
    expect(structuredClone(first)).toEqual(first);
    // Fed back as the previous layout (as a worker would receive it, cloned).
    const next = folderInput(folder, { ...options, previous: structuredClone(first) });
    expect(make()(next)).toEqual(make()(folderInput(folder, { ...options, previous: first })));
  });

  describe("edge cases", () => {
    it("lays out an empty folder", () => {
      const out = make()(folderInput(makeFolder({ stacks: [] }), { width: 640 }));
      expect(out.cells.size).toBe(0);
      expect([out.bands, out.rowBands, [...out.graphs]]).toEqual([[], [], []]);
      expect(out.bounds.height).toBe(0);
      expect(Number.isFinite(out.bounds.width)).toBe(true);
    });
    it("lays out a folder of only files and folders", () => {
      const folder = makeFolder({ stacks: [], files: 7, directories: 2, seed: 1 }), input = folderInput(folder, { width: 454 });
      const out = make()(input);
      expectContract(input, out);
      expect(out.bands).toEqual([]);
    });
    it("ignores open ids that are not stacks, and stacks whose cover is not drawable", () => {
      const folder = makeFolder({ stacks: [handCase("screenshot")], files: 2 });
      const input = folderInput(folder, { open: ["s0:root"] });
      const file = cellsOf(folder).find((cell) => cell.kind === "file")!.id, stack = input.open.get("s0:root")!;
      const strange = { ...input, open: new Map([...input.open, [file, { ...stack, id: file }], ["nowhere", { ...stack, id: "nowhere" }]]) };
      expect(make()(strange)).toEqual(make()(input));
      const coverless = { ...input, open: new Map([["s0:root", { ...stack, members: stack.members.filter((key) => key !== "s0:root") }]]) };
      const out = make()(coverless);
      expectContract(coverless, out);
      expect(out.bands).toEqual([]);
    });
    it("drops member keys missing from the graph and repeated keys", () => {
      const folder = makeFolder({ stacks: [handCase("screenshot")] }), input = folderInput(folder, { open: ["s0:root"] });
      const stack = input.open.get("s0:root")!;
      const noisy = { ...input, open: new Map([["s0:root", { ...stack, members: [...stack.members, "ghost", stack.members[1]] }]]) };
      expect(make()(noisy)).toEqual(make()(input));
    });
    it("lays out a stack of one node", () => {
      const folder = makeFolder({ stacks: [[corpusNode("root")], handCase("fan-8")], files: 1 });
      const input = folderInput(folder, { open: [...folder.stacks.keys()] });
      const out = make()(input);
      expectContract(input, out);
      expect(out.graphs.get("s0:root")!.attached.nodes.size).toBe(1);
    });
    it("lays out a 2,000-item folder", () => {
      const pool = smallCorpus();
      const folder = makeFolder({ stacks: Array.from({ length: 60 }, (_, i) => pool[i % pool.length]), files: 1900, directories: 40, seed: 11 });
      const ids = [...folder.stacks.keys()];
      const input = folderInput(folder, { open: ids.filter((_, i) => i % 6 === 0), focus: ids[6], width: 1400 });
      expect(input.items.length).toBe(2000);
      const out = make()(input);
      expectContract(input, out);
    });
    it("rejects non-finite or non-positive metrics with RangeError, and clamps a negative width to one column", () => {
      const folder = makeFolder({ stacks: [handCase("screenshot")], files: 3 }), engine = make();
      const input = folderInput(folder, { open: ["s0:root"] });
      for (const bad of [{ width: NaN }, { width: Infinity }, { tile: { width: 0, image: 64 } }, { tile: { width: NaN, image: 64 } }, { tile: { width: 92, image: -1 } },
        { grid: { cellWidth: Infinity, cellHeight: 0, gap: 8 } }, { grid: { cellWidth: 92, cellHeight: NaN, gap: 8 } }, { grid: { cellWidth: 92, cellHeight: 0, gap: -8 } }])
        expect(() => engine({ ...input, ...bad })).toThrow(RangeError);
      // Zero host cell metrics fall back to the tile, as the grid always has.
      const zero = { ...input, grid: { cellWidth: 0, cellHeight: 0, gap: 0 } };
      expectContract(zero, engine(zero));
      const negative = { ...input, width: -50 }, out = engine(negative);
      expectContract(negative, out);
      expect(out.columns).toBe(1);
      expect(out).toEqual(engine({ ...input, width: 0 }));
    });
    it("rejects duplicate item ids with RangeError", () => {
      const folder = makeFolder({ stacks: [], files: 3 }), input = folderInput(folder);
      expect(() => make()({ ...input, items: [...input.items, input.items[0]] })).toThrow(RangeError);
    });
    it("treats a malformed previous layout as none", () => {
      const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 2 });
      const options = { open: [...folder.stacks.keys()], focus: "s0:Saffron" };
      const clean = make()(folderInput(folder, { ...options }));
      const real = make()(folderInput(folder, { open: [...folder.stacks.keys()] }));
      const broken: unknown[] = [
        { graphs: "nope" },
        { graphs: new Map([["s0:root", null], ["s1:root", { plan: 1, layout: { nodes: [] } }]]), cells: new Map(), bands: [] },
        { ...real, graphs: new Map([...real.graphs].map(([id, graph]) => [id, { ...graph, layout: { ...graph.layout, nodes: "x", readingOrder: "x" } }])) },
        { ...real, graphs: new Map([...real.graphs].map(([id, graph]) => [id, { ...graph, attached: null, layout: { ...graph.layout, readingOrder: new Map([["s0:root", "first"]]) } }])) },
      ];
      for (const previous of broken) {
        const input = folderInput(folder, { ...options, previous: previous as FolderLayout });
        const out = make()(input);
        expectContract(input, out);
        expect(out).toEqual(clean);
      }
      // Without its cells and bands no history can be attached; the reading order still serves as a hint.
      const partial = folderInput(folder, { ...options, previous: { ...real, cells: new Map(), bands: [] } });
      expectContract(partial, make()(partial));
    });
    it("stays valid with a previous layout from another width and tile size", () => {
      const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3"), handCase("fan-8")], files: 4, seed: 2 });
      const previous = make()(folderInput(folder, { open: [...folder.stacks.keys()], focus: "s0:Saffron", width: 1400, tile: tileMetrics(128) }));
      for (const width of [360, 640]) {
        const input = folderInput(folder, { open: [...folder.stacks.keys()], focus: "s0:Ash", width, tile: tileMetrics(64), previous });
        const out = make()(input);
        expectContract(input, out);
        expect(make()(input)).toEqual(out);
      }
    });
  });
});
