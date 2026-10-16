import { routeShape } from "$lib/domain/trace-graph/path-sampling";
/**
 * The rAF motion driver against fake render handles and a fake frame clock: what it writes on
 * each frame, what it gives back, and when it settles. No DOM: elements are inline-style bags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engines, type FolderLayout } from "$lib/domain/trace-graph/folder-layout";
import { buildFolderScene, diffScenes, type FolderScene, type SceneRecord, type SceneScope, type SceneStyling } from "$lib/domain/trace-graph/folder-scene";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { MOTION_MS, posePath, retargetTrack, retargetPresentation, samplePresentation, staticPresentation, type Presentation } from "$lib/plugins/trace/view/presentation";
import v8 from "node:v8";
import vm from "node:vm";
import { createSceneMotion, FIRST_INTERVAL, sceneMotionTesting } from "$lib/plugins/trace/view/scene-motion";
import { onFrame } from "$lib/plugins/trace/view/frame-loop";
import { createRenderHandles, sectionKey, GRID, layerKey, type RenderHandles } from "$lib/plugins/trace/view/render-handles";
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
      if (!elements.has(key)) elements.set(key, { style: { ...RENDERED }, querySelector: () => null } as Fake);
      return elements.get(key) as unknown as HTMLElement;
    },
  };
  return { handles, elements };
}

/** A frame clock: `frame(ms)` advances time and runs the pending frame callbacks. */
let now = 0;
let callbacks = new Map<number, FrameRequestCallback>();
let ids = 0;
/** Frames requested from the browser so far. */
let requests = 0;
function frame(ms: number): void {
  now += ms;
  const pending = callbacks;
  callbacks = new Map();
  for (const callback of pending.values()) callback(now);
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  now = 1000; callbacks = new Map(); ids = 0; requests = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { requests++; callbacks.set(++ids, callback); return ids; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  sceneMotionTesting.finish();
  sceneMotionTesting.release();
  sceneMotionTesting.setRate(1);
  // The loop ends at its next frame once nothing runs.
  for (let i = 0; i < 3 && callbacks.size; i++) frame(16);
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
    frame(16);
    expect(motion.displayedAt(presentation)).toBe(16);
    // A sample is the presentation at the time displayed.
    expect(motion.sample(presentation).at).toBe(16);
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
    const before = requests;
    motion.start(second);
    // The restart keeps the frame already requested: it never re-queues behind other frame callbacks.
    expect(requests).toBe(before);
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
    // The frame already requested passes, and requests no other.
    frame(16);
    expect(callbacks.size).toBe(0);
    for (const [key, element] of elements) expect(element.style, key).toEqual(RENDERED);
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
    frame(16);
    frame(MOTION_MS);
    expect(sceneMotionTesting.state().running).toHaveLength(0);
    expect(callbacks.size).toBe(0);
  });

  it("one view's snap ends only its own epoch; the loop runs on for the others", async () => {
    const one = fakeHandles(), two = fakeHandles();
    const a = createSceneMotion({ handles: one.handles, reduced: () => false });
    const b = createSceneMotion({ handles: two.handles, reduced: () => false });
    const pa = moving(open, both), pb = moving(open, closed);
    a.start(pa);
    const { settled } = b.start(pb);
    frame(16); frame(16);
    a.snap();
    expect(sceneMotionTesting.state().running.map((r) => r.epoch)).toEqual([pb.epoch]);
    frame(16);
    expect(b.displayedAt(pb)).toBe(32);
    frame(MOTION_MS);
    expect(await settled).toBe(true);
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
      // The next frame shows the time it was held at, and the clock runs on from that frame.
      frame(40);
      expect(motion.displayedAt(presentation)).toBe(80);
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
      frame(16); frame(16); frame(100);
      expect(motion.displayedAt(presentation)).toBeCloseTo(11.6, 9);
      sceneMotionTesting.hold();
      const { settled } = motion.start(moving(open, closed));
      sceneMotionTesting.finish();
      expect(await settled).toBe(true);
    });
  });

  describe("frame phases", () => {
    it("listeners of the scroll and read phases see the poses of their frame, after every view wrote, also after an interruption", () => {
      const one = fakeHandles(), two = fakeHandles();
      const a = createSceneMotion({ handles: one.handles, reduced: () => false });
      const b = createSceneMotion({ handles: two.handles, reduced: () => false });
      const styles = () => JSON.stringify([[...one.elements].map(([key, e]) => [key, { ...e.style }]), [...two.elements].map(([key, e]) => [key, { ...e.style }])]);
      const seen: { phase: string; styles: string; at: number }[] = [];
      let shown: Presentation = moving(open, closed);
      const stops = [onFrame("read", () => seen.push({ phase: "read", styles: styles(), at: a.displayedAt(shown) })),
        onFrame("scroll", () => seen.push({ phase: "scroll", styles: styles(), at: a.displayedAt(shown) }))];
      try {
        a.start(shown); b.start(moving(open, both));
        frame(16); frame(16); frame(16);
        // Interrupted between frames: the next epoch starts from the pose on screen.
        const next = retargetPresentation(a.sample(shown), both, diffScenes(closed, both), { transaction: 2, epoch: ++epochs });
        a.start(next);
        shown = next;
        for (let i = 0; i < 4; i++) {
          seen.length = 0;
          frame(16);
          // Scroll first, then read; each sees exactly what the frame shows once its callbacks ran.
          expect(seen.map((s) => s.phase)).toEqual(["scroll", "read"]);
          for (const entry of seen) expect(entry.styles).toBe(styles());
          expect(seen[0].at).toBe(a.displayedAt(next));
        }
        expect(a.displayedAt(next)).toBe(48);
      } finally { for (const stop of stops) stop(); }
    });

    it("seek and finish run the later phases at once, so what follows motion sees the poses before the next frame", () => {
      const { handles, elements } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const seen: string[] = [];
      const stop = onFrame("scroll", () => seen.push(JSON.stringify([...elements].map(([, e]) => e.style))));
      try {
        sceneMotionTesting.hold();
        motion.start(moving(open, both));
        sceneMotionTesting.seek(80);
        expect(seen).toEqual([JSON.stringify([...elements].map(([, e]) => e.style))]);
        sceneMotionTesting.finish();
        expect(seen).toHaveLength(2);
        expect(seen[1]).toBe(JSON.stringify([...elements].map(([, e]) => e.style)));
      } finally { stop(); }
    });
  });

  describe("the epoch clock", () => {
    it("counts a first interval longer than a frame or so as one frame (the first frame renders the publication)", () => {
      const { handles } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const presentation = moving(open, both);
      motion.start(presentation);
      frame(16);
      frame(117);
      expect(motion.displayedAt(presentation)).toBeCloseTo(FIRST_INTERVAL.assumed, 9);
      frame(16);
      expect(motion.displayedAt(presentation)).toBeCloseTo(FIRST_INTERVAL.assumed + 16, 9);
    });

    it("keeps a first interval of a frame, and every later interval in full: stalled time is never dropped", () => {
      const { handles } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const presentation = moving(open, both);
      motion.start(presentation);
      frame(16);
      frame(FIRST_INTERVAL.threshold);
      expect(motion.displayedAt(presentation)).toBe(FIRST_INTERVAL.threshold);
      frame(85);
      expect(motion.displayedAt(presentation)).toBe(FIRST_INTERVAL.threshold + 85);
    });

    it("a released epoch shows the time it was held at in its next frame, whatever that frame's timestamp, then runs on", () => {
      const { handles } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const presentation = moving(open, both);
      sceneMotionTesting.hold();
      motion.start(presentation);
      sceneMotionTesting.seek(80);
      sceneMotionTesting.release();
      // The frame's timestamp is its start, before the task that released (performance.now()).
      now -= 5;
      frame(0);
      expect(motion.displayedAt(presentation)).toBe(80);
      frame(16);
      expect(motion.displayedAt(presentation)).toBe(96);
      // A slower rate runs on from the time displayed: never backwards, never a jump.
      sceneMotionTesting.setRate(.5);
      frame(16);
      expect(motion.displayedAt(presentation)).toBe(104);
      sceneMotionTesting.setRate(1);
      frame(16);
      expect(motion.displayedAt(presentation)).toBe(120);
    });
  });

  describe("a hidden document", () => {
    function fakeDocument(state: DocumentVisibilityState) {
      const document = Object.assign(new EventTarget(), { visibilityState: state });
      vi.stubGlobal("document", document);
      return {
        hide() { document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); },
        show() { document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); },
      };
    }

    it("starts no motion while hidden: the final state shows at once and settles", async () => {
      fakeDocument("hidden");
      const { handles, elements } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const result = motion.start(moving(open, closed));
      expect(result.started).toBe(false);
      expect(await result.settled).toBe(true);
      expect(moved(elements)).toEqual([]);
      expect(callbacks.size).toBe(0);
    });

    it("completes a running epoch when the document hides, without waiting for frames; nothing replays on return", async () => {
      const visibility = fakeDocument("visible");
      const { handles, elements } = fakeHandles();
      const motion = createSceneMotion({ handles, reduced: () => false });
      const presentation = moving(open, closed);
      const retirees = [...presentation.retiring.values()].filter((retiree) => retiree.track && retiree.group === null).map((retiree) => retiree.renderId);
      const { settled } = motion.start(presentation);
      frame(16); frame(16);
      let result: boolean | null = null;
      void settled.then((finished) => { result = finished; });
      visibility.hide();
      await Promise.resolve();
      expect(result).toBe(true);
      expect(motion.displayedAt(presentation)).toBe(Infinity);
      for (const [key, element] of elements) {
        if (retirees.includes(key)) expect(element.style.opacity, key).toBe("0");
        else if (!key.startsWith("layer:")) expect(element.style, key).toEqual(RENDERED);
      }
      const shown = JSON.stringify([...elements]);
      visibility.show();
      frame(16); frame(16);
      expect(JSON.stringify([...elements])).toBe(shown);
      expect(sceneMotionTesting.state().running).toEqual([]);
    });
  });

  it("holds no completed epoch's elements: a retiree that unmounted can be collected", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const mounted = new Map<string, Fake>();
    const handles: RenderHandles = {
      attach: () => () => {},
      get: (key) => {
        if (key === GRID) return undefined;
        if (!mounted.has(key)) mounted.set(key, { style: { ...RENDERED }, querySelector: () => null } as Fake);
        return mounted.get(key) as unknown as HTMLElement;
      },
    };
    const motion = createSceneMotion({ handles, reduced: () => false });
    let presentation: Presentation | null = moving(open, closed);
    const keys = [...presentation.retiring.values()].filter((retiree) => retiree.track && retiree.group === null).map((retiree) => retiree.renderId);
    expect(keys.length).toBeGreaterThan(0);
    const { settled } = motion.start(presentation);
    presentation = null;
    frame(16); frame(16); frame(MOTION_MS);
    expect(await settled).toBe(true);
    // The settled scene unmounts its retirees.
    const retirees = keys.map((key) => new WeakRef(mounted.get(key)!));
    for (const key of keys) mounted.delete(key);
    await flush();
    gc();
    expect(retirees.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
    // Elements still mounted keep their final values until the next epoch or snap gives them back.
    motion.snap();
    for (const [key, element] of mounted) expect(element.style, key).toEqual(RENDERED);
  });

  /** Handles whose elements throw on the first transform write once `arm()`ed. */
  function fragileHandles() {
    let armed = false;
    const elements = new Map<string, Fake>();
    const handles: RenderHandles = {
      attach: () => () => {},
      get: (key) => {
        if (key === GRID) return undefined;
        if (!elements.has(key)) {
          const style = { ...RENDERED };
          let transform = style.transform;
          Object.defineProperty(style, "transform", { enumerable: true, get: () => transform,
            set: (value: string) => { if (armed) { armed = false; throw new Error("renderer gone"); } transform = value; } });
          elements.set(key, { style, querySelector: () => null } as Fake);
        }
        return elements.get(key) as unknown as HTMLElement;
      },
    };
    return { handles, elements, arm: () => { armed = true; } };
  }

  it("a view whose frame throws snaps to its target scene and settles; the loop runs on for every other view", async () => {
    const report = vi.fn();
    vi.stubGlobal("reportError", report);
    const { handles, elements: fragile, arm } = fragileHandles();
    const other = fakeHandles();
    const failing = createSceneMotion({ handles, reduced: () => false });
    const healthy = createSceneMotion({ handles: other.handles, reduced: () => false });
    const pf = moving(open, both), ph = moving(open, closed);
    const failed = failing.start(pf), running = healthy.start(ph);
    frame(16); frame(16);
    arm();
    frame(16);
    expect(await failed.settled).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    for (const [key, element] of fragile) expect(element.style, key).toEqual(RENDERED);
    expect(sceneMotionTesting.state().running.map((r) => r.epoch)).toEqual([ph.epoch]);
    expect(healthy.displayedAt(ph)).toBe(32);
    frame(MOTION_MS);
    expect(await running.settled).toBe(true);
    expect(failing.displayedAt(pf)).toBe(Infinity);
  });

  it("an epoch whose final frame throws still settles, with its view's renderer values", async () => {
    vi.stubGlobal("reportError", vi.fn());
    const { handles, elements, arm } = fragileHandles();
    const motion = createSceneMotion({ handles, reduced: () => false });
    const { settled } = motion.start(moving(open, both));
    frame(16); frame(16);
    arm();
    frame(MOTION_MS);
    expect(await settled).toBe(true);
    for (const [key, element] of elements) expect(element.style, key).toEqual(RENDERED);
    expect(sceneMotionTesting.state().running).toEqual([]);
  });
});


