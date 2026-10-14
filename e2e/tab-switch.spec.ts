import { expect, test, type Page } from "@playwright/test";
import { awaitAnimationsCreated, holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";
import { clearSceneEvents, samplePaintedFrames, sampleFrames, sceneEvents } from "./helpers/scene-events";
import { openView, settle, uncaught } from "./support";

// Switching to another tab unmounts the Trace view; switching back mounts a new one.
test("returning to a Trace tab shows its graph at once, without Loading Trace…", async ({ page }) => {
  await openView(page, 1400);
  const openStacks = await page.locator('[data-stack-toggle][aria-expanded="true"]').evaluateAll((elements) =>
    elements.map((element) => element.closest("[data-grid-cell]")!.getAttribute("data-grid-cell")).sort());
  expect(openStacks.length).toBeGreaterThanOrEqual(2);
  const tileKeys = await page.locator("[data-tile-key]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-tile-key")).sort());
  const tiles = tileKeys.length;
  expect(tiles).toBeGreaterThan(0);

  await page.evaluate(() => (window as any).trace.leaveView());
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  // Folder reads now take a native IPC round trip, so a fresh load would show its loading state.
  await page.evaluate(() => {
    (window as any).trace.backend.setFolderLatency(600);
    const w = window as any; w.__loadingSeen = false;
    new MutationObserver(() => { if (document.body.textContent?.includes("Loading Trace…")) w.__loadingSeen = true; })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const shownAt = await page.evaluate(async ({ tiles, openStacks }) => {
    const start = performance.now();
    (window as any).trace.enterView();
    while (document.querySelectorAll("[data-tile-key]").length !== tiles
      || JSON.stringify([...document.querySelectorAll('[data-stack-toggle][aria-expanded="true"]')]
        .map((element) => element.closest("[data-grid-cell]")!.getAttribute("data-grid-cell")).sort()) !== JSON.stringify(openStacks)) {
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  }, { tiles, openStacks });
  // Shown from what the previous view loaded, well before the 600 ms reads return.
  expect(shownAt).toBeLessThan(300);
  await expect(page.locator("[data-tile-key]")).toHaveCount(tiles);
  expect(await page.locator("[data-tile-key]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-tile-key")).sort())).toEqual(tileKeys);
  // Revalidation completes in the background and keeps the graph in place.
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-tile-key]")).toHaveCount(tiles);
  expect(await page.evaluate(() => (window as any).__loadingSeen)).toBe(false);
});

test("a tab showing a different folder never starts from this folder's graph", async ({ page }) => {
  await openView(page, 1400);
  await page.evaluate(() => (window as any).trace.leaveView());
  await page.evaluate(() => { (window as any).trace.backend.setFolderLatency(600); (window as any).trace.navigate("/pictures-mirror"); (window as any).trace.enterView(); });
  // The mirror reuses this folder's component ids, so only the folder key keeps them apart: nothing is drawn until its own reads return.
  await expect(page.getByRole("status").filter({ hasText: "Loading Trace…" })).toBeVisible();
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});

