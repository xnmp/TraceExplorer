import { routeConsumers } from "$lib/domain/trace-graph/route-consumers";
import { describe, expect, it } from "vitest";
import { engines, type FolderLayout, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, entityId, JUNCTION_RADIUS, type FolderScene, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { pathNumbers } from "$lib/domain/trace-graph/path-data";
import { folderInput, handCase, makeFolder, sourcesOf, type Folder, type InputOptions } from "./folder-layout-fixtures";
import { mockupNodes, node } from "./fixtures";
import { connectedComponents, projectDag } from "$lib/domain/trace-graph/projection";

const scope = { paneId: "p1", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };

function build(folder: Folder, options: InputOptions = {}, styling: Partial<SceneStyling> = {}): { input: FolderLayoutInput; layout: FolderLayout; scene: FolderScene } {
  const input = folderInput(folder, options), layout = engines.default(input);
  return { input, layout, scene: buildFolderScene({ scope, layoutInput: input, layout, sources: sourcesOf(folder), styling: { ...plain, focus: options.focus ?? null, ...styling } }) };
}
const kinds = (scene: FolderScene, kind: string) => [...scene.records.values()].filter((record) => record.kind === kind);
const mockup = () => {
  const nodes = mockupNodes(), byKey = new Map(nodes.map((n) => [n.key, n]));
  return makeFolder({ stacks: connectedComponents(projectDag(nodes)).map((keys) => keys.map((key) => byKey.get(key)!)), files: 3, directories: 1, seed: 4 });
};
const keyOf = (folder: Folder, name: string) => [...folder.stacks.values()].flatMap((s) => s.graph.dag.order).find((k) => k.endsWith(`:${name}`))!;

describe("folder scene records", () => {
  it("draws exactly the visible parentage: every edge between visible tiles, carried by connectors, and badges", () => {
    const folder = mockup(), ids = [...folder.stacks.keys()];
    for (const focus of [null, keyOf(folder, "warm"), keyOf(folder, "d"), keyOf(folder, "forest-mist")]) {
      const { scene } = build(folder, { open: ids, focus, width: 1400 });
      expect(scene.graphs.size).toBe(ids.length);
      for (const [id, graph] of scene.graphs) {
        const dag = folder.stacks.get(id)!.graph.dag, visible = new Set(graph.plan.tiles.keys());
        const expected = [...visible].flatMap((child) => (dag.parents.get(child) ?? []).filter((parent) => visible.has(parent)).map((parent) => `${parent}>${child}`)).sort();
        const edges = [...scene.edges.values()].filter((edge) => edge.graphId === id);
        expect(edges.filter((edge) => !edge.badge).map((edge) => `${edge.parent}>${edge.child}`).sort()).toEqual(expected);
        const drawn = new Set([...scene.routes.values()].filter((route) => route.graphId === id).flatMap((route) => routeConsumers(route.route).map((c) => `${c.parent}>${c.child}`)));
        expect([...drawn].sort()).toEqual(expected);
        expect(edges.filter((edge) => edge.badge).map((edge) => `${edge.parent}>${edge.child}`).sort())
          .toEqual([...graph.plan.badges].flatMap(([child, badges]) => badges.map((badge) => `${badge.key}>${child}`)).sort());
      }
    }
  });

  it("places each cover exactly once, on its cell, open or closed", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3"), handCase("fan-8")], files: 4, seed: 2 });
    const { scene, layout } = build(folder, { open: ["s0:root", "s2:root"], focus: "s0:Saffron", width: 640 });
    for (const id of folder.stacks.keys()) {
      const covers = [...scene.tiles.values()].filter((record) => record.tile.key === id);
      expect(covers).toHaveLength(1);
      const [cover] = covers, cell = layout.cells.get(id)!;
      expect(cover.id).toBe(entityId("tile", id, id));
      expect(cover.cover?.expanded).toBe(id !== "s1:root");
      expect(cover.rect.y).toBe(cell.y);
      expect(cover.rect.height).toBe(cell.height);
      expect(cover.rect.x + cover.rect.width / 2).toBeCloseTo(cell.x + cell.width / 2, 9);
    }
    expect(scene.entries.size).toBe(4);
    for (const [path, record] of scene.entries) {
      const { x, y, width, height } = layout.cells.get(path)!;
      expect(record.entry.path).toBe(path);
      expect(record.rect).toEqual({ x, y, width, height });
    }
  });

  it("puts every record exactly where the layout packs and attaches it, in folder coordinates", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3"), handCase("mixed-depth")], files: 5, seed: 6 });
    const { scene, layout } = build(folder, { open: [...folder.stacks.keys()], focus: "s2:long7", width: 454 });
    for (const [id, graph] of layout.graphs) {
      const { x: dx, y: dy } = graph.origin;
      for (const [key, node] of graph.attached.nodes) {
        if (key === id) continue;
        const record = scene.tiles.get(entityId("tile", id, key))!;
        expect(record.rect).toEqual({ x: node.x + dx, y: node.y + dy, width: node.width, height: node.height });
        expect(record.placed).toBe(node);
        expect(scene.navigation.get(key)).toEqual(record.rect);
      }
      for (const route of graph.attached.routes) {
        const record = scene.routes.get(entityId("route", id, route.id))!, local = pathNumbers(route.path), folderPath = pathNumbers(record.route.path);
        expect(folderPath).toEqual(local.map((value, i) => value + (i % 2 ? dy : dx)));
        // Padded control-point bounds: every point at least 12 px inside, and the extremes exactly 12 px in.
        const xs = folderPath.filter((_, i) => i % 2 === 0), ys = folderPath.filter((_, i) => i % 2 === 1);
        expect(record.rect.x).toBeCloseTo(Math.min(...xs) - 12, 9);
        expect(record.rect.y).toBeCloseTo(Math.min(...ys) - 12, 9);
        expect(record.rect.x + record.rect.width).toBeCloseTo(Math.max(...xs) + 12, 9);
        expect(record.rect.y + record.rect.height).toBeCloseTo(Math.max(...ys) + 12, 9);
      }
      for (const junction of graph.attached.junctions.values()) {
        const record = scene.records.get(entityId("junction", id, junction.id))!;
        expect(record.rect).toEqual({ x: junction.x + dx - JUNCTION_RADIUS, y: junction.y + dy - JUNCTION_RADIUS, width: 2 * JUNCTION_RADIUS, height: 2 * JUNCTION_RADIUS });
      }
    }
    expect(kinds(scene, "band").map((record) => record.rect)).toEqual(layout.bands.map(({ x, y, width, height }) => ({ x, y, width, height })));
    expect(kinds(scene, "row").map((record) => record.id)).toEqual(layout.rowBands.map((row) => entityId("row", null, String(row.row))));
    for (const record of scene.records.values()) {
      const { x, y, width, height } = record.rect, b = scene.bounds;
      if (record.kind !== "route") expect(x >= b.x && y >= b.y && x + width <= b.x + b.width + 1e-9 && y + height <= b.y + b.height + 1e-9, record.id).toBe(true);
    }
    for (const cell of layout.cells.keys()) expect(scene.navigation.has(cell)).toBe(true);
  });

  it("styles from focus, selection and badge hover without moving anything", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 2 });
    const options = { open: ["s0:root", "s1:root"], focus: "s0:Saffron", width: 900 };
    const { scene, input, layout } = build(folder, options);
    const tone = (graph: string, key: string) => scene.tiles.get(entityId("tile", graph, key))!.tile.tone;
    expect(tone("s0:root", "s0:Saffron")).toBe("focus");
    expect(tone("s0:root", "s0:Ash")).toBe("related");
    expect(tone("s0:root", "s0:Cerulean")).toBe("unrelated");
    // Another stack's focus dims this one entirely, as the view always has.
    expect([...scene.tiles.values()].filter((record) => record.graphId === "s1:root").every((record) => record.tile.tone === "unrelated")).toBe(true);
    const file = [...scene.entries.keys()][0];
    const restyled = buildFolderScene({ scope, layoutInput: input, layout, sources: sourcesOf(folder),
      styling: { focus: null, selectedKeys: new Set(["s1:a"]), selectedPaths: new Set([file]), badgeHover: null } });
    expect(restyled.tiles.get(entityId("tile", "s1:root", "s1:a"))!.selected).toBe(true);
    expect(restyled.entries.get(file)!.selected).toBe(true);
    expect([...restyled.tiles.values()].every((record) => record.tile.tone === "neutral")).toBe(true);
    expect([...restyled.records.keys()]).toEqual([...scene.records.keys()]);
    for (const [id, record] of restyled.records) {
      expect(record.rect).toEqual(scene.records.get(id)!.rect);
      if (record.kind === "route") expect(record.route.path).toBe((scene.records.get(id) as typeof record).route.path);
    }
  });

  it("highlights a hovered reference badge's consumers", () => {
    const folder = makeFolder({ stacks: [handCase("foreign-and-placeholder")] });
    const { scene } = build(folder, { open: ["s0:root"] }, { badgeHover: "s0:outside" });
    expect(scene.tiles.get(entityId("tile", "s0:root", "s0:edited"))!.tile.tone).not.toBe("neutral");
    expect([...scene.edges.values()].some((edge) => edge.badge && edge.parent === "s0:outside" && edge.child === "s0:edited")).toBe(true);
  });

  // Review 8d257bf: a retiring tile drawn outside its band (an orphan, an exit group) has only its
  // record to say how its band drew it, so a sideways tile kept its chevron while it fades.
  it("records how each band tile's band draws it, sideways or down; covers draw down", () => {
    const chain = [node("root"), ...Array.from({ length: 15 }, (_, i) => node(`c${i}`, [i ? `c${i - 1}` : "root"]))];
    const orientations = new Set<string>();
    for (const [folder, width, focus] of [[mockup(), 1400, null], [makeFolder({ stacks: [chain] }), 420, "c14"]] as const) {
      const { scene } = build(folder, { open: [...folder.stacks.keys()], focus: focus && keyOf(folder, focus), width });
      for (const record of scene.tiles.values()) {
        const graph = record.graphId === null ? undefined : scene.graphs.get(record.graphId);
        if (record.cover) expect(record.orientation, record.id).toBeUndefined();
        else {
          expect(record.orientation, record.id).toBe(graph!.layout.orientation);
          orientations.add(record.orientation!);
        }
      }
    }
    expect(orientations).toEqual(new Set(["down", "right"]));
  });

  it("builds an empty scene", () => {
    const { scene } = build(makeFolder({ stacks: [] }), { width: 640 });
    expect([scene.records.size, scene.tiles.size, scene.entries.size, scene.edges.size, scene.navigation.size, scene.graphs.size]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(scene.bounds.height).toBe(0);
  });

  describe("rejects inconsistent or invalid input with RangeError", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 2 });
    const valid = () => build(folder, { open: ["s0:root", "s1:root"] });
    const scene = (patch: (base: ReturnType<typeof valid>) => Partial<Parameters<typeof buildFolderScene>[0]>) => {
      const base = valid();
      return () => buildFolderScene({ scope, layoutInput: base.input, layout: base.layout, sources: sourcesOf(folder), styling: plain, ...patch(base) });
    };
    it("a missing layout for an open stack, a graph that is not open, or a missing source", () => {
      expect(scene((b) => ({ layout: engines.default({ ...b.input, open: new Map([...b.input.open].slice(0, 1)) }) }))).toThrow(RangeError);
      expect(scene((b) => ({ layoutInput: { ...b.input, open: new Map([...b.input.open].slice(0, 1)) } }))).toThrow(RangeError);
      expect(scene(() => ({ sources: new Map([...sourcesOf(folder)].slice(0, 1)) }))).toThrow(RangeError);
      expect(scene((b) => ({ layout: { ...b.layout, graphs: new Map([...b.layout.graphs].map(([id, g]) => [id, { ...g, plan: { ...g.plan, tiles: new Map([...g.plan.tiles, ["ghost", g.plan.tiles.get(id)!]]) } }])) } }))).toThrow(RangeError);
    });
    it("cells that do not match the items, or duplicate items", () => {
      expect(scene((b) => ({ layout: { ...b.layout, cells: new Map([...b.layout.cells].slice(1)) } }))).toThrow(RangeError);
      expect(scene((b) => ({ layoutInput: { ...b.input, items: [...b.input.items, b.input.items[0]] } }))).toThrow(RangeError);
      expect(scene((b) => ({ layoutInput: { ...b.input, width: b.input.width + 4000 } }))).toThrow(RangeError);
    });
    it("duplicate routes", () => {
      expect(scene((b) => ({ layout: { ...b.layout, graphs: new Map([...b.layout.graphs].map(([id, g]) => [id, { ...g, attached: { ...g.attached, routes: [...g.attached.routes, g.attached.routes[0]] } }])) } }))).toThrow(RangeError);
    });
    it("non-finite or negative dimensions", () => {
      const cell = (b: ReturnType<typeof valid>, patch: object) => ({ layout: { ...b.layout, cells: new Map([...b.layout.cells].map(([id, c], i) => [id, i === 0 ? { ...c, ...patch } : c])) } });
      for (const patch of [{ x: NaN }, { width: -1 }, { height: 0 }, { y: Infinity }]) expect(scene((b) => cell(b, patch))).toThrow(RangeError);
      expect(scene((b) => ({ layout: { ...b.layout, bands: b.layout.bands.map((band) => ({ ...band, height: -5 })) } }))).toThrow(RangeError);
      expect(scene((b) => ({ layout: { ...b.layout, graphs: new Map([...b.layout.graphs].map(([id, g]) => [id, { ...g, origin: { x: 0, y: NaN } }])) } }))).toThrow(RangeError);
      expect(scene((b) => ({ layout: { ...b.layout, graphs: new Map([...b.layout.graphs].map(([id, g]) => [id, { ...g, attached: { ...g.attached, nodes: new Map([...g.attached.nodes].map(([k, n]) => [k, { ...n, width: NaN }])) } }])) } }))).toThrow(RangeError);
    });
  });

  it("does not mutate its input and is deterministic", () => {
    const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 2 });
    const input = folderInput(folder, { open: ["s0:root", "s1:root"], focus: "s1:ab" }), layout = engines.default(input);
    const args = { scope, layoutInput: input, layout, sources: sourcesOf(folder), styling: { ...plain, focus: "s1:ab", selectedKeys: new Set(["s1:ab"]) } };
    const before = structuredClone({ input, layout });
    const first = buildFolderScene(args), second = buildFolderScene(args);
    expect({ input, layout }).toEqual(before);
    expect(second.records).toEqual(first.records);
    // A scene never holds the engine's previous layout, so committed scenes do not chain.
    expect(buildFolderScene({ ...args, layoutInput: { ...input, previous: layout } }).inputs.layoutInput.previous).toBeNull();
  });
});
