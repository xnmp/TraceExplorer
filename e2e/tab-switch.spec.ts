import { expect, test } from "@playwright/test";
import { openView } from "./support";

// Switching to another tab unmounts the Trace view; switching back mounts a new one.
test("returning to a Trace tab shows its graph at once, without Loading Trace…", async ({ page }) => {
  await openView(page, 1400);
  const tiles = await page.locator("[data-tile-key]").count();
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
  const shownAt = await page.evaluate(async () => {
    const start = performance.now();
    (window as any).trace.enterView();
    while (!document.querySelector("[data-tile-key]")) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  // Shown from what the previous view loaded, well before the 600 ms reads return.
  expect(shownAt).toBeLessThan(300);
  await expect(page.locator("[data-tile-key]")).toHaveCount(tiles);
  // Revalidation completes in the background and keeps the graph in place.
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-tile-key]")).toHaveCount(tiles);
  expect(await page.evaluate(() => (window as any).__loadingSeen)).toBe(false);
});

test("a tab showing a different folder never starts from this folder's graph", async ({ page }) => {
  await openView(page, 1400);
  await page.evaluate(() => (window as any).trace.leaveView());
  await page.evaluate(() => { (window as any).trace.backend.setFolderLatency(600); (window as any).trace.navigate("/pictures-mirror"); (window as any).trace.enterView(); });
  // The mirror reuses this folder's component ids, so only the folder key keeps them apart.
  await expect(page.getByRole("status").filter({ hasText: "Loading Trace…" })).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});
