import { describe, expect, it } from "vitest";
import { engines } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, type FolderScene, type SceneStyling, type TileRecord } from "$lib/domain/trace-graph/folder-scene";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { FileEntry } from "$lib/domain/file";
import { badgeThumbnails, entryThumbnail, nodeThumbnail, recordThumbnails, sceneThumbnails } from "$lib/plugins/trace/view/scene-media";
import { PARTICIPANT_MARGIN } from "$lib/plugins/trace/view/participants";
import { UNMEASURED } from "$lib/plugins/trace/view/scene-window";
import { folderInput, handCase, makeFolder, sourcesOf } from "../../domain/trace-graph/folder-layout-fixtures";

const present: TraceNode = { key: "k", parents: [], order: 0, artifactId: 0, runId: null, path: "/f/k.png", scope: "current", location: "", state: "present", temporary: false, discarded: false, earlierRevision: false, prompt: "" };
const file = (name: string, kind: FileEntry["kind"] = "file"): FileEntry => ({ name, path: `/f/${name}`, kind, size: 1, modified: "" });

describe("which image a tile or file draws", () => {
  it("a tile draws its node's image only when the node is present, current and kept", () => {
    expect(nodeThumbnail(present)).toBe("/f/k.png");
    for (const state of ["running", "missing", "uncertain"] as const) expect(nodeThumbnail({ ...present, state }), state).toBeNull();
    expect(nodeThumbnail({ ...present, discarded: true })).toBeNull();
    expect(nodeThumbnail({ ...present, earlierRevision: true })).toBeNull();
    expect(nodeThumbnail({ ...present, path: null })).toBeNull();
    expect(nodeThumbnail({ ...present, path: "" })).toBeNull();
  });

  it("an ordinary file draws an image only for image files, never for folders", () => {
    for (const name of ["a.png", "B.JPG", "c.jpeg", "d.webp", "e.gif", "f.bmp", "g.avif", "h.tif", "i.tiff"]) expect(entryThumbnail(file(name)), name).toBe(`/f/${name}`);
    for (const name of ["notes.txt", "png", "a.png.txt", ".png-dir"]) expect(entryThumbnail(file(name)), name).toBeNull();
    expect(entryThumbnail(file("photos.png", "directory"))).toBeNull();
  });
});

const scope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
// A stack with a reference badge and a running placeholder, a screenshot stack, then many files: a tall folder.
const folder = makeFolder({ stacks: [handCase("foreign-and-placeholder"), handCase("screenshot")], files: 60, directories: 2 });
const [A, B] = [...folder.stacks.keys()];
function sceneFor(open: string[], focus: string | null = null): FolderScene {
  const input = folderInput(folder, { open, focus, width: 200, tile, grid, previous: null });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: { ...plain, focus } });
}
/** Every image a record of `scene` draws, by the record's vertical extent. */
const drawn = (scene: FolderScene, hostEntries = false) => [...scene.records.values()].flatMap((record) => recordThumbnails(scene, record, hostEntries).map((path) => ({ path, rect: record.rect, kind: record.kind })));

describe("badgeThumbnails", () => {
  const badge = (key: string, path: string) => ({ key, path, scope: "external" as const, consumers: [] });
  it("draws each badge's image in order, skipping badges without a path and those whose node is not present", () => {
    const nodes = new Map<string, TraceNode>([["gone", { ...present, key: "gone", state: "missing" }], ["here", { ...present, key: "here" }]]);
    const badges = [badge("here", "/r/here.png"), badge("gone", "/r/gone.png"), badge("unknown", "/r/unknown.png"), badge("blank", "")];
    expect(badgeThumbnails(badges, nodes)).toEqual(["/r/here.png", "/r/unknown.png"]);
    expect(badgeThumbnails(badges), "without nodes, every badge with a path").toEqual(["/r/here.png", "/r/gone.png", "/r/unknown.png"]);
    expect(badgeThumbnails([])).toEqual([]);
  });
});

