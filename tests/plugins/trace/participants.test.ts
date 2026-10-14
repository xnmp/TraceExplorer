import { describe, expect, it } from "vitest";
import { engines } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, entityId, type FolderScene, type SceneRecord, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import type { GridRect } from "$lib/domain/trace-graph/grid-flow";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { motionParticipants, PARTICIPANT_MARGIN } from "$lib/plugins/trace/view/participants";
import { MOTION_MS, restylePresentation, retargetPresentation, ridesWithSection, samplePresentation, sampleTrack, staticPresentation, type Presentation } from "$lib/plugins/trace/view/presentation";
import { ridesSection } from "$lib/plugins/trace/view/presentation-view";
import { folderInput, handCase, makeFolder, sourcesOf } from "../../domain/trace-graph/folder-layout-fixtures";

const scope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
// Two stacks first in the listing, then many files: opening the first stack moves everything below it.
const folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 60 });
const [A, B] = [...folder.stacks.keys()];

function sceneFor(open: string[], styling: Partial<SceneStyling> = {}): FolderScene {
  const input = folderInput(folder, { open, focus: styling.focus ?? null, width: 200, tile, grid, previous: null });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: { ...plain, ...styling } });
}
const settled = (scene: FolderScene) => samplePresentation(staticPresentation(scene), Infinity);
const rectOf = (scene: FolderScene, id: string) => scene.records.get(id)!.rect;
const coverId = (graph: string) => entityId("tile", graph, graph);
const top: GridRect = { x: 0, y: 0, width: 360, height: 300 };
let epochs = 0;
const retarget = (shown: ReturnType<typeof samplePresentation>, previous: FolderScene, next: FolderScene, records: ReadonlySet<string> | null) =>
  retargetPresentation(shown, next, diffScenes(previous, next), { transaction: ++epochs, epoch: epochs, records });

describe("motionParticipants", () => {
  const closed = sceneFor([]), opened = sceneFor([A]);

  it("lets every record move without a usable viewport", () => {
    expect(motionParticipants({ next: opened, displayed: settled(closed), viewport: null })).toBeNull();
    for (const viewport of [{ x: NaN, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: -1, height: 10 }, { x: 0, y: Infinity, width: 1, height: 1 }]) {
      expect(motionParticipants({ next: opened, displayed: settled(closed), viewport })).toBeNull();
    }
  });

  it("takes records whose target or displayed pose lies within the margin of the viewport, and no others", () => {
    const ids = motionParticipants({ next: opened, displayed: settled(closed), viewport: top })!;
    expect(ids.size).toBeGreaterThan(0);
    expect(ids.size).toBeLessThan(opened.records.size);
    const reach = top.y + top.height + PARTICIPANT_MARGIN;
    for (const [id, record] of opened.records) {
      const before = closed.records.get(id)?.rect;
      const near = record.rect.y <= reach || (!!before && before.y <= reach);
      expect(ids.has(id), `${id} at ${record.rect.y} (was ${before?.y})`).toBe(near);
    }
  });

  it("takes a record moving out of range by where it is displayed", () => {
    // Every file below the opened band moves down; one displayed at the margin's edge still takes part.
    const moved = [...opened.records.values()].find((record) => record.kind === "entry" && closed.records.get(record.id)!.rect.y < 400 && record.rect.y > 400);
    if (!moved) throw new Error("fixture: no entry moves past the margin");
    const ids = motionParticipants({ next: opened, displayed: settled(closed), viewport: { x: 0, y: 0, width: 360, height: 400 }, margin: 0 })!;
    expect(ids.has(moved.id)).toBe(true);
    expect(motionParticipants({ next: opened, displayed: null, viewport: { x: 0, y: 0, width: 360, height: 400 }, margin: 0 })!.has(moved.id)).toBe(false);
  });

  it("takes focused and selected records wherever they are", () => {
    const last = [...opened.entries.values()].at(-1)!;
    const styled = sceneFor([A], { focus: A, selectedPaths: new Set([last.entry.path]) });
    const far: GridRect = { x: 0, y: 1e6, width: 10, height: 10 };
    const ids = motionParticipants({ next: styled, displayed: settled(closed), viewport: far, margin: 0 })!;
    const selected = [...styled.records.values()].filter((record) => (record.kind === "entry" || record.kind === "tile") && record.selected);
    expect(selected.length).toBeGreaterThan(0);
    for (const record of selected) expect(ids.has(record.id)).toBe(true);
    expect(ids.has(coverId(A))).toBe(true);
    expect(ids.size).toBe(new Set([...selected.map((record) => record.id), coverId(A)]).size);
  });

  it("takes records still moving, but not those whose motion has ended", () => {
    const running = retarget(settled(closed), closed, opened, null);
    const moving = [...running.live.values()].filter((presented) => presented.track);
    expect(moving.length).toBeGreaterThan(0);
    const far: GridRect = { x: 0, y: 1e6, width: 10, height: 10 };
    const during = motionParticipants({ next: opened, displayed: samplePresentation(running, MOTION_MS / 2), viewport: far, margin: 0 })!;
    for (const presented of moving) expect(during.has(presented.renderId), presented.renderId).toBe(true);
    const after = motionParticipants({ next: opened, displayed: samplePresentation(running, MOTION_MS), viewport: far, margin: 0 })!;
    expect(after.size).toBe(0);
  });

  it("takes departing records by their displayed pose", () => {
    const ids = motionParticipants({ next: closed, displayed: settled(opened), viewport: top })!;
    const departing = [...opened.records.keys()].filter((id) => !closed.records.has(id));
    expect(departing.length).toBeGreaterThan(0);
    for (const id of departing) expect(ids.has(id)).toBe(rectOf(opened, id).y <= top.height + PARTICIPANT_MARGIN);
  });

  it("reads a non-finite or negative margin as none", () => {
    for (const margin of [NaN, -50, -Infinity]) {
      const ids = motionParticipants({ next: opened, displayed: null, viewport: { x: 0, y: 0, width: 1, height: 1 }, margin })!;
      for (const id of ids) {
        const rect = rectOf(opened, id);
        expect(rect.x <= 1 && rect.y <= 1, id).toBe(true);
      }
    }
  });
});

