import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, type FolderScene, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { EASE, MOTION_MS, easeAt, retargetPresentation, retargetTrack, samplePresentation, sampleTrack, sliceEase, staticPresentation, type Pose, type Track } from "$lib/plugins/trace/view/presentation";
import { presentationView, ridesSection } from "$lib/plugins/trace/view/presentation-view";
import { animatedProperties, cameraAt, compileTrack, frameAt, styleOf, type CompiledFrame } from "$lib/plugins/trace/view/scene-motion";
import { folderInput, handCase, makeFolder, sourcesOf, type Folder } from "../../domain/trace-graph/folder-layout-fixtures";

const rect = (x: number, y: number, width = 50, height = 40): GridRect => ({ x, y, width, height });
const pose = (x: number, y: number, opacity = 1, size: [number, number] = [50, 40]): Pose => ({ rect: rect(x, y, ...size), opacity, clip: null });

/** What compiled frames display at `at`, as the driver writes it each frame. */
const shownAt = (frames: readonly CompiledFrame[], at: number, key: "dx" | "dy" | "opacity" | "width"): number => frameAt(frames, at)[key];
const compiled = (at: number, dx: number, easing: CompiledFrame["easing"] = "linear", extra: Partial<CompiledFrame> = {}): CompiledFrame =>
  ({ at, dx, dy: 0, width: 50, height: 40, opacity: 1, clip: null, easing, ...extra });

describe("compiling tracks", () => {
  it("compiles a single eased segment exactly, relative to the element's laid-out box", () => {
    const base = rect(100, 200), track = retargetTrack(pose(60, 260, .3), pose(100, 200))!;
    const frames = compileTrack(track, base, null, MOTION_MS);
    expect(frames.map((f) => [f.at, f.dx, f.dy, f.opacity])).toEqual([[0, -40, 60, .3], [MOTION_MS, 0, 0, 1]]);
    expect(frames[0].easing).toEqual(EASE);
    for (const at of [0, 7, 40, 100, 159.9, MOTION_MS]) {
      const exact = sampleTrack(track, at);
      expect(shownAt(frames, at, "dx")).toBeCloseTo(exact.rect.x - base.x, 9);
      expect(shownAt(frames, at, "dy")).toBeCloseTo(exact.rect.y - base.y, 9);
      expect(shownAt(frames, at, "opacity")).toBeCloseTo(exact.opacity, 9);
    }
  });

  it("is exact relative to a frame moving with the same easing", () => {
    const base = rect(10, 300), track = retargetTrack(pose(40, 500), pose(10, 300))!;
    const frameBase = rect(0, 280), frame = { track: retargetTrack(pose(0, 400), pose(0, 280)), base: frameBase, x: false };
    const frames = compileTrack(track, base, frame, MOTION_MS);
    expect(frames).toHaveLength(2);
    for (const at of [0, 13, 40, 99, 160]) {
      const own = sampleTrack(track, at).rect, section = sampleTrack(frame.track!, at).rect;
      expect(shownAt(frames, at, "dy")).toBeCloseTo(own.y - base.y - (section.y - frameBase.y), 6);
      // The frame moves only vertically: horizontal motion stays the record's own.
      expect(shownAt(frames, at, "dx")).toBeCloseTo(own.x - base.x, 6);
    }
  });

  it("follows both motions within half a pixel where the record and its frame ease differently", () => {
    const base = rect(0, 0), track: Track = { frames: [
      { at: 0, pose: pose(0, -10, 0), easing: sliceEase(EASE, 0, .4) },
      { at: 50, pose: pose(0, -5, 0), easing: sliceEase(EASE, .4, 1) },
      { at: MOTION_MS, pose: pose(0, 0, 1), easing: "linear" },
    ] };
    const frame = { track: { frames: [{ at: 0, pose: pose(0, 300), easing: EASE }, { at: MOTION_MS, pose: pose(0, 0), easing: "linear" as const }] }, base: rect(0, 0), x: false };
    const frames = compileTrack(track, base, frame, MOTION_MS);
    expect(frames.length).toBeGreaterThan(3);
    for (let at = 0; at <= MOTION_MS; at += 2.5) {
      const exact = sampleTrack(track, at).rect.y - sampleTrack(frame.track, at).rect.y;
      expect(Math.abs(shownAt(frames, at, "dy") - exact), `${at} ms`).toBeLessThanOrEqual(.5);
    }
  });

  it("holds a shorter track's final pose to the common duration", () => {
    const track = retargetTrack(pose(0, 20), pose(0, 0), 80)!;
    const frames = compileTrack(track, rect(0, 0), null, MOTION_MS);
    expect(frames.at(-1)!.at).toBe(MOTION_MS);
    expect(frames.at(-2)!.at).toBe(80);
    expect(frames.at(-2)!.easing).toBe("linear");
    expect(shownAt(frames, 120, "dy")).toBe(0);
  });
});