describe("recordThumbnails", () => {
  const scene = sceneFor([A, B], [...folder.stacks.get(A)!.graph.dag.nodes.keys()].find((key) => key.endsWith("edited")) ?? null);

  it("draws a tile's image and its reference badges' images, and nothing for a running placeholder", () => {
    const tiles = [...scene.records.values()].filter((record): record is TileRecord => record.kind === "tile");
    const placeholder = tiles.find((record) => record.tile.node.state === "running");
    expect(placeholder, "fixture: a running placeholder").toBeDefined();
    expect(recordThumbnails(scene, placeholder!, false).filter((path) => path === placeholder!.tile.node.path)).toEqual([]);
    const badged = tiles.find((record) => record.badges.length > 0 && nodeThumbnail(record.tile.node));
    expect(badged, "fixture: a tile with a reference badge").toBeDefined();
    expect(badged!.badges.length).toBeLessThanOrEqual(3);
    expect(recordThumbnails(scene, badged!, false)).toEqual([badged!.tile.node.path, ...badged!.badges.map((badge) => badge.path)]);
  });

  it("draws only the badges a tile shows: the first three, and a selected one behind +n", () => {
    const badged = [...scene.records.values()].find((record): record is TileRecord => record.kind === "tile" && record.badges.length > 0 && !!nodeThumbnail(record.tile.node))!;
    const extra = Array.from({ length: 5 }, (_, i) => ({ ...badged.badges[0], key: `extra-${i}`, path: `/elsewhere/extra-${i}.png` }));
    const many: TileRecord = { ...badged, badges: extra };
    expect(recordThumbnails(scene, many, false)).toEqual([badged.tile.node.path, "/elsewhere/extra-0.png", "/elsewhere/extra-1.png", "/elsewhere/extra-2.png"]);
    const selecting = { ...scene, inputs: { ...scene.inputs, styling: { ...scene.inputs.styling, selectedKeys: new Set(["extra-4"]) } } };
    expect(recordThumbnails(selecting, many, false)).toEqual([badged.tile.node.path, "/elsewhere/extra-0.png", "/elsewhere/extra-1.png", "/elsewhere/extra-2.png", "/elsewhere/extra-4.png"]);
  });

  it("draws nothing for a host file tile, routes or bands", () => {
    const entries = [...scene.records.values()].filter((record) => record.kind === "entry");
    expect(entries.some((record) => recordThumbnails(scene, record, false).length > 0)).toBe(true);
    expect(entries.every((record) => recordThumbnails(scene, record, true).length === 0)).toBe(true);
    for (const record of scene.records.values()) if (record.kind === "route" || record.kind === "band" || record.kind === "junction" || record.kind === "row") expect(recordThumbnails(scene, record, false)).toEqual([]);
  });
});

describe("sceneThumbnails", () => {
  const closed = sceneFor([]), opened = sceneFor([A, B]);
  const span = (viewport: { y: number; height: number }, margin: number) => ({ top: viewport.y - margin, bottom: viewport.y + viewport.height + margin });
  const within = (rect: { y: number; height: number }, s: { top: number; bottom: number }) => rect.y <= s.bottom && rect.y + rect.height >= s.top;

  it("takes the images of records within the margin of the viewport, and no others", () => {
    const viewport = { x: 0, y: 0, width: 200, height: 300 };
    const paths = sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: false, margin: 400 });
    const s = span(viewport, 400);
    const expected = new Set(drawn(opened).filter((item) => within(item.rect, s)).map((item) => item.path));
    expect(paths).toEqual(expected);
    expect(paths.size).toBeGreaterThan(0);
    expect(paths.size, "the tall folder reaches beyond the margin").toBeLessThan(new Set(drawn(opened).map((item) => item.path)).size);
  });

  it("takes a record where the scene on screen draws it: carried into view, it is mounted from there", () => {
    const viewport = { x: 0, y: 0, width: 200, height: 300 };
    const s = span(viewport, 0);
    // Opening the stacks pushes files down; one that was in view and now lies below it still counts.
    const pushed = drawn(opened).find((item) => item.kind === "entry" && !within(item.rect, s)
      && [...closed.records.values()].some((record) => record.kind === "entry" && recordThumbnails(closed, record, false)[0] === item.path && within(record.rect, s)));
    expect(pushed, "fixture: a file pushed out of view").toBeDefined();
    expect(sceneThumbnails({ next: opened, previous: closed, viewport, hostEntries: false, margin: 0 }).has(pushed!.path)).toBe(true);
    expect(sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: false, margin: 0 }).has(pushed!.path)).toBe(false);
  });

  it("without a usable viewport, takes what the grid mounts before measuring one", () => {
    const s = span({ y: UNMEASURED.top, height: UNMEASURED.bottom - UNMEASURED.top }, PARTICIPANT_MARGIN);
    const expected = new Set(drawn(opened).filter((item) => within(item.rect, s)).map((item) => item.path));
    expect(sceneThumbnails({ next: opened, previous: null, viewport: null, hostEntries: false })).toEqual(expected);
    for (const viewport of [{ x: 0, y: NaN, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: -5 }, { x: 0, y: 0, width: 10, height: Infinity }]) {
      expect(sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: false })).toEqual(expected);
    }
  });

  it("an unusable margin means none; a host's file tiles are never taken", () => {
    const viewport = { x: 0, y: 0, width: 200, height: 300 };
    expect(sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: false, margin: NaN })).toEqual(sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: false, margin: 0 }));
    const hosted = sceneThumbnails({ next: opened, previous: null, viewport, hostEntries: true, margin: 10_000 });
    expect([...hosted].some((path) => path.includes("/file-"))).toBe(false);
    expect(hosted.size).toBeGreaterThan(0);
  });

  it("takes nothing far beyond the folder", () => {
    expect(sceneThumbnails({ next: opened, previous: closed, viewport: { x: 0, y: 1e6, width: 200, height: 300 }, hostEntries: false }).size).toBe(0);
  });
});
