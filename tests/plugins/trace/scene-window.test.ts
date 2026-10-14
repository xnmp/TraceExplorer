import { describe, expect, it } from "vitest";
import { engines } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, entityId, type FolderScene, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { MOTION_MS, retargetPresentation, samplePresentation, settledPresentation, staticPresentation } from "$lib/plugins/trace/view/presentation";
import { bandTopAt, bandWindow, displayedTime, quantise, WINDOW_STEP } from "$lib/plugins/trace/view/scene-window";
import { folderInput, handCase, makeFolder, sourcesOf } from "../../domain/trace-graph/folder-layout-fixtures";

const scope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 12 });
const [A, B] = [...folder.stacks.keys()];
const sceneFor = (open: string[]): FolderScene => {
  const input = folderInput(folder, { open, width: 200, tile, grid, previous: null });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: plain });
};

describe("scene window", () => {
  it("widens spans to whole steps, and refuses non-finite ones", () => {
    expect(quantise({ top: 10, bottom: 390 })).toEqual({ top: 0, bottom: 400 });
    expect(quantise({ top: -10, bottom: 400 })).toEqual({ top: -WINDOW_STEP, bottom: 400 });
    expect(quantise({ top: NaN, bottom: 1 })).toBeNull();
    expect(quantise({ top: 0, bottom: Infinity })).toBeNull();
  });

  it("reads the displayed time of the measured epoch, a newer epoch's start, or a still presentation's end", () => {
    const moving = { ...staticPresentation(sceneFor([]), 4), duration: MOTION_MS };
    expect(displayedTime(moving, { top: 0, bottom: 1, epoch: 4, at: 70 })).toBe(70);
    expect(displayedTime(moving, { top: 0, bottom: 1, epoch: 3, at: 70 })).toBe(0);
    expect(displayedTime(moving, null)).toBe(0);
    expect(displayedTime(staticPresentation(sceneFor([]), 4), { top: 0, bottom: 1, epoch: 4, at: 70 })).toBe(Infinity);
  });

  it("places a band where its section is displayed: its cover's vertical motion, its target once settled", () => {
    // B's band is open; opening A above it moves B's section down.
    const before = sceneFor([B]), after = sceneFor([A, B]);
    const p = retargetPresentation(samplePresentation(staticPresentation(before), Infinity), after, diffScenes(before, after), { transaction: 1, epoch: 1 });
    const top = after.graphs.get(B)!.origin.y, cover = after.records.get(entityId("tile", B, B))!;
    const was = before.records.get(entityId("tile", B, B))!.rect.y;
    expect(cover.rect.y).toBeGreaterThan(was);
    expect(bandTopAt(p, B, top, 0)).toBeCloseTo(top - (cover.rect.y - was), 6);
    const middle = bandTopAt(p, B, top, MOTION_MS / 2);
    expect(middle).toBeGreaterThan(top - (cover.rect.y - was));
    expect(middle).toBeLessThan(top);
    expect(bandTopAt(p, B, top, MOTION_MS)).toBeCloseTo(top, 6);
    expect(bandTopAt(p, B, top, Infinity)).toBeCloseTo(top, 6);
    expect(bandTopAt(settledPresentation(p), B, top, 0)).toBe(top);
    expect(bandTopAt(p, "missing", 123, 0)).toBe(123);
  });

  it("windows a band's canvas around the viewport where the band is displayed", () => {
    expect(bandWindow({ top: 1000, bottom: 1700 }, 900, 800)).toEqual({ top: -800, bottom: 1600 });
    // The same band displayed 500 px lower (its section mid-motion): the window moves up its canvas.
    expect(bandWindow({ top: 1000, bottom: 1700 }, 1400, 800)).toEqual({ top: -1200, bottom: 1200 });
    expect(bandWindow({ top: 1000, bottom: 1700 }, NaN, 800)).toBeNull();
  });
});
