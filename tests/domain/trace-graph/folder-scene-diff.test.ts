import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, entityId, type FolderScene, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { folderGridGeometry } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { cellsOf, folderInput, handCase, makeFolder, sourcesOf, type Folder } from "./folder-layout-fixtures";

const scope: SceneScope = { paneId: "p1", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 }, width = 640;
const columns = folderGridGeometry(width, tile, grid).columns;

/** Stack A first in row 0, stack B first in row 1, files filling rows 0-3. */
const folder: Folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 4 * columns });
const items = (() => {
  const cells = cellsOf(folder), files = cells.filter((cell) => cell.kind === "file"), [a, b] = ["s0:root", "s1:root"].map((id) => cells.find((cell) => cell.id === id)!);
  return [a, ...files.slice(0, columns - 1), b, ...files.slice(columns - 1, 3 * columns - 2)];
})();
const rowOf = (row: number) => items.slice(row * columns, (row + 1) * columns);

function sceneFor(open: string[], focus: string | null, previous: FolderLayout | null = null, styling: Partial<SceneStyling> = {}, at: SceneScope = scope): FolderScene {
  const input = folderInput(folder, { open, focus, width, tile, grid, items, previous });
  return buildFolderScene({ scope: at, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: { ...plain, focus, ...styling } });
}
const cellRecord = (id: string) => id.startsWith("/") ? entityId("entry", null, id) : entityId("tile", id, id);
const policyOf = (diff: ReturnType<typeof diffScenes>, id: string) => diff.policy.records.get(id);

