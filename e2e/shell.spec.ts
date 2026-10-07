import { test, expect } from "@playwright/test";
import { openView, click, state, uncaught, settle, rendered } from "./support";

const view = (page: import("@playwright/test").Page) => page.getByTestId("trace-view");
const builtin = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "Built-in listing" });

test("the ordinary section lists files without provenance; click selects and double-click opens", async ({ page }) => {
  await openView(page);
  const entries = page.locator("button.entry[data-entry-path]");
  await expect(entries).toHaveCount(3);
  for (const path of ["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]) await expect(page.locator(`button.entry[data-entry-path="${path}"]`)).toHaveCount(1);
  const notes = page.locator('button.entry[data-entry-path="/pictures/notes.txt"]');
  await notes.click();
  await expect(notes).toHaveAttribute("aria-pressed", "true");
  expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
  await notes.dblclick();
  expect((await state(page)).opened).toContain("/pictures/notes.txt");
  await page.locator('button.entry[data-entry-path="/pictures/plain.png"]').click();
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  await expect(notes).toHaveAttribute("aria-pressed", "false");
  // Selecting something without provenance removes any lineage dimming.
  expect(await rendered(page, "tone", "focus")).toEqual([]);
});

test("the toggle command switches to the built-in listing and back", async ({ page }) => {
  await openView(page);
  await expect(view(page)).toBeVisible();
  await page.evaluate(() => (window as any).trace.toggle());
  await expect(builtin(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect((await state(page)).fileView).toBeNull();
  await page.evaluate(() => (window as any).trace.toggle());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  await click(page, "warm");
  expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
});

test("a folder without provenance shows the built-in listing while the Trace view stays chosen", async ({ page }) => {
  await openView(page);
  await page.evaluate(() => (window as any).trace.navigate("/elsewhere"));
  await expect(builtin(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect((await state(page)).fileView).toBe("trace.view");
  await page.evaluate(() => (window as any).trace.navigate("/pictures"));
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});

test("disabling removes the view cleanly and re-enabling restores a working one", async ({ page }) => {
  await openView(page);
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.disable());
  await expect(view(page)).toHaveCount(0);
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await uncaught(page)).toEqual([]);
  await page.evaluate(() => (window as any).trace.enable());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  await settle(page);
  await click(page, "rain");
  expect(await rendered(page, "tone", "focus")).toEqual(["rain"]);
  expect(await rendered(page, "size", "large")).toEqual(["quiet", "rain", "warm"]);
  expect(await uncaught(page)).toEqual([]);
});