test("returning at another width lays the kept data out again and snaps, without a loading frame", async ({ page }) => {
  await openView(page, 1400);
  const columns = await page.getByRole("grid", { name: "Folder", exact: true }).getAttribute("aria-colcount");
  const tiles = await page.locator("[data-tile-key]").count();
  await page.evaluate(() => (window as any).trace.leaveView());
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await clearSceneEvents(page);
  await page.evaluate(() => { const t = (window as any).trace; t.backend.setFolderLatency(600); t.setWidth(700); });
  const frames = await sampleFrames(page, () => ({
    loading: document.body.textContent?.includes("Loading Trace…") ?? false,
    tiles: document.querySelectorAll("[data-tile-key]").length,
    moving: document.getAnimations().filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return !(target instanceof Element && target.closest(".spinner, .title-spinner"));
    }).length,
    time: performance.now(),
  }), 500, async () => { await page.evaluate(() => { (window as any).__entered = performance.now(); (window as any).trace.enterView(); }); });
  const entered = await page.evaluate(() => (window as any).__entered as number);
  const shown = frames.find((frame) => frame.tiles > 0);
  expect(shown, "the folder is shown").toBeDefined();
  expect(shown!.time - entered).toBeLessThan(300);
  expect(frames.some((frame) => frame.loading), "no loading frame").toBe(false);
  expect(frames.every((frame) => frame.moving === 0), "the new layout snaps").toBe(true);
  expect(await page.getByRole("grid", { name: "Folder", exact: true }).getAttribute("aria-colcount")).not.toBe(columns);
  expect((await sceneEvents(page, "motion-start"))).toEqual([]);
  await expect.poll(() => page.locator("[data-tile-key]").count()).toBeGreaterThan(0);
  expect(tiles).toBeGreaterThan(0);
  expect(await uncaught(page)).toEqual([]);
});

test("returning at the same width shows the kept scene as it was: no layout, no motion", async ({ page }) => {
  await openView(page, 1400);
  const boxes = () => page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]')!.getBoundingClientRect();
    return Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => {
      const box = tile.getBoundingClientRect();
      return [tile.dataset.tileKey!, [Math.round(box.left - grid.left), Math.round(box.top - grid.top), Math.round(box.width)]];
    }));
  });
  const before = await boxes();
  await page.evaluate(() => (window as any).trace.leaveView());
  await clearSceneEvents(page);
  await page.evaluate(() => (window as any).trace.enterView());
  await expect.poll(() => page.locator("[data-tile-key]").count()).toBe(Object.keys(before).length);
  expect(await boxes()).toEqual(before);
  await settle(page);
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
  // The restored scene is the first publication; revalidating it against the same data publishes no geometry.
  expect(await sceneEvents(page, "geometry-publication")).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).trace.layoutsPending())).toBe(0);
});

// Review 099e72f: the restored scene was committed with the selection it was saved with, and the
// pane's current one landed a frame later. The first painted frame must already show the pane's own.
for (const [label, pick] of [["a tile in an open stack", 12], ["the last listed item", -1]] as const) {
  test(`returning after the selection changed elsewhere shows it from the first frame (${label})`, async ({ page }) => {
    await openView(page, 1400);
    const paths: string[] = await page.evaluate(() => (window as any).trace.listing().map((entry: { path: string }) => entry.path));
    await page.evaluate((path) => (window as any).trace.selectPath(path), paths[0]);
    await settle(page);
    await page.evaluate(() => (window as any).trace.leaveView());
    await expect(page.locator("[data-tile-key]")).toHaveCount(0);
    await page.evaluate((path) => (window as any).trace.selectPath(path), paths.at(pick)!);
    await page.evaluate(() => (window as any).trace.backend.setFolderLatency(600));
    await clearSceneEvents(page);
    const selection = () => ({
      selected: [...document.querySelectorAll('[aria-selected="true"]')]
        .map((element) => element.getAttribute("data-tile-key") ?? element.closest("[data-grid-cell]")?.getAttribute("data-grid-cell") ?? "?").sort(),
      tiles: document.querySelectorAll("[data-tile-key]").length,
      entered: !!(window as any).__entered,
    });
    // A layout the return needs replies late (a slow worker), so a stale first scene would stay on screen meanwhile.
    await page.evaluate(() => (window as any).trace.holdLayoutReplies());
    const frames = await sampleFrames(page, selection, 1200, async () => {
      // Every DOM state that holds tiles, not only sampled frames: a stale selection for part of a frame is caught too.
      await page.evaluate(() => {
        const w = window as any; w.__states = [];
        const read = () => [...document.querySelectorAll('[aria-selected="true"]')]
          .map((element) => element.getAttribute("data-tile-key") ?? element.closest("[data-grid-cell]")?.getAttribute("data-grid-cell") ?? "?").sort().join(",");
        new MutationObserver(() => { if (document.querySelectorAll("[data-tile-key]").length) w.__states.push(read()); })
          .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
        w.__entered = true;
        w.trace.enterView();
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => (window as any).trace.releaseLayoutReplies());
    });
    await settle(page);
    const now = await page.evaluate(selection);
    expect(now.selected.length).toBeGreaterThan(0);
    // From the return on, every frame shows the folder: none is blank.
    const returned = frames.filter((frame) => frame.entered).slice(1);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.filter((frame) => frame.tiles === 0).length, "blank frames after returning").toBe(0);
    expect(returned.filter((frame) => JSON.stringify(frame.selected) !== JSON.stringify(now.selected)), "frames showing a selection that is not the pane's").toEqual([]);
    const states: string[] = await page.evaluate(() => (window as any).__states);
    expect([...new Set(states)].filter((state) => state !== now.selected.join(",")), "DOM states with a selection that is not the pane's").toEqual([]);
    // The return snaps: nothing animates into the current scene.
    expect(await sceneEvents(page, "motion-start")).toEqual([]);
  });
}

