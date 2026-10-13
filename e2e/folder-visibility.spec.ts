import { expect, test, type Page } from "@playwright/test";

const view = (page: Page) => page.getByTestId("trace-view");
const listing = (page: Page) => page.getByRole("list", { name: "Built-in listing" });

async function navigateWithLookupHeld(page: Page, directory: string, oldHost = false) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto(`/view.html?directory=/ordinary&candidateFailure=1${oldHost ? "&eligibilityPending=0" : ""}`);
  await expect(listing(page)).toBeVisible();
  await page.evaluate((directory) => {
    const trace = (window as any).trace;
    trace.backend.holdFolderReads();
    trace.navigate(directory);
  }, directory);
  await expect.poll(() => page.evaluate((directory) => (window as any).trace.backend.calls("folder_has_trace")
    .some((call: any) => call.params.directory === directory), directory)).toBe(true);
}

test("unknown eligibility holds neutral paint, then displays Trace", async ({ page }) => {
  await navigateWithLookupHeld(page, "/pictures");
  await expect(listing(page)).toHaveCount(0);
  await expect(view(page)).toHaveCount(0);
  await page.clock.runFor(399);
  await expect(listing(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  await expect(listing(page)).toHaveCount(0);
});

test("pending times out after 400 ms and a late true answer still displays Trace", async ({ page }) => {
  await navigateWithLookupHeld(page, "/pictures");
  await expect(listing(page)).toHaveCount(0);
  await page.clock.runFor(400);
  await expect(listing(page)).toBeVisible();
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});

test("a negative exact answer releases neutral paint to the listing", async ({ page }) => {
  await navigateWithLookupHeld(page, "/no-trace");
  await expect(listing(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  await expect(listing(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.state().fileView)).toBe("trace.view");
});

test("an older host shows the listing until unknown eligibility resolves", async ({ page }) => {
  await navigateWithLookupHeld(page, "/pictures", true);
  await expect(listing(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});
