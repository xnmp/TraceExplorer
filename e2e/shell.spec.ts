import { test, expect } from "@playwright/test";
import { openView, click, state, uncaught, settle, rendered } from "./support";

const view = (page: import("@playwright/test").Page) => page.getByTestId("trace-view");
const builtin = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "Built-in listing" });

for (const host of [
  { name: "a host with ui/file-tiles", query: "?fileTiles=1", module: true },
  { name: "an older SDK 2 host", query: "", module: false },
]) {
  test(`with ${host.name}, the ordinary section lists files without provenance and keeps selection, opening and menus working`, async ({ page }) => {
    await openView(page, undefined, host.query);
    const list = page.getByRole("list", { name: "Other files and folders" });
    const entry = (path: string) => list.locator(`[data-entry-path="${path}"]`);
    await expect(list.locator("[data-entry-path]")).toHaveCount(3);
    for (const path of ["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]) await expect(entry(path)).toHaveCount(1);
    // The host's Tiles view renders the entries when available; the plugin then draws no icons of its own.
    await expect(page.locator("section.ordinary [data-host-file-tiles]")).toHaveCount(host.module ? 1 : 0);
    if (host.module) await expect(page.locator("section.ordinary svg")).toHaveCount(0);

    const notes = entry("/pictures/notes.txt");
    await notes.click();
    await expect(notes).toHaveAttribute("aria-pressed", "true");
    expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    await entry("/pictures/plain.png").click({ modifiers: ["Control"] });
    expect((await state(page)).selected.sort()).toEqual(["/pictures/notes.txt", "/pictures/plain.png"]);
    await notes.dblclick();
    expect((await state(page)).opened).toContain("/pictures/notes.txt");
    await entry("/pictures/plain.png").click();
    expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
    await expect(notes).toHaveAttribute("aria-pressed", "false");
    // Selecting something without provenance removes any lineage dimming.
    expect(await rendered(page, "tone", "focus")).toEqual([]);

    // A context menu targets the entry, selecting it first.
    await entry("/pictures/refs").click({ button: "right" });
    const after = await state(page);
    expect(after.menus.at(-1)).toBe("/pictures/refs");
    expect(after.selected).toEqual(["/pictures/refs"]);

    // Keyboard: entries are focusable and Space selects.
    await notes.focus();
    await page.keyboard.press("Space");
    expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    await expect(notes).toBeFocused();
  });
}

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
  expect(await rendered(page, "tone", "related")).toContain("quiet");
  expect(await uncaught(page)).toEqual([]);
});
