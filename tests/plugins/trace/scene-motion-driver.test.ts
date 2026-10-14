/**
 * The rAF motion driver against fake render handles and a fake frame clock: what it writes on
 * each frame, what it gives back, and when it settles. No DOM: elements are inline-style bags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, type FolderScene, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { MOTION_MS, retargetPresentation, samplePresentation, staticPresentation, type Presentation } from "$lib/plugins/trace/view/presentation";
import { createSceneMotion, sceneMotionTesting } from "$lib/plugins/trace/view/scene-motion";
import { GRID, type RenderHandles } from "$lib/plugins/trace/view/render-handles";
import { folderInput, handCase, makeFolder, sourcesOf, type Folder } from "../../domain/trace-graph/folder-layout-fixtures";

const scope: SceneScope = { paneId: "p", directory: "/f", generation: 1 };
const plain: SceneStyling = { focus: null, selectedKeys: new Set(), selectedPaths: new Set(), badgeHover: null };
const tile = tileMetrics(96), grid = { cellWidth: tile.width, cellHeight: 0, gap: 8 };
const folder: Folder = makeFolder({ stacks: [handCase("screenshot"), handCase("merges-3")], files: 12 });
const [A, B] = [...folder.stacks.keys()];
function sceneFor(open: string[], previous: FolderLayout | null = null, width = 640): FolderScene {
  const input = folderInput(folder, { open, focus: null, width, tile, grid, previous });
  return buildFolderScene({ scope, layoutInput: input, layout: engines.default(input), sources: sourcesOf(folder), styling: plain });
}
let epochs = 0;
/** The presentation of `to` continuing from `from` displayed at `at`. */
const moving = (from: FolderScene, to: FolderScene, at = Infinity, before: Presentation = staticPresentation(from, ++epochs)) =>
  retargetPresentation(samplePresentation(before, at), to, diffScenes(from, to), { transaction: 1, epoch: ++epochs });

type Style = Record<"transform" | "opacity" | "clipPath" | "width" | "height", string>;
interface Fake { readonly style: Style }
const RENDERED: Style = { transform: "", opacity: "", clipPath: "", width: "10px", height: "20px" };

/** Handles that hand out an inline-style bag per key (as mounted renderers would), and no grid. */
function fakeHandles() {
  const elements = new Map<string, Fake>();
  const handles: RenderHandles = {
    attach: () => () => {},
    get: (key) => {
      if (key === GRID) return undefined;
      if (!elements.has(key)) elements.set(key, { style: { ...RENDERED } });
      return elements.get(key) as unknown as HTMLElement;
    },
  };
  return { handles, elements };
}

/** A frame clock: `frame(ms)` advances time and runs the pending frame callbacks. */
let now = 0;
let callbacks = new Map<number, FrameRequestCallback>();
let ids = 0;
function frame(ms: number): void {
  now += ms;
  const pending = callbacks;
  callbacks = new Map();
  for (const callback of pending.values()) callback(now);
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  now = 1000; callbacks = new Map(); ids = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++ids, callback); return ids; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  sceneMotionTesting.finish();
  sceneMotionTesting.release();
  sceneMotionTesting.setRate(1);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = sceneFor([A]), both = sceneFor([A, B], open.layout), closed = sceneFor([], open.layout);
/** Elements the driver moved (an inline value differs from the renderer's). */
const moved = (elements: Map<string, Fake>) => [...elements].filter(([, element]) => (Object.keys(RENDERED) as (keyof Style)[]).some((p) => element.style[p] !== RENDERED[p]));