describe("SVG path ownership", () => {
  const base = { x: 0, y: 0, width: 100, height: 100 };
  const original = "M0 0 L100 100", target = "M0 0 L100 50";
  const routePose = (path: string) => ({ rect: base, opacity: 1, clip: null, shape: routeShape(path, base)! });
  const track = retargetTrack(routePose(original), routePose(target))!;
  const record = { kind: "route", id: "r", graphId: "g", rect: base, route: { path: target } } as SceneRecord;
  const presentation = (epoch: number): Presentation => ({ epoch, duration: MOTION_MS,
    live: new Map([["r", { renderId: "r", record, initial: track.frames[0].pose, track }]]), retiring: new Map(), pinned: new Set(["r"]) });
  function setup() {
    let d = target;
    const path = { style: {}, getAttribute: () => d, setAttribute: (_key: string, value: string) => { d = value; } };
    const layer = { style: {}, querySelector: () => path };
    const driver = createSceneMotion({ reduced: () => false, handles: {
      get: key => key === layerKey("r") ? layer as unknown as HTMLElement : undefined, attach: () => () => {},
    } });
    return { driver, get: () => d, set: (value: string) => { d = value; } };
  }

  it("owns and restores SVG d on snap, interruption and completion", async () => {
    sceneMotionTesting.hold();
    const { driver, get } = setup();
    try {
      const first = driver.start(presentation(1));
      expect(get()).toBe(posePath(track.frames[0].pose, base));
      sceneMotionTesting.seek(40);
      expect(get()).not.toBe(target);
      const second = driver.start(presentation(2));
      await expect(first.settled).resolves.toBe(false);
      expect(get()).toBe(posePath(track.frames[0].pose, base));
      sceneMotionTesting.finish();
      await expect(second.settled).resolves.toBe(true);
      expect(get()).toBe(posePath(track.frames[1].pose, base));
      driver.snap();
      expect(get()).toBe(target);
    } finally { driver.snap(); sceneMotionTesting.release(); }
  });

  it("preserves renderer d committed during motion", () => {
    sceneMotionTesting.hold();
    const { driver, get, set } = setup();
    try {
      driver.start(presentation(3));
      set("M9 9 L10 10");
      driver.snap();
      expect(get()).toBe("M9 9 L10 10");
      driver.start(presentation(4));
      set("M8 8 L11 11");
      sceneMotionTesting.seek(40);
      driver.snap();
      expect(get()).toBe("M8 8 L11 11");
    } finally { driver.snap(); sceneMotionTesting.release(); }
  });
});


