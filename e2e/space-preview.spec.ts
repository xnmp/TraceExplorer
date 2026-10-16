import { test, expect, type Page, type Locator } from "@playwright/test";
import { card, caret, openView, settle, state, uncaught } from "./support";

const preview = (page: Page) => page.getByRole("complementary", { name: "Preview" });
const commands = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).trace.previewCommands());
const expansion = (page: Page) => page.getByTestId("trace-view").evaluate((view) => ({
  tiles: [...view.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => tile.dataset.tileKey).sort(),
  disclosures: [...view.querySelectorAll("[aria-expanded]")].map((control) => [
    control.getAttribute("data-node-caret") ?? control.closest("[data-component]")?.getAttribute("data-component"),
    control.getAttribute("aria-expanded"),
  ]),
}));

async function expectPreviewKeys(page: Page, tile: Locator): Promise<void> {
  await tile.focus();
  const before = await state(page);
  const expanded = await expansion(page);
  const tabStops = await page.locator('[role="grid"] [tabindex="0"]').count();
  for (const count of [1, 2]) {
    await tile.press("Space");
    await settle(page);
    expect(await commands(page)).toEqual(Array(count).fill("view.togglePreviewPane"));
    await expect(preview(page)).toHaveCount(count % 2 ? 0 : 1);
    expect(await expansion(page)).toEqual(expanded);
    // Includes selection, cursor, Preview target, ordered picks, notifications and opens.
    expect(await state(page)).toEqual(before);
    await expect(tile).toBeFocused();
    expect(await page.locator('[role="grid"] [tabindex="0"]').count()).toBe(tabStops);
  }
  await tile.press("Enter");
  await settle(page);
  expect((await state(page)).opened).toEqual([...before.opened, before.selected[0]]);
  expect(await expansion(page)).toEqual(expanded);
  expect(await commands(page)).toHaveLength(2);
  expect(await uncaught(page)).toEqual([]);
}

for (const collapsed of [false, true]) test(`Space previews a selected parent (${collapsed ? "collapsed" : "expanded"})`, async ({ page }) => {
  await openView(page, 900, "?selectionBlink=1");
  const parent = await card(page, "Saffron");
  await parent.click();
  await settle(page);
  if (collapsed) { await (await caret(page, "Saffron")).click(); await settle(page); }
  await expectPreviewKeys(page, parent);
});

test("Space previews a selected leaf", async ({ page }) => {
  await openView(page, 900, "?selectionBlink=1");
  await (await card(page, "Saffron")).click();
  await settle(page);
  const leaf = await card(page, "Blastoise");
  await leaf.click();
  await settle(page);
  await expectPreviewKeys(page, leaf);
});

for (const collapsed of [false, true]) test(`Space previews a selected stack cover (${collapsed ? "closed" : "open"})`, async ({ page }) => {
  await openView(page, 900, "?selectionBlink=1", false);
  const cover = page.locator(".cover-press").first();
  await cover.click();
  await settle(page);
  if (collapsed) { await page.locator("[data-stack-toggle]").first().click(); await settle(page); }
  await expectPreviewKeys(page, cover);
});

for (const host of [false, true]) test(`Space previews an ordinary ${host ? "host" : "fallback"} tile`, async ({ page }) => {
  await openView(page, 900, host ? "?fileTile=1" : "", false);
  const ordinary = page.locator('[data-entry-path="/pictures/notes.txt"]');
  await ordinary.click();
  await settle(page);
  await expectPreviewKeys(page, ordinary);
});