describe("the rAF motion driver", () => {
  it("writes every first pose synchronously in start, shows them in its first frame, then follows the frame clock", () => {
    const { handles, elements } = fakeHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    const presentation = moving(open, both);
    const { started } = motion.start(presentation);
    expect(started).toBe(true);
    const first = new Map(moved(elements).map(([key, element]) => [key, { ...element.style }]));
    expect(first.size).toBeGreaterThan(0);
    expect(motion.displayedAt(presentation)).toBe(0);
    // The clock starts at the first frame, however late it comes: that frame shows the first poses.
    frame(70);
    expect(motion.displayedAt(presentation)).toBe(0);
    expect(moved(elements).map(([key, element]) => [key, { ...element.style }])).toEqual([...first]);
    frame(40);
    expect(motion.displayedAt(presentation)).toBe(40);
    // A sample is the presentation at the time displayed.
    expect(motion.sample(presentation).at).toBe(40);
    const changed = [...first].filter(([key, style]) => JSON.stringify(elements.get(key)!.style) !== JSON.stringify(style));
    expect(changed.length).toBeGreaterThan(0);
  });

  it("completes in the frame its duration elapses: live records given back, retirees kept at their final values, settled", async () => {
    const { handles, elements } = fakeHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    const presentation = moving(open, closed);
    const retirees = [...presentation.retiring.values()].filter((retiree) => retiree.track && retiree.group === null).map((retiree) => retiree.renderId);
    expect(retirees.length).toBeGreaterThan(0);
    const { settled } = motion.start(presentation);
    let result: boolean | null = null;
    void settled.then((finished) => { result = finished; });
    frame(16);
    frame(100);
    await flush();
    expect(result).toBeNull();
    frame(MOTION_MS);
    // Settled resolves from that frame: its reactions commit before the frame paints.
    await Promise.resolve();
    expect(result).toBe(true);
    expect(motion.displayedAt(presentation)).toBe(Infinity);
    for (const [key, element] of elements) {
      if (retirees.includes(key)) expect(element.style.opacity, key).toBe("0");
      else expect(element.style, key).toEqual(RENDERED);
    }
    // Idle: no frame requested.
    expect(callbacks.size).toBe(0);
  });

  it("an interruption cancels the running epoch, gives everything back and starts from the pose last written", async () => {
    const { handles, elements } = fakeHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    const first = moving(open, closed);
    const { settled } = motion.start(first);
    frame(16); frame(16); frame(16); frame(17);
    const displayed = motion.sample(first);
    expect(displayed.at).toBe(49);
    const second = retargetPresentation(displayed, both, diffScenes(closed, both), { transaction: 2, epoch: ++epochs });
    motion.start(second);
    expect(await settled).toBe(false);
    expect(motion.displayedAt(first)).toBe(Infinity);
    expect(motion.displayedAt(second)).toBe(0);
    // Exactly one frame loop runs.
    expect(callbacks.size).toBe(1);
    // Records the second epoch does not move are the renderer's again.
    const still = [...elements].filter(([key]) => !second.live.get(key)?.track && !second.retiring.get(key)?.track);
    expect(still.length).toBeGreaterThan(0);
  });

  it("keeps a value the renderer committed during the epoch when it gives the property back", () => {
    const { handles, elements } = fakeHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    motion.start(moving(open, both));
    const [key, element] = moved(elements).find(([, e]) => e.style.transform !== "")!;
    element.style.transform = "translate(1px, 2px)"; // the renderer commits meanwhile
    frame(16);
    frame(20);
    expect(element.style.transform).not.toBe("translate(1px, 2px)");
    frame(MOTION_MS);
    expect(elements.get(key)!.style.transform).toBe("translate(1px, 2px)");
  });

  it("snap ends the epoch and gives back every value, retirees' included", async () => {
    const { handles, elements } = fakeHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    const { settled } = motion.start(moving(open, closed));
    frame(16); frame(30);
    motion.snap();
    expect(await settled).toBe(false);
    for (const [key, element] of elements) expect(element.style, key).toEqual(RENDERED);
    expect(callbacks.size).toBe(0);
  });

  it("starts nothing under reduced motion or without a duration", async () => {
    const { handles, elements } = fakeHandles();
    const reduced = createSceneMotion({ handles, reduced: () => true });
    const result = reduced.start(moving(open, both));
    expect(result.started).toBe(false);
    expect(await result.settled).toBe(true);
    const plain = createSceneMotion({ handles, reduced: () => false });
    const still = plain.start(staticPresentation(both, ++epochs));
    expect(still.started).toBe(false);
    expect(moved(elements)).toEqual([]);
    expect(callbacks.size).toBe(0);
  });

  it("drives every view's epoch from one frame loop", () => {
    const one = fakeHandles(), two = fakeHandles();
    createSceneMotion({ handles: one.handles, reduced: () => false }).start(moving(open, both));
    createSceneMotion({ handles: two.handles, reduced: () => false }).start(moving(open, closed));
    expect(callbacks.size).toBe(1);
    expect(sceneMotionTesting.state().running).toHaveLength(2);
    frame(16);
    frame(MOTION_MS);
    expect(sceneMotionTesting.state().running).toHaveLength(0);
    expect(callbacks.size).toBe(0);
  });

  describe("test hooks", () => {
    it("hold pins new epochs at their first pose; seek shows a time synchronously; release runs on from there", async () => {
      const { handles, elements } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      sceneMotionTesting.hold();
      const presentation = moving(open, both);
      const { settled } = motion.start(presentation);
      const before = sceneMotionTesting.state().started;
      frame(500);
      expect(motion.displayedAt(presentation)).toBe(0);
      sceneMotionTesting.seek(80);
      expect(motion.displayedAt(presentation)).toBe(80);
      sceneMotionTesting.seek(10 * MOTION_MS);
      // Held at its end, not completed.
      expect(motion.displayedAt(presentation)).toBe(MOTION_MS);
      expect(sceneMotionTesting.state().running).toEqual([{ epoch: presentation.epoch, at: MOTION_MS, duration: MOTION_MS, held: true }]);
      sceneMotionTesting.seek(80);
      sceneMotionTesting.release();
      frame(40);
      expect(motion.displayedAt(presentation)).toBe(120);
      frame(40);
      expect(await settled).toBe(true);
      // Only connector layers (fill forwards) keep their final values; everything else is the renderer's.
      expect(moved(elements).map(([key]) => key).filter((key) => !key.startsWith("layer:"))).toEqual([]);
      expect(sceneMotionTesting.state().started).toBe(before);
    });

    it("finish completes held epochs; a slower rate stretches the clock", async () => {
      const { handles } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      sceneMotionTesting.setRate(.1);
      const presentation = moving(open, both);
      motion.start(presentation);
      frame(16); frame(100);
      expect(motion.displayedAt(presentation)).toBeCloseTo(10, 9);
      sceneMotionTesting.hold();
      const { settled } = motion.start(moving(open, closed));
      sceneMotionTesting.finish();
      expect(await settled).toBe(true);
    });
  });
});
