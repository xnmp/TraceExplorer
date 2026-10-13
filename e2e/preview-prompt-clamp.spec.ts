import { test, expect, type Page } from "@playwright/test";
import { openView, click, settle } from "./support";

const trace = (page: Page) => page.getByRole("complementary", { name: "Preview" }).getByRole("region", { name: "Trace" });
const prompt = (page: Page) => trace(page).getByTestId("trace-prompt");
const toggle = (page: Page) => trace(page).getByRole("button", { name: /^Show (more|less)$/ });
const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long prompt.`).join("\n");

const setPrompt = (page: Page, name: string, text: string) =>
  page.evaluate(({ name, text }) => (window as any).trace.backend.setPrompt(name, text), { name, text });

/** Visible height of the prompt in lines. */
const visibleLines = (page: Page) => prompt(page).evaluate((el) => el.clientHeight / parseFloat(getComputedStyle(el).lineHeight));

test.describe("Preview prompt clamp", () => {
  test("a short prompt shows no toggle", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await expect(prompt(page)).toHaveText("warm prompt");
    await expect(toggle(page)).toHaveCount(0);
  });

  test("exactly four lines show no toggle", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", "a\nb\nc\nd");
    await click(page, "warm");
    await expect(prompt(page)).toHaveText("a\nb\nc\nd");
    await expect(toggle(page)).toHaveCount(0);
  });

  test("a long prompt shows four lines; the toggle expands and collapses it", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", LONG);
    await click(page, "warm");
    await expect(toggle(page)).toHaveText("Show more");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    expect(await visibleLines(page)).toBeCloseTo(4, 0);
    await toggle(page).click();
    await expect(toggle(page)).toHaveText("Show less");
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    expect(await visibleLines(page)).toBeCloseTo(12, 0);
    await expect(prompt(page)).toContainText("Line 12 of a long prompt.");
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    expect(await visibleLines(page)).toBeCloseTo(4, 0);
  });

  test("the full text is still selectable while clamped", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", LONG);
    await click(page, "warm");
    const copied = await prompt(page).evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(copied).toBe(LONG);
  });

  test("switching to another file collapses an expanded prompt", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", LONG);
    await setPrompt(page, "rain", LONG);
    await click(page, "warm");
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await click(page, "rain");
    await settle(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    expect(await visibleLines(page)).toBeCloseTo(4, 0);
  });
});