describe("sampling compiled frames", () => {
  const two = [compiled(0, -40, EASE, { opacity: .2 }), compiled(MOTION_MS, 0)];

  it("shows each endpoint exactly", () => {
    expect(frameAt(two, 0)).toEqual({ dx: -40, dy: 0, width: 50, height: 40, opacity: .2, clip: null });
    expect(frameAt(two, MOTION_MS)).toEqual({ dx: 0, dy: 0, width: 50, height: 40, opacity: 1, clip: null });
  });

  it("eases a segment by its starting frame's easing", () => {
    for (const at of [10, 40, 80, 150]) {
      const k = easeAt(EASE, at / MOTION_MS);
      expect(frameAt(two, at).dx).toBeCloseTo(-40 + 40 * k, 12);
      expect(frameAt(two, at).opacity).toBeCloseTo(.2 + .8 * k, 12);
    }
    // Eased, not linear: an ease-out is well ahead of linear early on.
    expect(frameAt(two, 40).dx).toBeGreaterThan(-40 + 40 * .25 + 5);
  });

  it("finds the segment holding the time across many frames, each with its own easing", () => {
    const frames = [compiled(0, 0, "linear"), compiled(10, 10, EASE), compiled(30, 50, "linear"), compiled(31, 60, [0, 0, 1, 1]), compiled(100, 100)];
    expect(frameAt(frames, 5).dx).toBeCloseTo(5, 12);
    expect(frameAt(frames, 10).dx).toBe(10);
    expect(frameAt(frames, 20).dx).toBeCloseTo(10 + 40 * easeAt(EASE, .5), 12);
    expect(frameAt(frames, 30.5).dx).toBeCloseTo(55, 12);
    expect(frameAt(frames, 31).dx).toBe(60);
    expect(frameAt(frames, 65.5).dx).toBeCloseTo(60 + 40 * easeAt([0, 0, 1, 1], .5), 12);
    // Monotone frames display monotone values.
    let last = -Infinity;
    for (let at = 0; at <= 100; at += .25) { const dx = frameAt(frames, at).dx; expect(dx).toBeGreaterThanOrEqual(last); last = dx; }
  });

  it("holds the first frame before the epoch and the last after it", () => {
    expect(frameAt(two, -50)).toEqual(frameAt(two, 0));
    expect(frameAt(two, -Infinity)).toEqual(frameAt(two, 0));
    expect(frameAt(two, 10 * MOTION_MS)).toEqual(frameAt(two, MOTION_MS));
    expect(frameAt(two, Infinity)).toEqual(frameAt(two, MOTION_MS));
  });

  it("reads a time that is not a number as the first frame", () => {
    expect(frameAt(two, NaN)).toEqual(frameAt(two, 0));
  });

  it("shows the last values of a motion without duration, and of a single frame at every time", () => {
    const instant = [compiled(0, -40), compiled(0, 0)];
    expect(frameAt(instant, 0).dx).toBe(-40);
    expect(frameAt(instant, 1).dx).toBe(0);
    const single = [compiled(0, 7)];
    for (const at of [-1, 0, 5, NaN, Infinity]) expect(frameAt(single, at).dx).toBe(7);
  });

  it("refuses an empty frame list", () => {
    expect(() => frameAt([], 0)).toThrow(RangeError);
  });

  it("interpolates a clip from an unclipped frame's whole box", () => {
    const frames = [compiled(0, 0, "linear", { width: 300, height: 200 }), compiled(100, 0, "linear", { width: 300, height: 200, clip: rect(0, 0, 300, 0) })];
    expect(frameAt(frames, 0).clip).toBeNull();
    expect(frameAt(frames, 50).clip).toEqual(rect(0, 0, 300, 100));
    expect(frameAt(frames, 100).clip).toEqual(rect(0, 0, 300, 0));
  });
});

