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
import { clearSceneEvents, samplePaintedFrames as sampleFrames, sceneBusy, sceneEvents } from "./helpers/scene-events";
import { drawn, expectHeldThenSnapped, expectSnapped, navigateRemounting as navigate, now, scene, sceneFrame, setExpanded, toggleOf, type SceneFrame } from "./helpers/scene-frames";
import { key, openView, settle, tile, uncaught } from "./support";

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

/**
 * Width variants: small stacks (laid out inline) or the fan with 40 more children (too large to lay
 * out inline: a widening goes to the worker), each without and with the host's grid padding
 * (`?fileTile=1`, padding 8: the scene is laid out for the width inside it).
 */
const VARIANTS = [
  { label: "small stacks, laid out inline", query: "", worker: false },
  { label: "small stacks, laid out inline, host grid padding", query: "?fileTile=1", worker: false },
  { label: "a stack too large to lay out inline", query: "?fanChildren=40", worker: true },
  { label: "a stack too large to lay out inline, host grid padding", query: "?fanChildren=40&fileTile=1", worker: true },
] as const;

/**
 * Changes the pane's width while sampling, holding worker replies for `hold` ms; returns the frames
 * at the new width only, the scene before, and how many layouts the change sent to the worker.
 * Sampling lasts until the view is no longer busy (`sceneBusy`), so a slow worker reply (a cold
 * worker on a loaded machine) is sampled through to its commit.
 */
async function widthFrames(page: Page, width: number, hold = 250): Promise<{ frames: SceneFrame[]; before: SceneFrame; settled: SceneFrame; workers: number }> {
  const before = await now(page);
  const sent = (): Promise<number> => page.evaluate(() => (window as any).trace.sentLayouts());
  const sentBefore = await sent();
  await page.evaluate(() => (window as any).trace.holdLayoutReplies());
  const frames = await sampleFrames(page, sceneFrame, 700 + hold, async () => {
    await page.evaluate((width) => (window as any).trace.setWidth(width), width);
    await page.waitForTimeout(hold);
    await page.evaluate(() => (window as any).trace.releaseLayoutReplies());
  }, sceneBusy);
  await settle(page);
  const settled = await now(page);
  // Requests posted, not replies held at `hold`: a reply can arrive after any fixed wait (the
  // worker's first job starts it, which can take hundreds of milliseconds on a loaded machine).
  const workers = await sent() - sentBefore;
  expect(settled.width).not.toBe(before.width);
  return { frames: frames.filter((frame) => frame.width === settled.width), before, settled, workers };
}

/** A width change commits one scene and never moves: laid out inline it is shown from the first frame; in the worker the previous scene stays until it commits. */
function expectWidthSnapped({ frames, before, settled, workers }: Awaited<ReturnType<typeof widthFrames>>, label: string): void {
  if (workers > 0) expectHeldThenSnapped(frames, before, settled, label);
  else expectSnapped(frames, settled, label);
  expect(frames.every((frame) => frame.clipped === 0), `${label}: no frame cuts tiles at the pane's edge`).toBe(true);
}

