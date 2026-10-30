import { test, expect, type Page } from "@playwright/test";
import { openView, settle } from "./support";
import { awaitMotionStarted, holdMotion, releaseMotion } from "./animation-control";

/** Depth-0 cells paint like the host Tiles view: nothing at rest, so the pane's background shows through. */
const alphas = (page: Page) => page.evaluate(() => {
  const alpha = (element: Element) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!; context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] / 255;
  };
  const of = (selector: string) => [...document.querySelectorAll(selector)].map(alpha);
  return { cells: of("[data-grid-cell]"), covers: of(".explorer-cover"), coverCards: of(".explorer-cover .card"), entries: of("[data-entry-path]:not(.card)") };
});
const nonUniformPane = (page: Page) => page.addStyleTag({ content:
  "body, .explorer { background: repeating-linear-gradient(45deg, #c0392b 0 24px, #2980b9 24px 48px) !important; }" });
const shot = async (page: Page, name: string) => { if (process.env.SILHOUETTE_SHOTS) await page.screenshot({ path: `${process.env.SILHOUETTE_SHOTS}/${name}.png` }); };

for (const host of ["", "&fileTile=1&tileSize=medium"]) for (const theme of ["light", "dark"]) {
  test(`depth-0 files, folders and covers are transparent at rest and accent-styled when selected (${theme}, ${host ? "host tiles" : "fallback"})`, async ({ page }) => {
    await openView(page, 420, `?theme=${theme}${host}`, false);
    await nonUniformPane(page); await settle(page);
    await shot(page, `${theme}-${host ? "host" : "fallback"}-rest`);
    const rest = await alphas(page);
    expect(rest.cells.length).toBeGreaterThan(1);
    expect(rest.covers.length).toBeGreaterThan(0);
    for (const group of [rest.cells, rest.covers, rest.coverCards]) expect(group.every((a) => a === 0), JSON.stringify(rest)).toBe(true);
    await page.locator(".explorer-cover .stack-disclosure").first().click(); await settle(page);
    const childTiles = await page.locator(".tile:not(.explorer-cover)").evaluateAll((all) => all.map((e) => getComputedStyle(e).backgroundColor));
    expect(childTiles.length).toBeGreaterThan(0);
    expect(childTiles.every((c) => c === "rgba(0, 0, 0, 0)"), JSON.stringify(childTiles)).toBe(true);
    await page.locator(".explorer-cover .stack-disclosure").first().click(); await settle(page);
    await expect(page.locator(".explorer-cover .stack-sheet").first()).toBeVisible();
    await expect(page.locator(".explorer-cover .count-badge").first()).toBeVisible();

    const card = page.locator(".explorer-cover .card").first();
    await card.hover(); await settle(page);
    expect(await card.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await page.locator(".explorer-cover .cover-press").first().click(); await settle(page);
    await page.mouse.move(1, 1); await settle(page);
    const selected = page.locator(".explorer-cover .card.selected").first();
    await expect(selected).toBeVisible();
    const style = await selected.evaluate((e) => { const s = getComputedStyle(e); return { border: s.borderTopColor, background: s.backgroundColor }; });
    const accent = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--accent)"; document.body.append(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; });
    expect(style.border).toBe(accent);
    expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
    await shot(page, `${theme}-${host ? "host" : "fallback"}-selected`);
  });
}

test("cells hold an opaque backing exactly while motion runs, so routes stay behind tiles", async ({ page }) => {
  await openView(page, 420, "", false);
  await settle(page);
  await holdMotion(page);
  await page.locator("section[data-component] [data-stack-toggle]").first().click();
  await awaitMotionStarted(page);
  expect(await page.evaluate(() => (window as any).trace.motion.state().running.length)).toBeGreaterThan(0);
  const moving = await alphas(page);
  expect(moving.cells.every((a) => a === 1), JSON.stringify(moving)).toBe(true);
  expect(moving.covers.every((a) => a === 1)).toBe(true);
  await releaseMotion(page); await settle(page);
  const rest = await alphas(page);
  expect(rest.cells.every((a) => a === 0) && rest.covers.every((a) => a === 0), JSON.stringify(rest)).toBe(true);
});