describe("inline styles of a compiled motion", () => {
  const at = (frames: CompiledFrame[], base: GridRect, kind: Parameters<typeof styleOf>[2], time: number) => styleOf(frameAt(frames, time), base, kind, animatedProperties(frames, base, kind));

  it("writes only the properties that change", () => {
    const base = rect(0, 0, 92, 120);
    const moving = compileTrack(retargetTrack(pose(-8, 4, 1, [92, 120]), pose(0, 0, 1, [92, 120]))!, base, null, MOTION_MS);
    expect(animatedProperties(moving, base, "move")).toEqual(["transform"]);
    expect(at(moving, base, "move", 0)).toEqual({ transform: "translate(-8px, 4px)" });
    expect(at(moving, base, "move", MOTION_MS)).toEqual({ transform: "translate(0px, 0px)" });
    const resized = rect(0, 0, 120, 150);
    const resizing = compileTrack(retargetTrack(pose(0, 0, 1, [92, 120]), pose(0, 0, 1, [120, 150]))!, resized, null, MOTION_MS);
    expect(animatedProperties(resizing, resized, "box")).toEqual(["width", "height"]);
    expect([0, MOTION_MS].map((time) => at(resizing, resized, "box", time).width)).toEqual(["92px", "120px"]);
    const entering = compileTrack(retargetTrack(pose(0, -10, 0), pose(0, 0))!, rect(0, 0), null, MOTION_MS);
    expect(at(entering, rect(0, 0), "box", 0)).toEqual({ transform: "translate(0px, -10px)", opacity: "0" });
    // A connector layer that only moves neither fades nor resizes; a cell never fades.
    expect(animatedProperties(entering, rect(0, 0), "move")).toEqual(["transform"]);
    // Nothing changes: no effect at all.
    expect(animatedProperties([compiled(0, 0), compiled(MOTION_MS, 0)], rect(0, 0), "box")).toEqual([]);
  });

  it("clips with an absolute polygon in the element's own box and scales rows from their top", () => {
    const container = rect(0, 100, 300, 200);
    const track: Track = { frames: [
      { at: 0, pose: { rect: container, opacity: 1, clip: rect(0, 100, 300, 200) }, easing: EASE },
      { at: MOTION_MS, pose: { rect: container, opacity: 0, clip: rect(0, 100, 300, 0) }, easing: "linear" },
    ] };
    const layer = compileTrack(track, container, null, MOTION_MS);
    expect(at(layer, container, "layer", 0).clipPath).toBe("polygon(0px 0px, 300px 0px, 300px 200px, 0px 200px)");
    expect(at(layer, container, "layer", MOTION_MS).clipPath).toBe("polygon(0px 0px, 300px 0px, 300px 0px, 0px 0px)");
    const row = compileTrack(retargetTrack(pose(0, 10, 1, [400, 0]), pose(0, 0, 1, [400, 80]))!, rect(0, 0, 400, 80), null, MOTION_MS);
    expect(at(row, rect(0, 0, 400, 80), "row", 0).transform).toBe("translateY(10px) scaleY(0)");
    expect(at(row, rect(0, 0, 400, 80), "row", MOTION_MS).transform).toBe("translateY(0px) scaleY(1)");
    // A row without height scales by one.
    expect(styleOf({ dx: 0, dy: 3, width: 0, height: 0, opacity: 1, clip: null }, rect(0, 0, 0, 0), "row", ["transform"]).transform).toBe("translateY(3px) scaleY(1)");
  });

  it("writes finite values only", () => {
    const shown = styleOf({ dx: NaN, dy: -0, width: 1e-9, height: 2, opacity: .1234567891, clip: null }, rect(0, 0), "box", ["transform", "width", "opacity"]);
    expect(shown).toEqual({ transform: "translate(0px, 0px)", width: "0px", opacity: "0.123457" });
  });
});