const oldScope = () => {
  const retirees = document.querySelectorAll("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer], [data-ghost-tile-key]").length;
  // A cover's progress indicator (its spinner, faded in late) is the new view's own pending work, not an effect.
  const effects = document.getAnimations().filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return !(target instanceof Element && target.closest(".spinner, .title-spinner, .cover-progress"));
  }).length;
  return { switched: !!(window as any).__switched, retirees, effects, busy: document.querySelectorAll('[aria-busy="true"]').length };
};

/** Stack B closes (an exit group retiring, held mid-motion) while stack A's cold open waits for its held node reads. */
async function motionAndPendingWork(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, "?bandMotion=junction", false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`).evaluate((element: HTMLElement) => element.click());
  await toggle("b"); await settle(page);
  await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
  await toggle("a");
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.heldNodeReads().length)).toBeGreaterThan(0);
  await holdScriptedAnimations(page);
  await toggle("b");
  await awaitAnimationsCreated(page);
  await expect(page.locator("[data-grid-exit]")).not.toHaveCount(0);
  await clearSceneEvents(page);
}

test("switching folder during motion and pending work shows nothing of the old folder", async ({ page }) => {
  await motionAndPendingWork(page);
  try {
    const frames = await sampleFrames(page, oldScope, 500, async () => {
      await page.evaluate(() => { (window as any).__switched = true; (window as any).trace.navigate("/pictures-mirror"); });
    });
    const after = frames.filter((frame) => frame.switched);
    expect(after.length).toBeGreaterThan(5);
    for (const frame of after) expect(frame, "a frame after the switch").toEqual({ switched: true, retirees: 0, effects: 0, busy: 0 });
  } finally { await releaseScriptedAnimations(page); }
  // The old folder's reads complete: nothing of it is published.
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await settle(page);
  expect((await sceneEvents(page, "geometry-publication", "motion-start")).filter((event) => event.scope !== "/pictures-mirror")).toEqual([]);
  expect(await page.evaluate(oldScope)).toEqual({ switched: true, retirees: 0, effects: 0, busy: 0 });
  expect(await uncaught(page)).toEqual([]);
});

test("switching tab during motion and pending work shows no retirees or effects of the old view", async ({ page }) => {
  await motionAndPendingWork(page);
  try {
    const frames = await sampleFrames(page, oldScope, 500, async () => {
      await page.evaluate(() => { (window as any).trace.leaveView(); });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.evaluate(() => { (window as any).__switched = true; (window as any).trace.enterView(); });
    });
    const after = frames.filter((frame) => frame.switched);
    expect(after.length).toBeGreaterThan(5);
    for (const frame of after) expect({ retirees: frame.retirees, effects: frame.effects }, "a frame after returning").toEqual({ retirees: 0, effects: 0 });
    // The returned view shows the folder at once, from the last committed scene.
    await expect(page.locator("section[aria-label=\"stack-b\"] [data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
  } finally { await releaseScriptedAnimations(page); }
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await settle(page);
  // Only the new view's own work publishes: its re-requested open of stack A.
  await expect(page.locator("section[aria-label=\"stack-a\"] [data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

// Review 8d257bf: returning after the folder's index moved on (a refresh still reading when the
// pane left, or another pane advancing the shared folder snapshot) showed nothing, then
// "Loading Trace…". The saved scene is shown at once; the newer index snaps in after it.
test("returning after the folder changed while its refresh was still reading shows the folder on every frame", async ({ page }) => {
  await openView(page, 1400);
  const tiles = await page.locator("[data-tile-key]").count();
  await page.evaluate(() => { const backend = (window as any).trace.backend; backend.holdNodeReads(); backend.startGeneration("village", "while-away"); });
  // The session reads the new index, and its node pages wait.
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.heldNodeReads().length)).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.evaluate(() => (window as any).trace.leaveView());
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await clearSceneEvents(page);
  const frames = await samplePaintedFrames(page, () => ({ tiles: document.querySelectorAll("[data-tile-key]").length, loading: document.body.textContent!.includes("Loading Trace"), entered: !!(window as any).__entered }), 1200, async () => {
    await page.evaluate(() => { (window as any).__entered = true; (window as any).trace.enterView(); });
    await page.waitForTimeout(800);
    await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  });
  await settle(page);
  const returned = frames.filter((frame) => frame.entered);
  expect(returned.length).toBeGreaterThan(5);
  expect(returned.filter((frame) => frame.tiles === 0 || frame.loading), "blank or loading frames after returning").toEqual([]);
  expect(returned[0].tiles).toBe(tiles);
  // The new job's image arrives with the newer index, without motion (a refresh snaps).
  await expect(page.locator("[data-tile-key]")).toHaveCount(tiles + 1);
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});

// Review 8d257bf: a return whose current focus needs a band laid out in the worker showed nothing,
// then "Loading Trace…". The saved scene stays shown (a stale focus for a few frames) until the
// current scene commits, and snaps.
test("returning with a new focus inside a large open stack shows the saved scene until the current one is laid out", async ({ page }) => {
  await openView(page, 1400, "?revealLarge=1");
  const path = (name: string) => page.evaluate((name) => (window as any).trace.backend.path(name), name);
  const fan = page.locator('section[data-component][aria-label="fan"] [data-stack-toggle]');
  if (await fan.getAttribute("aria-expanded") !== "true") { await fan.click(); await settle(page); }
  await page.evaluate((path) => (window as any).trace.selectPath(path), await path("wide-3"));
  await settle(page);
  await page.evaluate(() => (window as any).trace.leaveView());
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  const target = await path("wide-60");
  await page.evaluate((path) => (window as any).trace.selectPath(path), target);
  await page.evaluate(() => (window as any).trace.holdLayoutReplies());
  await clearSceneEvents(page);
  const frames = await samplePaintedFrames(page, () => ({ tiles: document.querySelectorAll("[data-tile-key]").length, loading: document.body.textContent!.includes("Loading Trace"), entered: !!(window as any).__entered }), 1200, async () => {
    await page.evaluate(() => { (window as any).__entered = true; (window as any).trace.enterView(); });
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => (window as any).trace.heldLayoutReplies().length), "the return waits for the worker").toBeGreaterThan(0);
    await page.evaluate(() => (window as any).trace.releaseLayoutReplies());
  });
  await settle(page);
  const returned = frames.filter((frame) => frame.entered);
  expect(returned.length).toBeGreaterThan(5);
  expect(returned.filter((frame) => frame.tiles === 0 || frame.loading), "blank or loading frames after returning").toEqual([]);
  await expect(page.locator(`.tile[aria-selected="true"]`).first()).toBeVisible();
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});