describe("diffScenes", () => {
  it("resets on the first publication: everything enters and snaps", () => {
    const next = sceneFor(["s0:root"], null), diff = diffScenes(null, next);
    expect(diff.policy.reset).toBe(true);
    expect([...diff.enter.keys()]).toEqual([...next.records.keys()]);
    expect([diff.update.size, diff.exit.size]).toEqual([0, 0]);
    expect(new Set(diff.policy.records.values())).toEqual(new Set(["snap"]));
  });

  it("resets on a scope change, snapping departures too", () => {
    const before = sceneFor(["s0:root"], null), after = sceneFor([], null, null, {}, { ...scope, generation: 2 });
    const diff = diffScenes(before, after);
    expect(diff.policy.reset).toBe(true);
    expect(diff.exit.size).toBeGreaterThan(0);
    for (const id of diff.exit.keys()) expect(policyOf(diff, id)).toBe("snap");
    expect(diffScenes(before, sceneFor(["s0:root"], null, null, {}, { ...scope, directory: "/g" })).policy.reset).toBe(true);
  });

  it("carries everything between identical scenes", () => {
    const a = sceneFor(["s0:root", "s1:root"], "s0:Saffron"), b = sceneFor(["s0:root", "s1:root"], "s0:Saffron");
    const diff = diffScenes(a, b);
    expect([diff.enter.size, diff.update.size, diff.exit.size, diff.policy.reset]).toEqual([0, 0, 0, false]);
    expect(new Set(diff.policy.records.values())).toEqual(new Set(["carry"]));
    expect([...diff.policy.graphs.values()]).toEqual(["restyle", "restyle"]);
  });

  it("restyles selection and hover as payload updates that carry", () => {
    const a = sceneFor(["s0:root"], null), b = sceneFor(["s0:root"], null, null, { selectedKeys: new Set(["s0:Saffron"]), selectedPaths: new Set([items[1].id]) });
    const diff = diffScenes(a, b);
    expect([...diff.update.keys()].sort()).toEqual([entityId("tile", "s0:root", "s0:Saffron"), entityId("entry", null, items[1].id)].sort());
    expect([diff.enter.size, diff.exit.size]).toEqual([0, 0]);
    expect(new Set(diff.policy.records.values())).toEqual(new Set(["carry"]));
  });

  it("snaps a reveal and everything it alone displaces", () => {
    const before = sceneFor(["s0:root"], null), after = sceneFor(["s0:root"], "s0:Saffron", before.layout);
    const diff = diffScenes(before, after);
    expect(diff.policy.graphs.get("s0:root")).toBe("reveal");
    expect(diff.enter.size).toBeGreaterThan(0);
    for (const [id, record] of diff.enter) { expect(record.graphId).toBe("s0:root"); expect(policyOf(diff, id)).toBe("snap"); }
    // Rows below the band moved, and snap with it.
    const below = rowOf(1).map((cell) => cellRecord(cell.id));
    for (const id of below) { expect(diff.update.has(id)).toBe(true); expect(policyOf(diff, id)).toBe("snap"); }
    expect(new Set(diff.policy.records.values())).not.toContain("animate");
  });

  it("animates a reflow: an opened band and what it displaces", () => {
    const before = sceneFor(["s0:root"], null), after = sceneFor(["s0:root", "s1:root"], null, before.layout);
    const diff = diffScenes(before, after);
    expect(diff.policy.graphs.get("s1:root")).toBe("reflow");
    for (const [id, record] of diff.enter) { expect(record.graphId === "s1:root" || record.kind === "row").toBe(true); expect(policyOf(diff, id)).toBe("animate"); }
    for (const cell of rowOf(2)) expect(policyOf(diff, cellRecord(cell.id))).toBe("animate");
    // The cover stays in its cell (carry) but now reports itself expanded.
    expect(policyOf(diff, entityId("tile", "s1:root", "s1:root"))).toBe("carry");
    expect(diff.update.get(entityId("tile", "s1:root", "s1:root"))?.after).toMatchObject({ cover: { expanded: true } });
    // Closing it again: its records leave, animated; the graph reflows.
    const closed = diffScenes(after, sceneFor(["s0:root"], null, after.layout));
    expect(closed.policy.graphs.get("s1:root")).toBe("reflow");
    expect(closed.exit.size).toBe(diff.enter.size);
    for (const id of closed.exit.keys()) expect(policyOf(closed, id)).toBe("animate");
  });

  it("separates a reveal from a coalesced reflow: only what the reveal alone moved snaps", () => {
    const before = sceneFor(["s0:root"], null), after = sceneFor(["s0:root", "s1:root"], "s0:Saffron", before.layout);
    const diff = diffScenes(before, after);
    expect(diff.policy.graphs.get("s0:root")).toBe("reveal");
    expect(diff.policy.graphs.get("s1:root")).toBe("reflow");
    // Row 1 (B's own row) moved only because A's band grew.
    for (const cell of rowOf(1)) { const id = cellRecord(cell.id); expect(diff.update.has(id)).toBe(true); expect(policyOf(diff, id)).toBe("snap"); }
    expect(policyOf(diff, entityId("row", null, "0"))).toBe("snap");
    // Row 2 moved because of both: it animates.
    for (const cell of rowOf(2)) expect(policyOf(diff, cellRecord(cell.id))).toBe("animate");
    // A's own content snaps; B's arrives animated.
    for (const [id, record] of diff.enter) expect(policyOf(diff, id)).toBe(record.graphId === "s0:root" ? "snap" : "animate");
    for (const [id, { after: record }] of diff.update) if (record.graphId === "s0:root") expect(["snap", "carry"]).toContain(policyOf(diff, id));
  });

  it("classifies with the raw layouts and covers every record, exits included", () => {
    const before = sceneFor(["s0:root", "s1:root"], "s1:ab"), after = sceneFor(["s1:root"], "s1:a", before.layout);
    const diff = diffScenes(before, after);
    expect(diff.policy.graphs.get("s0:root")).toBe("reflow");
    for (const id of after.records.keys()) expect(diff.policy.records.has(id)).toBe(true);
    for (const id of diff.exit.keys()) expect(diff.policy.records.has(id)).toBe(true);
  });

  it("handles empty scenes", () => {
    const empty = buildFolderScene({ scope, layoutInput: folderInput(makeFolder({ stacks: [] }), { width }), layout: engines.default(folderInput(makeFolder({ stacks: [] }), { width })), sources: new Map(), styling: plain });
    const diff = diffScenes(empty, empty);
    expect([diff.enter.size, diff.update.size, diff.exit.size, diff.policy.records.size, diff.policy.graphs.size, diff.policy.reset]).toEqual([0, 0, 0, 0, 0, false]);
  });

  it("does not mutate either scene", () => {
    const before = sceneFor(["s0:root"], null), after = sceneFor(["s0:root", "s1:root"], "s0:Saffron", before.layout);
    const snapshot = structuredClone({ before: before.records, after: after.records, layout: after.layout });
    diffScenes(before, after);
    expect({ before: before.records, after: after.records, layout: after.layout }).toEqual(snapshot);
  });
});
