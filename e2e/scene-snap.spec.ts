/**
 * Geometry the user did not initiate snaps (docs/scene-transactions.md, "Native findings fixes"):
 * arriving in a folder (startup, restore, returning after a settled expand), a width change
 * (resize, a scrollbar, a fullscreen preview widening the hidden pane and narrowing it on exit)
 * starts no motion, and the first frame drawn already shows the complete, final scene.
 *
 * Every frame is sampled just before it paints (`samplePaintedFrames`, in a ResizeObserver callback);
 * a frame records each mounted tile, cell and connector relative to the grid with its effective
 * opacity, the view's width, and the view's own running animations (CSS transitions and CSS
 * animations, such as spinners and selection borders, are not the scene's motion).
 */
import { expect, test, type Page } from "@playwright/test";
import { clearSceneEvents, samplePaintedFrames as sampleFrames, sceneEvents } from "./helpers/scene-events";
import { drawn, expectSnapped, navigateRemounting as navigate, now, scene, sceneFrame, setExpanded, toggleOf, type SceneFrame } from "./helpers/scene-frames";
import { openView, settle, uncaught } from "./support";

const DIRECTORY = "/pictures", MIRROR = "/pictures-mirror";

test.describe("arriving in a folder snaps", () => {
  // Native finding B: the first return after a settled expand replayed the expansion (52 effects,
  // band children at opacity 0, the next row at the collapsed position) for ~10 frames.
  test("returning after a settled expand shows the settled scene from the first frame", async ({ page }) => {
    await openView(page, 900, "", false);
    await setExpanded(page, 0, false);
    await toggleOf(page, 0).click();
    await expect(toggleOf(page, 0)).toHaveAttribute("aria-expanded", "true");
    await settle(page);
    await page.waitForTimeout(1500);
    const expanded = await now(page);
    await navigate(page, MIRROR);
    await expect.poll(async () => (await now(page)).directory).toBe(MIRROR);
    await settle(page);
    await clearSceneEvents(page);
    const frames = await sampleFrames(page, sceneFrame, 700, () => navigate(page, DIRECTORY));
    await settle(page);
    const settled = await now(page);
    // The return keeps the stack open (navigation cleared the selection, so only styling differs).
    await expect(toggleOf(page, 0)).toHaveAttribute("aria-expanded", "true");
    expect(Object.keys(settled.tiles).sort()).toEqual(Object.keys(expanded.tiles).sort());
    expectSnapped(frames.filter((frame) => frame.directory === DIRECTORY), settled, "return");
    expect(await sceneEvents(page, "motion-start")).toEqual([]);
    expect(await uncaught(page)).toEqual([]);
  });

  // Native finding S6: a folder switch 0–120 ms after a toggle arrived with 15–52 running effects
  // (an empty band gap, children fading in, then one frame of the stack collapsed again).
  for (const delay of [0, 40, 120]) {
    test(`a folder switch ${delay} ms after a toggle arrives without motion, both ways`, async ({ page }) => {
      await openView(page, 900, "", false);
      await setExpanded(page, 0, false);
      await navigate(page, MIRROR);
      await expect.poll(async () => drawn(await now(page))).toBe(true);
      await settle(page);
      await navigate(page, DIRECTORY);
      await expect.poll(async () => drawn(await now(page))).toBe(true);
      await settle(page);
      for (const [from, to] of [[DIRECTORY, MIRROR], [MIRROR, DIRECTORY], [DIRECTORY, MIRROR], [MIRROR, DIRECTORY]] as const) {
        await clearSceneEvents(page);
        const frames = await sampleFrames(page, sceneFrame, 900, async () => {
          await page.evaluate(({ delay, to }) => new Promise<void>((resolve) => {
            const toggle = document.querySelector<HTMLElement>("section[data-component] [data-stack-toggle]")!;
            toggle.click();
            setTimeout(() => {
              const trace = (window as any).trace;
              trace.leaveView();
              trace.navigate(to);
              requestAnimationFrame(() => { trace.enterView(); resolve(); });
            }, delay);
          }), { delay, to });
        });
        await settle(page);
        const settled = await now(page);
        expect(settled.directory).toBe(to);
        expectSnapped(frames.filter((frame) => frame.directory === to), settled, `${from} → ${to}`);
        expect((await sceneEvents(page, "motion-start")).filter((event) => event.scope === to), `${from} → ${to}: motion starts`).toEqual([]);
      }
      expect(await uncaught(page)).toEqual([]);
    });
  }

  test("a folder shown for the first time arrives complete and still", async ({ page }) => {
    await openView(page, 900);
    await navigate(page, MIRROR);
    await expect.poll(async () => drawn(await now(page))).toBe(true);
    await settle(page);
    await page.evaluate(() => (window as any).trace.forgetFolders());
    await clearSceneEvents(page);
    const frames = await sampleFrames(page, sceneFrame, 900, () => navigate(page, DIRECTORY));
    await settle(page);
    const settled = await now(page);
    expectSnapped(frames.filter((frame) => frame.directory === DIRECTORY), settled, "startup");
    expect(await sceneEvents(page, "motion-start")).toEqual([]);
  });
});

