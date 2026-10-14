/**
 * The epoch clock on painted frames, at frame rate with no held clock (docs/scene-transactions.md,
 * "Motion driver (rAF)", review fixes b7673b1 M1). The first frame after a publication renders it,
 * which takes long in a large scene; Chromium (and WebView2, the Windows host) time that render
 * inside the motion's first interval. The motion must still be shown frame by frame from its first
 * pose, not jump most of the way in its second painted frame.
 *
 * Chromium only: WebKit times the first frame differently, and its own frames are covered by
 * motion-driver.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught } from "./support";

/** A frame and a half, the first interval's lag-smoothing threshold, plus scheduling slack. */
const FRAME_SIZED = 34;

/** The epoch time each painted frame shows while `act`'s motion runs (null: no motion). */
async function paintedTimes(page: Page, act: () => Promise<void>): Promise<(number | null)[]> {
  await page.evaluate(() => {
    const w = window as any, times: (number | null)[] = [];
    w.__times = times;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
    document.body.append(probe);
    let frame = 0, sampled = -1;
    const observer = new ResizeObserver(() => {
      if (sampled === frame) return;
      sampled = frame;
      const running = w.trace.motion.state().running;
      times.push(running.length ? running[0].at : null);
    });
    observer.observe(probe);
    const next = () => {
      if (w.__stopTimes) { observer.disconnect(); probe.remove(); return; }
      frame++;
      probe.style.width = `${1 + (frame % 2)}px`;
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
  await act();
  await settle(page);
  await page.evaluate(() => { (window as any).__stopTimes = true; });
  return page.evaluate(() => (window as any).__times);
}

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"] [data-stack-toggle]`);

for (const [name, setup] of [
  ["a fan of 200 opening above a wide band", async (page: Page) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openView(page, 400, "?fanChildren=200&wideRoots=70", false);
    await stack(page, "wr-0").click(); await settle(page);
    return stack(page, "fan");
  }],
  ["80 rows moving under a stack opening", async (page: Page) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openView(page, 180, "?many=80", false);
    return stack(page, "village");
  }],
  ["a band opening (bandMotion)", async (page: Page) => {
    await page.setViewportSize({ width: 1000, height: 1300 });
    await openView(page, 420, "?bandMotion=1", false);
    return page.locator('section[aria-label="stack-b"] [data-stack-toggle]');
  }],
] as const) test(`the epoch clock advances in frame-sized steps from the first pose: ${name}`, async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium times the first render inside the first interval");
  const toggle = await setup(page);
  const times = await paintedTimes(page, () => toggle.click());
  const shown = times.filter((t): t is number => t !== null);
  expect(shown.length, JSON.stringify(times)).toBeGreaterThan(3);
  // The first painted frame shows the first pose; the next one at most a frame-sized step later.
  expect(shown[0], JSON.stringify(times)).toBe(0);
  expect(shown[1], JSON.stringify(times)).toBeLessThanOrEqual(FRAME_SIZED);
  // The clock never runs backwards.
  for (let i = 1; i < shown.length; i++) expect(shown[i], JSON.stringify(times)).toBeGreaterThanOrEqual(shown[i - 1]);
  expect(await uncaught(page)).toEqual([]);
});