// ─── What the renderers draw ────────────────────────────────────────────────

const scope: SceneScope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
const folder: Folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 12 });
const [A, B] = [...folder.stacks.keys()];
function sceneFor(open: string[], previous: FolderLayout | null = null, width = 640): FolderScene {
  const input = folderInput(folder, { open, focus: null, width, tile, grid, previous });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: plain });
}
const participants = { transaction: 1, epoch: 1 };

describe("the camera", () => {
  it("eases its displacement away over the epoch", () => {
    const shift = { x: -12, y: 300 };
    expect(cameraAt(shift, 0, MOTION_MS)).toEqual(shift);
    expect(cameraAt(shift, MOTION_MS, MOTION_MS)).toEqual({ x: -0, y: 0 });
    expect(cameraAt(shift, 10 * MOTION_MS, MOTION_MS).y).toBe(0);
    const k = sampleTrack(retargetTrack(pose(0, 0), pose(1, 0))!, 40).rect.x;
    expect(cameraAt(shift, 40, MOTION_MS).y).toBeCloseTo(300 * (1 - k), 9);
    expect(cameraAt(shift, 40, MOTION_MS).x).toBeCloseTo(-12 * (1 - k), 9);
  });

  it("has no displacement without an epoch to ease over", () => {
    expect(cameraAt({ x: 5, y: 5 }, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(cameraAt({ x: 5, y: 5 }, NaN, MOTION_MS)).toEqual({ x: 5, y: 5 });
  });
});

describe("presentationView", () => {
  it("draws nothing extra for a settled presentation", () => {
    const view = presentationView(staticPresentation(sceneFor([A, B])));
    expect(view.exits).toEqual([]);
    expect([...view.graphs.values()].every((g) => g.layered.size === 0 && g.retiring.length === 0)).toBe(true);
  });

  it("groups a closed band's retirees into one exit group", () => {
    const open = sceneFor([A]), closed = sceneFor([], open.layout);
    const p = retargetPresentation(samplePresentation(staticPresentation(open), Infinity), closed, diffScenes(open, closed), participants);
    const view = presentationView(p);
    expect(view.exits).toHaveLength(1);
    const [exit] = view.exits;
    expect(exit.group.record.kind).toBe("band");
    expect(exit.tiles.length + exit.routes.length + exit.junctions.length).toBe([...p.retiring.values()].filter((r) => r.group === exit.group.renderId).length);
    expect(exit.tiles.length).toBeGreaterThan(0);
  });

  it("layers exactly the moving connectors that do not ride with their section", () => {
    const narrow = sceneFor([A, B], null, 640), wide = sceneFor([A, B], narrow.layout, 900);
    const p = retargetPresentation(samplePresentation(staticPresentation(narrow), Infinity), wide, diffScenes(narrow, wide), participants);
    const view = presentationView(p);
    let layered = 0;
    for (const presented of p.live.values()) {
      const { record, track } = presented;
      if (record.kind !== "route" && record.kind !== "junction") continue;
      const has = view.graphs.get(record.graphId!)?.layered.has(record.id) ?? false;
      expect(has, record.id).toBe(!!track && !ridesSection(p, record, track));
      if (has) layered++;
    }
    expect(layered).toBeGreaterThan(0);
    // Memoised per presentation.
    expect(presentationView(p)).toBe(view);
  });
});