/** Changes the pane's width while sampling; returns frames at the new width only. */
async function widthFrames(page: Page, width: number, during: () => Promise<void> = async () => {}): Promise<{ frames: SceneFrame[]; settled: SceneFrame }> {
  const before = (await now(page)).width;
  const frames = await sampleFrames(page, sceneFrame, 700, async () => {
    await page.evaluate((width) => (window as any).trace.setWidth(width), width);
    await during();
  });
  await settle(page);
  const settled = await now(page);
  expect(settled.width).not.toBe(before);
  return { frames: frames.filter((frame) => frame.width === settled.width), settled };
}

test.describe("a width change snaps, and its first frame shows the layout for that width", () => {
  for (const [label, query] of [["small stacks, laid out inline", ""], ["a stack too large to lay out inline", "?anchorWorker"]] as const) {
    test(`resizing narrower and wider (${label})`, async ({ page }) => {
      await openView(page, 1100, query);
      for (const width of [760, 1250, 640, 1100]) {
        await clearSceneEvents(page);
        const { frames, settled } = await widthFrames(page, width);
        expectSnapped(frames, settled, `width ${width}`);
        expect(frames.every((frame) => frame.clipped === 0), `width ${width}: no frame cuts tiles at the pane's edge`).toBe(true);
        expect(await sceneEvents(page, "motion-start"), `width ${width}`).toEqual([]);
      }
      expect(await uncaught(page)).toEqual([]);
    });
  }

  // Native finding S7: while the fullscreen Preview covers it, the pane widens (1150 px) and the
  // view reflows underneath; on exit the first frame showed the wide layout clipped into the
  // narrow pane, then animated a 58-tile reflow.
  for (const query of ["", "?anchorWorker"]) {
    test(`a fullscreen-like widen and narrow returns to the narrow layout on its first frame${query ? " (worker)" : ""}`, async ({ page }) => {
      await openView(page, 870, query);
      const narrow = await now(page);
      await clearSceneEvents(page);
      await page.evaluate(() => (window as any).trace.setWidth(1158));
      await settle(page);
      const { frames, settled } = await widthFrames(page, 870);
      expect(scene(settled)).toEqual(scene(narrow));
      expectSnapped(frames, settled, "exit");
      expect(frames.every((frame) => frame.clipped === 0)).toBe(true);
      expect(await sceneEvents(page, "motion-start")).toEqual([]);
    });
  }

  test("while a wider layout is computed off the main thread, the previous scene stays as it was", async ({ page }) => {
    await openView(page, 900, "?anchorWorker");
    const before = await now(page);
    await clearSceneEvents(page);
    const { frames, settled } = await widthFrames(page, 1300, async () => {
      await page.evaluate(() => (window as any).trace.holdLayoutReplies());
      await page.waitForTimeout(250);
      await page.evaluate(() => (window as any).trace.releaseLayoutReplies());
    });
    for (const [index, frame] of frames.entries()) {
      expect(frame.owned, `frame ${index}`).toBe(0);
      expect([scene(before), scene(settled)], `frame ${index} shows one of the two scenes`).toContainEqual(scene(frame));
    }
    expect(await sceneEvents(page, "motion-start")).toEqual([]);
  });
});