describe("presenting with participants", () => {
  // B's band is open; opening A above it moves B's section and every file down.
  const before = sceneFor([B]), after = sceneFor([A, B]);
  const cover = rectOf(before, coverId(B));
  // The viewport shows only the top of B's cover: its band tiles do not take part.
  const viewport: GridRect = { x: cover.x, y: cover.y, width: cover.width, height: cover.height / 4 };
  const shown = settled(before);
  const records = motionParticipants({ next: after, displayed: shown, viewport, margin: 0 })!;
  const presentation = retarget(shown, before, after, records);
  const bandRecords = [...after.records.values()].filter((record) => record.graphId === B && !(record.kind === "tile" && record.cover) && record.kind !== "band");

  it("moves participants and gives every other record its target pose", () => {
    expect(rectOf(after, coverId(B)).y).toBeGreaterThan(cover.y);
    expect(records.has(coverId(B))).toBe(true);
    expect(presentation.live.get(coverId(B))!.track).not.toBeNull();
    for (const [id, presented] of presentation.live) {
      if (records.has(id) || bandRecords.some((record) => record.id === id)) continue;
      expect(presented.track, id).toBeNull();
      expect(presented.initial.rect).toEqual(presented.record.rect);
    }
  });

  it("lets a non-participant band record ride with its section: no motion of its own, and not pinned", () => {
    expect(bandRecords.length).toBeGreaterThan(0);
    const frame = presentation.live.get(coverId(B))!;
    for (const record of bandRecords) {
      expect(records.has(record.id)).toBe(false);
      const presented = presentation.live.get(record.id)!;
      expect(ridesWithSection(presented.track, record.rect, frame.track, frame.record.rect), record.id).toBe(true);
      expect(ridesSection(presentation, record, presented.track), record.id).toBe(true);
      expect(presentation.pinned.has(record.id), record.id).toBe(false);
      // Sampled where it is displayed: its target, carried by the section's vertical motion.
      for (const at of [0, 40, MOTION_MS]) {
        const section = sampleTrack(frame.track!, at).rect.y - frame.record.rect.y;
        const pose = samplePresentation(presentation, at).poses.get(record.id)!;
        expect(pose.rect.x).toBeCloseTo(record.rect.x, 6);
        expect(pose.rect.y).toBeCloseTo(record.rect.y + section, 6);
        expect(pose.opacity).toBe(1);
      }
    }
  });

  it("pins exactly the moving participants and the retirees", () => {
    const expected = new Set([...presentation.live.values()].filter((presented) => presented.track && records.has(presented.renderId)).map((presented) => presented.renderId));
    for (const id of presentation.retiring.keys()) expected.add(id);
    expect(presentation.pinned).toEqual(expected);
  });

  it("retires nothing that does not take part", () => {
    const closing = retarget(settled(after), after, sceneFor([B]), new Set());
    expect(closing.retiring.size).toBe(0);
    expect([...closing.live.values()].filter((presented) => presented.track && !presented.record.graphId).length).toBe(0);
  });

  it("continues a rider from where it is displayed when it later takes part", () => {
    const at = 60, displayed = samplePresentation(presentation, at);
    const next = sceneFor([A]);
    const again = retarget(displayed, after, next, null);
    for (const [id, presented] of again.live) {
      const was = displayed.poses.get(id);
      if (!was || !presented.track || !after.records.has(id)) continue;
      const first = sampleTrack(presented.track, 0);
      if ((after.records.get(id) as SceneRecord).kind === "route") continue;
      expect(Math.abs(first.rect.y - was.rect.y), id).toBeLessThanOrEqual(.5);
      expect(Math.abs(first.rect.x - was.rect.x), id).toBeLessThanOrEqual(.5);
    }
  });

  it("keeps the epoch's pins through a restyle", () => {
    const restyled: Presentation = restylePresentation(presentation, sceneFor([A, B], { selectedPaths: new Set([[...after.entries.keys()][0]]) }));
    expect(restyled.pinned).toEqual(presentation.pinned);
  });
});