it("keeps the route and tile copies of a section on the same motion clock and releases both", () => {
  const handles = createRenderHandles();
  const copies = [{ style: { ...RENDERED } }, { style: { ...RENDERED } }];
  const record = open.tiles.get(JSON.stringify(["tile", A, A]))!;
  const to = { rect: record.rect, opacity: 1, clip: null };
  const track = retargetTrack({ ...to, rect: { ...to.rect, y: to.rect.y + 100 } }, to)!;
  const presented = { renderId: record.id, record, initial: track.frames[0].pose, track };
  const p: Presentation = { epoch: ++epochs, duration: MOTION_MS, live: new Map([[record.id, presented]]), retiring: new Map(), pinned: new Set([record.id]) };
  const detach = copies.map(copy => handles.attach(sectionKey(A))(copy as unknown as HTMLElement));
  const motion = createSceneMotion({ handles, reduced: () => false });
  motion.start(p);
  expect(copies[0].style.transform).not.toBe("");
  for (const ms of [0, 8, 25, 40]) { frame(ms); expect(copies[0].style).toEqual(copies[1].style); }
  motion.snap();
  for (const copy of copies) expect(copy.style).toEqual(RENDERED);
  detach[0]?.();
  expect(handles.get(sectionKey(A))).toBe(copies[1]);
  detach[1]?.();
  expect(handles.get(sectionKey(A))).toBeUndefined();
});