test.describe("a width change snaps, and its first frame shows the layout for that width", () => {
  for (const { label, query, worker } of VARIANTS) {
    test(`resizing narrower and wider (${label})`, async ({ page }) => {
      await openView(page, 1100, query);
      const workers: number[] = [];
      let width = (await now(page)).width;
      for (const next of [760, 1000, 1250, 640, 1100]) {
        await clearSceneEvents(page);
        const step = await widthFrames(page, next);
        expectWidthSnapped(step, `width ${next}`);
        // A pane narrowed past the scene on screen is laid out before its next paint, whatever the workload.
        if (next < width) expect(step.workers, `width ${next}: narrowing waited for the worker`).toBe(0);
        workers.push(step.workers);
        width = step.settled.width;
        expect(await sceneEvents(page, "motion-start"), `width ${next}`).toEqual([]);
      }
      if (worker) expect(workers.some((count) => count > 0), `the worker laid out a widening (${workers})`).toBe(true);
      expect(await uncaught(page)).toEqual([]);
    });
  }

  // Native finding S7: while the fullscreen Preview covers it, the pane widens (1150 px) and the
  // view reflows underneath; on exit the first frame showed the wide layout clipped into the
  // narrow pane, then animated a 58-tile reflow.
  for (const { label, query, worker } of VARIANTS) {
    test(`a fullscreen-like widen and narrow returns to the narrow layout on its first frame (${label})`, async ({ page }) => {
      await openView(page, 870, query);
      const narrow = await now(page);
      await clearSceneEvents(page);
      const widen = await widthFrames(page, 1158);
      expectWidthSnapped(widen, "enter");
      if (worker) expect(widen.workers, "the widened pane was laid out in the worker").toBeGreaterThan(0);
      const exit = await widthFrames(page, 870);
      expect(scene(exit.settled)).toEqual(scene(narrow));
      expect(exit.workers, "the exit waited for the worker").toBe(0);
      expectSnapped(exit.frames, exit.settled, "exit");
      expect(exit.frames.every((frame) => frame.clipped === 0)).toBe(true);
      expect(await sceneEvents(page, "motion-start")).toEqual([]);
    });
  }

  test("while a wider layout is computed off the main thread, the previous scene stays as it was", async ({ page }) => {
    await openView(page, 900, "?fanChildren=40");
    await clearSceneEvents(page);
    const step = await widthFrames(page, 1300);
    expect(step.workers, "the wider layout went to the worker").toBeGreaterThan(0);
    expectHeldThenSnapped(step.frames, step.before, step.settled, "widen");
    expect(step.frames.some((frame) => JSON.stringify(scene(frame)) !== JSON.stringify(scene(step.settled))), "the previous scene was shown while the worker was held").toBe(true);
    expect(await sceneEvents(page, "motion-start")).toEqual([]);
  });

  // The worker starts with the view, so the first layout heavy enough for it (here a widening of
  // small stacks laid out inline so far) does not also wait for it to start: a cold start took
  // 130-700 ms on a loaded machine, all of it with the previous scene held.
  test("the layout worker starts with the view, before the first layout that needs it", async ({ page }) => {
    type Started = { created: number; sentBefore: number; firstSent: number | null };
    const workers = () => page.evaluate(() => (window as any).trace.layoutWorkers() as Started[]);
    await openView(page, 870);
    await expect.poll(async () => (await workers()).length, { message: "a worker started with the view" }).toBe(1);
    expect((await workers())[0].firstSent, "opening laid everything out inline").toBeNull();
    const asked = await page.evaluate(() => performance.now());
    const step = await widthFrames(page, 1158);
    expect(step.workers, "the widening went to the worker").toBeGreaterThan(0);
    const [started, ...more] = await workers();
    expect(more, "no other worker was started").toEqual([]);
    expect(started.created, "the worker was running before the widening asked for it").toBeLessThan(asked);
    expect(started.firstSent!, "the widening was its first layout").toBeGreaterThan(asked);
    expectWidthSnapped(step, "widen");
  });
});

// Review of dc33274 (R6b): motion follows what changed, not which transaction commits. A click
// while a widened pane waits for the worker commits with the new width, so it snaps.
test("a click while a widened pane waits for the worker commits the click and the width at once, without motion", async ({ page }) => {
  await openView(page, 760, "?fanChildren=40");
  const narrow = (await now(page)).width;
  await clearSceneEvents(page);
  await page.evaluate(() => (window as any).trace.holdLayoutReplies());
  await page.evaluate(() => (window as any).trace.setWidth(1000));
  await expect.poll(() => page.evaluate(() => (window as any).trace.heldLayoutReplies().length), { message: "the wider layout went to the worker" }).toBeGreaterThan(0);
  // Focusing daylight widens its graph: the click changes the layout.
  await (await tile(page, "daylight")).click();
  await page.evaluate(() => (window as any).trace.releaseLayoutReplies());
  await settle(page);
  expect((await now(page)).width).toBeGreaterThan(narrow);
  expect(await page.locator(`[data-tile-key="${await key(page, "daylight")}"]`).getAttribute("aria-selected")).toBe("true");
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});
