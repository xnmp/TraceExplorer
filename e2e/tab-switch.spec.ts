import { expect, test, type Page } from "@playwright/test";
import { awaitAnimationsCreated, holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";
import { clearSceneEvents, sampleFrames, sceneEvents } from "./helpers/scene-events";
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
