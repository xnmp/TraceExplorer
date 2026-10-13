import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught } from "./support";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
/** Highest painted opacity of the band's progress text, sampled every frame until `until` ms. */
const progressOpacity = (page: Page, until: number) => page.evaluate((until) => new Promise<number[]>((resolve) => {
  const seen: number[] = [], start = performance.now();
  const sample = () => {
    const text = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find((element) => /Loading…|Arranging…/.test(element.textContent ?? ""));
    seen.push(text ? Number(getComputedStyle(text).opacity) : -1);
    if (performance.now() - start < until) requestAnimationFrame(sample); else resolve(seen);
  };
  sample();
}), until);

test("a slow band load shows its progress text only after a delay", async ({ page }) => {
  await openView(page, 900, "", false);
  await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
  await stack(page, "village").locator("[data-stack-toggle]").click();
  const early = await progressOpacity(page, 250);
  expect(early.filter((opacity) => opacity >= 0).length).toBeGreaterThan(0); // the placeholder is mounted…
  expect(Math.max(...early)).toBeLessThan(.05); // …but not painted yet
  await expect.poll(async () => Math.max(...await progressOpacity(page, 50)), { timeout: 2000 }).toBeGreaterThan(.95);
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await settle(page);
  await expect(stack(page, "village").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  expect(await uncaught(page)).toEqual([]);
});

test("a fast band load never paints progress text", async ({ page }) => {
  await openView(page, 900, "", false);
  await stack(page, "village").locator("[data-stack-toggle]").click();
  const seen = await progressOpacity(page, 400);
  expect(Math.max(...seen)).toBeLessThan(.05);
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});
