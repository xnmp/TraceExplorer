import { describe, expect, it } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, type FolderScene, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { EASE, MOTION_MS, retargetPresentation, retargetTrack, samplePresentation, sampleTrack, sliceEase, staticPresentation, type Pose, type Track } from "$lib/plugins/trace/view/presentation";
import { presentationView, ridesSection } from "$lib/plugins/trace/view/presentation-view";
import { compileTrack, cssEasing, keyframesOf, type CompiledFrame } from "$lib/plugins/trace/view/scene-motion";
import { folderInput, handCase, makeFolder, sourcesOf, type Folder } from "../../domain/trace-graph/folder-layout-fixtures";

const rect = (x: number, y: number, width = 50, height = 40): GridRect => ({ x, y, width, height });
const pose = (x: number, y: number, opacity = 1, size: [number, number] = [50, 40]): Pose => ({ rect: rect(x, y, ...size), opacity, clip: null });

/** The displayed displacement a compiled keyframe list shows at `at`, interpolating as the native effect does. */
function shownAt(frames: readonly CompiledFrame[], at: number, key: "dx" | "dy" | "opacity" | "width"): number {
  if (at <= frames[0].at) return frames[0][key];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (at > b.at) continue;
    const u = (at - a.at) / (b.at - a.at || 1);
    const k = a.easing === "linear" ? u : sampleTrack({ frames: [{ at: 0, pose: pose(0, 0), easing: a.easing }, { at: 1, pose: pose(1, 0), easing: "linear" }] }, u).rect.x;
    return a[key] + (b[key] - a[key]) * k;
  }
  return frames[frames.length - 1][key];
}

describe("compiling tracks to keyframes", () => {
  it("compiles a single eased segment exactly, relative to the element's laid-out box", () => {
    const base = rect(100, 200), track = retargetTrack(pose(60, 260, .3), pose(100, 200))!;
    const frames = compileTrack(track, base, null, MOTION_MS);
    expect(frames.map((f) => [f.at, f.dx, f.dy, f.opacity])).toEqual([[0, -40, 60, .3], [MOTION_MS, 0, 0, 1]]);
    expect(frames[0].easing).toEqual(EASE);
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

  it("writes only the properties that change, as native keyframes", () => {
    const base = rect(0, 0, 92, 120);
    const moving = compileTrack(retargetTrack(pose(-8, 4, 1, [92, 120]), pose(0, 0, 1, [92, 120]))!, base, null, MOTION_MS);
    expect(keyframesOf(moving, base, "move", MOTION_MS)).toEqual([
      { offset: 0, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", transform: "translate(-8px, 4px)" },
      { offset: 1, easing: "linear", transform: "translate(0px, 0px)" },
    ]);
    const resizing = compileTrack(retargetTrack(pose(0, 0, 1, [92, 120]), pose(0, 0, 1, [120, 150]))!, rect(0, 0, 120, 150), null, MOTION_MS);
    const sized = keyframesOf(resizing, rect(0, 0, 120, 150), "box", MOTION_MS)!;
    expect(sized.map((f) => f.width)).toEqual(["92px", "120px"]);
    expect(sized.every((f) => !("transform" in f) && !("opacity" in f))).toBe(true);
    const entering = compileTrack(retargetTrack(pose(0, -10, 0), pose(0, 0))!, rect(0, 0), null, MOTION_MS);
    expect(keyframesOf(entering, rect(0, 0), "box", MOTION_MS)![0].opacity).toBe(0);
    // Nothing changes: no effect at all.
    expect(keyframesOf([{ at: 0, dx: 0, dy: 0, width: 50, height: 40, opacity: 1, clip: null, easing: "linear" }, { at: 160, dx: 0, dy: 0, width: 50, height: 40, opacity: 1, clip: null, easing: "linear" }], rect(0, 0), "box", MOTION_MS)).toBeNull();
  });

  it("clips with an absolute polygon in the element's own box and scales rows from their top", () => {
    const container = rect(0, 100, 300, 200);
    const track: Track = { frames: [
      { at: 0, pose: { rect: container, opacity: 1, clip: rect(0, 100, 300, 200) }, easing: EASE },
      { at: MOTION_MS, pose: { rect: container, opacity: 0, clip: rect(0, 100, 300, 0) }, easing: "linear" },
    ] };
    const frames = keyframesOf(compileTrack(track, container, null, MOTION_MS), container, "layer", MOTION_MS)!;
    expect(frames[0].clipPath).toBe("polygon(0px 0px, 300px 0px, 300px 200px, 0px 200px)");
    expect(frames[1].clipPath).toBe("polygon(0px 0px, 300px 0px, 300px 0px, 0px 0px)");
    const row = keyframesOf(compileTrack(retargetTrack(pose(0, 10, 1, [400, 0]), pose(0, 0, 1, [400, 80]))!, rect(0, 0, 400, 80), null, MOTION_MS), rect(0, 0, 400, 80), "row", MOTION_MS)!;
    expect(row[0].transform).toBe("translateY(10px) scaleY(0)");
    expect(row[1].transform).toBe("translateY(0px) scaleY(1)");
  });

  it("formats easings natively", () => {
    expect(cssEasing("linear")).toBe("linear");
    expect(cssEasing([.1, .2, .3, 1.4])).toBe("cubic-bezier(0.1, 0.2, 0.3, 1.4)");
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
