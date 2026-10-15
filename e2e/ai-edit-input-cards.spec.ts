import { expect, test, type Page } from "@playwright/test";
import { click, openView, pickOption, settle } from "./support";

const SHOTS = process.env.CARD_SHOTS;
const dialog = (page: Page) => page.getByRole("dialog");
const strip = (page: Page) => dialog(page).getByRole("list", { name: /Inputs/ });
const cards = (page: Page) => strip(page).locator("[data-input-path]");
const prompt = (page: Page) => dialog(page).getByRole("textbox", { name: "Prompt", exact: true });
const longName = "an-extremely-long-file-name-from-a-camera-export-2026-10-15-final-v2.png";

/** Opens AI Edit on warm and merge, then drops a long-named image (a link to plain.png) in as the third input. */
async function openWithLongName(page: Page) {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await click(page, "merge", { modifiers: ["Control"] });
  const long = await page.evaluate((name) => {
    const w = window as any;
    const warm = w.trace.backend.path("warm") as string;
    const link = `${warm.slice(0, warm.lastIndexOf("/"))}/${name}`;
    w.trace.backend.symlinkInput(link, `${warm.slice(0, warm.lastIndexOf("/"))}/plain.png`);
    return link;
  }, longName);
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  await expect(cards(page)).toHaveCount(2);
  await page.evaluate((link) => (window as any).trace.dropFiles(".ai-image-overlay .inputs", [link], "pane"), long);
  await expect(cards(page)).toHaveCount(3);
  await settle(page);
}

test("input cards are one compact size whatever the file is called, with a number badge and no names", async ({ page }) => {
  await openWithLongName(page);
  const widths = await cards(page).evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
  expect(widths[0]).toBeLessThanOrEqual(110);
  expect(new Set(widths.map(Math.round)).size).toBe(1);
  await expect(cards(page).locator(".number")).toHaveText(["1", "2", "3"]);
  // The name is the card's accessible name and hover title only, never visible text.
  await expect(cards(page).nth(2)).toHaveAttribute("aria-label", `Image 3: ${longName}`);
  await expect(cards(page).nth(2)).toHaveAttribute("title", /an-extremely-long-file-name/);
  const visible = (await strip(page).innerText()).replace(/[‹›×\s]/g, "");
  expect(visible).toBe("123");
  await expect(dialog(page).getByText(/Image \d/)).toHaveCount(0);
  await expect(dialog(page).getByText(longName)).toHaveCount(0);
  if (SHOTS) await dialog(page).locator(".plugin-dialog").screenshot({ path: `${SHOTS}/after.png` });
});

test("the card buttons show only on hover or focus, take no space, and still reorder and remove", async ({ page }) => {
  await openWithLongName(page);
  const first = cards(page).first(), second = cards(page).nth(1);
  const actions = (card: typeof first) => card.locator(".card-actions");
  const before = await first.boundingBox();
  await expect(actions(first)).toHaveCSS("opacity", "0");
  await second.hover();
  await expect(actions(second)).toHaveCSS("opacity", "1");
  await expect(actions(first)).toHaveCSS("opacity", "0");
  expect(await first.boundingBox()).toEqual(before);
  if (SHOTS) await dialog(page).locator(".plugin-dialog").screenshot({ path: `${SHOTS}/after-hover.png` });
  // Reorder: the second input moves first, and the badges keep counting in send order.
  const names = () => cards(page).evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")!.replace(/^Image \d+: /, "")));
  const original = await names();
  await dialog(page).getByRole("button", { name: "Move Image 2 earlier" }).click();
  expect(await names()).toEqual([original[1], original[0], original[2]]);
  await expect(cards(page).locator(".number")).toHaveText(["1", "2", "3"]);
  await expect(dialog(page).getByRole("button", { name: "Move Image 1 earlier" })).toBeDisabled();
  // Keyboard focus reveals the buttons too.
  await page.mouse.move(0, 0);
  await dialog(page).getByRole("button", { name: "Remove Image 3" }).focus();
  await expect(actions(cards(page).nth(2))).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).locator(".number")).toHaveText(["1", "2"]);
});

test("the prompt wraps a long line and long words without scrolling sideways", async ({ page }) => {
  await openWithLongName(page);
  const box = prompt(page);
  for (const value of ["make it a little warmer and softer ".repeat(40), "x".repeat(800), `${"a".repeat(300)} ${"b".repeat(300)}`]) {
    await box.fill(value);
    const { scrollWidth, clientWidth, scrollHeight, lineHeight } = await box.evaluate((e: HTMLTextAreaElement) => ({
      scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, scrollHeight: e.scrollHeight, lineHeight: parseFloat(getComputedStyle(e).lineHeight) || 16 }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    expect(scrollHeight).toBeGreaterThan(lineHeight * 2);
  }
  // The inputs section does not scroll sideways either.
  expect(await strip(page).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
});

test("a connection with a single choice for an option does not show that select", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  await expect(dialog(page).getByRole("combobox", { name: "Image connection" })).toHaveAttribute("data-value", "saved-login");
  await expect(dialog(page).getByRole("combobox", { name: "Resolution" })).toBeVisible();
  await expect(dialog(page).getByRole("combobox", { name: "Quality" })).toHaveCount(0);
  await expect(dialog(page).getByRole("combobox", { name: "Background" })).toHaveCount(0);
  await pickOption(dialog(page).getByRole("combobox", { name: "Image connection" }), "custom-http");
  await expect(dialog(page).getByRole("combobox", { name: "Quality" })).toBeVisible();
  await expect(dialog(page).getByRole("combobox", { name: "Background" })).toBeVisible();
  // The hidden single value is still sent.
  await pickOption(dialog(page).getByRole("combobox", { name: "Image connection" }), "saved-login");
  await prompt(page).fill("warmer");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
  const [start] = await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
  expect(start.params.request).toMatchObject({ quality: "auto", background: "auto" });
});
