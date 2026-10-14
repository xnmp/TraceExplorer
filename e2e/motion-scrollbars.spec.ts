import { test, expect } from "@playwright/test";
import { clickThroughGym } from "./motion-support";
import { clearSceneEvents, samplePaintedFrames as sampleFrames, sceneEvents } from "./helpers/scene-events";
import { drawn, expectSnapped, navigateRemounting, now, scene, sceneFrame, setExpanded, toggleOf } from "./helpers/scene-frames";
import { openView, settle } from "./support";

// Real scrollbars, styled as the host does (classic bars that take layout space).
// Headless Chromium hides them by default, so this file runs in a browser of its own.
test.use({
  viewport: { width: 1100, height: 900 },
  launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), ignoreDefaultArgs: ["--hide-scrollbars"] },
});

test("a scrollbar appearing while a graph grows moves no tile that keeps its place", async ({ page }) => {
  // Narrow enough that horizontal generations occupy separate shelves, so revealing them grows the band.
  const { scrolled } = await clickThroughGym(page, "", 240);
  // Some click made the view scroll, with a scrollbar that takes space.
  expect(scrolled).toBe(true);
});

// Native finding S6/S8: on a tab switch the scrollbar appearing narrowed the view from 858 to
// 850 px (WebKit reserves no gutter for a styled scrollbar), and the narrower layout reflowed
// with motion. The view's width must not depend on whether its content overflows.
test("a scrollbar appearing changes no layout width, and a tab switch draws one layout", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await openView(page, 860, "?scrollbars=host", false);
  for (let index = 0; index < 3; index++) await setExpanded(page, index, false);
  const measure = () => page.getByTestId("trace-view").evaluate((view) => ({ width: view.clientWidth, overflow: view.scrollHeight > view.clientHeight }));
  const short = await measure();
  for (let index = 0; index < 3; index++) await setExpanded(page, index, true);
  const tall = await measure();
  expect(tall.overflow).toBe(true);
  expect(tall.width, `width without overflow ${JSON.stringify(short)}`).toBe(short.width);
  const shown = await now(page);
  await page.evaluate(() => (window as any).trace.leaveView());
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await clearSceneEvents(page);
  const frames = await sampleFrames(page, sceneFrame, 700, () => page.evaluate(() => (window as any).trace.enterView()));
  await settle(page);
  const settled = await now(page);
  expect(scene(settled)).toEqual(scene(shown));
  expectSnapped(frames, settled, "tab return");
  expect(new Set(frames.filter(drawn).map((frame) => frame.width)).size, "one width").toBe(1);
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
});

// Native finding B, with the host's scrollbars: the first return after a settled expand restored
// the scene at the width without a scrollbar, then the scrollbar narrowed the view and the narrower
// layout replayed as motion (52 effects, band children at opacity 0, the next row 119 px too high).
test("returning to a folder after a settled expand draws the settled scene from its first frame", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 420 });
  await openView(page, 860, "?scrollbars=host", false);
  await setExpanded(page, 1, true);
  await setExpanded(page, 2, true);
  await setExpanded(page, 0, false);
  await toggleOf(page, 0).click();
  await expect(toggleOf(page, 0)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  await page.waitForTimeout(1500);
  await navigateRemounting(page, "/pictures-mirror");
  await expect.poll(async () => drawn(await now(page))).toBe(true);
  await settle(page);
  await clearSceneEvents(page);
  const frames = await sampleFrames(page, sceneFrame, 700, () => navigateRemounting(page, "/pictures"));
  await settle(page);
  const settled = await now(page);
  await expect(toggleOf(page, 0)).toHaveAttribute("aria-expanded", "true");
  expect(await page.getByTestId("trace-view").evaluate((view) => view.scrollHeight > view.clientHeight), "the folder overflows").toBe(true);
  expectSnapped(frames.filter((frame) => frame.directory === "/pictures"), settled, "return");
  expect(await sceneEvents(page, "motion-start")).toEqual([]);
});
