import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught } from "./support";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
interface Frame { opacity: number; busy: boolean; band: boolean; grid: string }
/**
 * Per frame until `until` ms: the painted opacity of the cover's progress overlay (-1 when not
 * mounted), whether the cover is busy, whether a band appeared, and the grid's height.
 */
const coverProgress = (page: Page, name: string, until: number) => page.evaluate(({ name, until }) => new Promise<Frame[]>((resolve) => {
  const seen: Frame[] = [], start = performance.now();
  const section = document.querySelector<HTMLElement>(`section[data-component][aria-label="${name}"]`)!;
  const sample = () => {
    const overlay = section.querySelector<HTMLElement>("[data-cover-progress]");
    const grid = section.closest<HTMLElement>('[role="grid"]')!;
    seen.push({ opacity: overlay ? Number(getComputedStyle(overlay).opacity) : -1, busy: !!section.querySelector('[aria-busy="true"]'),
      band: !!section.querySelector("[data-grid-band]"), grid: `${grid.getBoundingClientRect().height}` });
    if (performance.now() - start < until) requestAnimationFrame(sample); else resolve(seen);
  };
  sample();
}), { name, until });

test("a slow stack open shows its cover progress only after a delay, without moving anything", async ({ page }) => {
  await openView(page, 900, "", false);
  await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
  const height = await page.locator('[role="grid"]').evaluate((grid) => `${grid.getBoundingClientRect().height}`);
  await stack(page, "village").locator("[data-stack-toggle]").click();
  const early = await coverProgress(page, "village", 250);
  expect(early.some((frame) => frame.opacity >= 0)).toBe(true); // the overlay is mounted…
  expect(Math.max(...early.map((frame) => frame.opacity))).toBeLessThan(.05); // …but not painted yet
  expect(early.every((frame) => frame.busy)).toBe(true); // busy at once for assistive technology
  await expect.poll(async () => Math.max(...(await coverProgress(page, "village", 50)).map((frame) => frame.opacity)), { timeout: 2000 }).toBeGreaterThan(.95);
  // No band, reserved space or displacement while pending.
  const later = await coverProgress(page, "village", 100);
  expect([...early, ...later].every((frame) => !frame.band && frame.grid === height)).toBe(true);
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await settle(page);
  await expect(stack(page, "village").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await expect(stack(page, "village").locator("[data-cover-progress]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("a fast stack open never paints cover progress", async ({ page }) => {
  await openView(page, 900, "", false);
  await stack(page, "village").locator("[data-stack-toggle]").click();
  const seen = await coverProgress(page, "village", 400);
  expect(Math.max(...seen.map((frame) => frame.opacity))).toBeLessThan(.05);
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});
