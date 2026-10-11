import { describe, expect, it } from "vitest";
import { gridFlow, mapGridItemRects, type GridFlow, type GridItem, type GridMetrics, type GridRect } from "$lib/domain/trace-graph/grid-flow";
import { random } from "./fixtures";

const metrics: GridMetrics = { cellWidth: 92, cellHeight: 100, columnGap: 16, rowGap: 12 };
const items: GridItem[] = [
  { id: "folder", kind: "folder" }, { id: "a", kind: "stack" }, { id: "file", kind: "file" },
  { id: "b", kind: "stack" }, { id: "c", kind: "stack" }, { id: "last", kind: "folder" },
];
const overlap = (a: GridRect, b: GridRect) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
  && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function overlapPairs(flow: GridFlow): string[] {
  const rects = [...flow.cells.values(), ...flow.bands];
  const pairs: string[] = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    if (overlap(rects[i], rects[j])) pairs.push(`${rects[i].id}/${rects[j].id}`);
  }
  return pairs;
}

describe("grid flow", () => {
  it("places ordered entries once and inserts full-width bands after their row, in grid order", () => {
    const flow = gridFlow(items, new Map([["c", 80], ["b", 50], ["a", 40]]), 4, metrics);
    expect([...flow.cells.keys()]).toEqual(items.map((item) => item.id));
    expect(flow.cells.get("b")).toEqual({ id: "b", row: 0, col: 3, x: 324, y: 0, width: 92, height: 100 });
    expect(flow.bands).toEqual([
      { id: "a", row: 0, x: 0, y: 100, width: 416, height: 40 },
      { id: "b", row: 0, x: 0, y: 140, width: 416, height: 50 },
      { id: "c", row: 1, x: 0, y: 302, width: 416, height: 80 },
    ]);
    expect(flow.cells.get("c")?.y).toBe(202);
    expect(flow).toMatchObject({ width: 416, height: 382, rowCount: 2 });
    expect(overlapPairs(flow)).toEqual([]);
  });

  it("does not reorder folders or allow ordinary entries to open bands", () => {
    const closed = gridFlow(items, new Map(), 3, metrics);
    const opened = gridFlow(items, new Map([["folder", 100], ["file", 100], ["absent", NaN]]), 3, metrics);
    expect(opened).toEqual(closed);
    expect(opened.cells.get("folder")).toMatchObject({ row: 0, col: 0, x: 0, y: 0 });
    expect(opened.cells.get("last")).toMatchObject({ row: 1, col: 2 });
  });

  it("handles empty input, one column, a partial final row and zero-height bands", () => {
    expect(gridFlow([], new Map([["a", 200]]), 1, metrics)).toEqual({ width: 92, height: 0, rowCount: 0, cells: new Map(), bands: [] });
    const flow = gridFlow(items.slice(0, 3), new Map([["a", 0]]), 1, metrics);
    expect([...flow.cells.values()].map(({ col, x, y }) => ({ col, x, y }))).toEqual([
      { col: 0, x: 0, y: 0 }, { col: 0, x: 0, y: 112 }, { col: 0, x: 0, y: 224 },
    ]);
    expect(flow.bands[0]).toMatchObject({ y: 212, height: 0 });
    expect(flow.height).toBe(324);
    expect(gridFlow(items.slice(0, 1), new Map(), 5, metrics).height).toBe(100);
  });

  it("rejects malformed metrics, columns, duplicate identities and active heights", () => {
    for (const columns of [0, -1, 1.5, NaN, Infinity, Number.MAX_VALUE]) {
      expect(() => gridFlow(items, new Map(), columns, metrics)).toThrow(RangeError);
    }
    for (const name of Object.keys(metrics) as (keyof GridMetrics)[]) for (const value of [-1, NaN, Infinity]) {
      expect(() => gridFlow(items, new Map(), 3, { ...metrics, [name]: value })).toThrow(RangeError);
    }
    expect(() => gridFlow(items, new Map(), 3, { ...metrics, cellWidth: 0 })).toThrow(RangeError);
    expect(() => gridFlow(items, new Map(), 3, { ...metrics, cellHeight: 0 })).toThrow(RangeError);
    for (const height of [-1, NaN, Infinity]) expect(() => gridFlow(items, new Map([["a", height]]), 3, metrics)).toThrow(RangeError);
    expect(() => gridFlow([items[0], items[0]], new Map(), 3, metrics)).toThrow(RangeError);
    expect(() => gridFlow(items, new Map(), 3, { ...metrics, cellWidth: Number.MAX_VALUE })).toThrow(RangeError);
    expect(() => gridFlow(items, new Map([["a", Number.MAX_VALUE], ["b", Number.MAX_VALUE]]), 3, metrics)).toThrow(RangeError);
    const huge = gridFlow([items[0]], new Map(), 1, { ...metrics, cellWidth: Number.MAX_VALUE, columnGap: Number.MAX_VALUE });
    expect(huge.cells.get("folder")?.x).toBe(0);
  });

  it("matches motion rectangles by stable identity across reorder, arrival, departure and band resizing", () => {
    const before = gridFlow(items, new Map([["a", 50]]), 3, metrics);
    const after = gridFlow([items[0], items[2], items[1], items[4], { id: "new", kind: "file" }], new Map([["a", 80]]), 3, metrics);
    const changes = mapGridItemRects(before, after);
    expect(changes.get("a")).toEqual({ id: "a", before: { x: 108, y: 0, width: 92, height: 100 }, after: { x: 216, y: 0, width: 92, height: 100 } });
    expect(changes.get("c")?.before?.y).toBe(162);
    expect(changes.get("c")?.after?.y).toBe(192);
    expect(changes.get("b")?.after).toBeNull();
    expect(changes.get("new")?.before).toBeNull();
    expect(changes.size).toBe(7);
    expect(mapGridItemRects(gridFlow([], new Map(), 1, metrics), gridFlow([], new Map(), 1, metrics)).size).toBe(0);
  });

  it("fuzzes placement and vertical-only open/close/resize changes over 500 grids", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = random(seed);
      const columns = 1 + Math.floor(next() * 12);
      const entries: GridItem[] = Array.from({ length: 1 + Math.floor(next() * 90) }, (_, i) => ({ id: `e${i}`, kind: i === 0 || next() < 0.4 ? "stack" : next() < 0.3 ? "folder" : "file" }));
      const sizes = { cellWidth: 10 + next() * 200, cellHeight: 10 + next() * 160, columnGap: next() * 30, rowGap: next() * 30 };
      const open = new Map(entries.filter((entry) => entry.kind === "stack" && next() < 0.5).map((entry) => [entry.id, next() * 500]));
      const base = gridFlow(entries, open, columns, sizes);
      expect(overlapPairs(base), `seed ${seed}`).toEqual([]);
      expect([...base.cells.keys()]).toEqual(entries.map((entry) => entry.id));
      // Exercise one stack through opening, resizing and closing, regardless of its starting state.
      const stacks = entries.filter((entry) => entry.kind === "stack");
      const stack = stacks[Math.floor(next() * stacks.length)];
      const row = base.cells.get(stack.id)!.row;
      for (const height of [next() * 500, next() * 500, null]) {
        const changed = new Map(open);
        if (height === null) changed.delete(stack.id); else changed.set(stack.id, height);
        const flow = gridFlow(entries, changed, columns, sizes);
        const delta = (height ?? 0) - (open.get(stack.id) ?? 0);
        expect(overlapPairs(flow), `seed ${seed}`).toEqual([]);
        const wrongMoves = [...flow.cells].filter(([id, cell]) => {
          const old = base.cells.get(id)!;
          return cell.row !== old.row || cell.col !== old.col || cell.x !== old.x
            || Math.abs(cell.y - old.y - (old.row > row ? delta : 0)) > 1e-8;
        }).map(([id]) => id);
        expect(wrongMoves, `seed ${seed}: vertical-only movement`).toEqual([]);
      }
      // A freshly supplied order, rather than map insertion order, owns band placement.
      expect(gridFlow(entries, new Map([...open].reverse()), columns, sizes)).toEqual(base);
    }
  }, 30_000);

  it("lays out 2,000 entries under 5 ms (median of warmed runs)", () => {
    const entries: GridItem[] = Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, kind: i % 3 ? "file" : "stack" }));
    const open = new Map(entries.filter((entry) => entry.kind === "stack").map((entry) => [entry.id, 250]));
    for (let i = 0; i < 10; i++) gridFlow(entries, open, 7, metrics);
    const times = Array.from({ length: 21 }, () => {
      const start = performance.now();
      const flow = gridFlow(entries, open, 7, metrics);
      const time = performance.now() - start;
      expect(flow.cells.size).toBe(2000);
      expect(flow.bands.length).toBe(667);
      return time;
    }).sort((a, b) => a - b);
    console.info(`grid-flow: 2,000 entries median ${times[10].toFixed(3)} ms`);
    expect(times[10]).toBeLessThan(5);
  });
});
