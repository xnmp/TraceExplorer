import { expect, test, type Page } from "@playwright/test";
import { click, openView } from "./support";

const dialog = (page: Page) => page.getByRole("dialog");
const resolution = (page: Page) => dialog(page).getByRole("combobox", { name: "Resolution" });
const listbox = (page: Page) => page.getByRole("listbox");

async function openEditor(page: Page, height = 800): Promise<void> {
  await page.setViewportSize({ width: 1280, height });
  await openView(page, 1280, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  await expect(dialog(page)).toBeVisible();
}
const startedRequests = (page: Page) => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").map((c: any) => c.params.request));

test("the open list is drawn with theme tokens, not the system widget", async ({ page }) => {
  await openEditor(page);
  await resolution(page).click();
  await expect(listbox(page)).toBeVisible();
  await expect(listbox(page).getByRole("option")).toHaveText(["1K", "2K", "4K"]);
  const painted = await listbox(page).evaluate((list) => {
    const probe = (token: string) => { const el = document.createElement("i"); el.style.background = `var(${token})`; document.body.append(el); const c = getComputedStyle(el).backgroundColor; el.remove(); return c; };
    const style = getComputedStyle(list);
    const active = getComputedStyle(list.querySelector(".active")!);
    return {
      background: style.backgroundColor, expectedBackground: probe("--background-solid"),
      border: style.borderTopColor, expectedBorder: probe("--control-stroke"),
      activeBackground: active.backgroundColor, expectedActive: probe("--control-fill-secondary"),
    };
  });
  expect(painted.background).toBe(painted.expectedBackground);
  expect(painted.border).toBe(painted.expectedBorder);
  expect(painted.activeBackground).toBe(painted.expectedActive);
  // The current value is marked selected and starts active.
  await expect(listbox(page).getByRole("option", { name: "2K" })).toHaveAttribute("aria-selected", "true");
  await expect(resolution(page)).toHaveAttribute("aria-activedescendant", (await listbox(page).locator(".active").getAttribute("id"))!);
});

test("the list renders on top of a short, scrolling dialog instead of being clipped by it", async ({ page }) => {
  await openEditor(page, 460);
  const body = dialog(page).locator(".dialog-body");
  expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  const ratio = dialog(page).getByRole("combobox", { name: "Aspect ratio" });
  await ratio.scrollIntoViewIfNeeded();
  await ratio.click();
  const hit = await listbox(page).evaluate((list) => {
    const r = list.getBoundingClientRect();
    const on = (x: number, y: number) => { const top = document.elementFromPoint(x, y); return !!top && list.contains(top); };
    return {
      inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      topEdge: on(r.left + r.width / 2, r.top + 3), centre: on(r.left + r.width / 2, r.top + r.height / 2), bottomEdge: on(r.left + r.width / 2, r.bottom - 3),
      popover: list.matches(":popover-open"),
    };
  });
  expect(hit).toEqual({ inside: true, topEdge: true, centre: true, bottomEdge: true, popover: true });
  // Taller than the room: it scrolls, and the last option can still be reached and chosen.
  await ratio.press("End");
  await ratio.press("Enter");
  await expect(ratio).toHaveAttribute("data-value", "9:16");
});

test("clicking an option selects it, closes the list and is what gets submitted", async ({ page }) => {
  await openEditor(page);
  await resolution(page).click();
  await listbox(page).getByRole("option", { name: "4K" }).click();
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveText("4K");
  await expect(resolution(page)).toHaveAttribute("data-value", "4k");
  await dialog(page).getByRole("textbox", { name: "Edit prompt" }).fill("make it larger");
  await dialog(page).getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => startedRequests(page).then((r) => r.length)).toBeGreaterThan(0);
  expect((await startedRequests(page))[0]).toMatchObject({ resolution: "4k" });
});

test("ArrowDown then Enter selects with the keyboard while focus stays on the control", async ({ page }) => {
  await openEditor(page);
  await resolution(page).focus();
  await page.keyboard.press("ArrowDown"); // opens on the current value, 2K
  await expect(listbox(page)).toBeVisible();
  await page.keyboard.press("ArrowDown"); // 4K
  await page.keyboard.press("Enter");
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toBeFocused();
  await expect(resolution(page)).toHaveText("4K");
  await dialog(page).getByRole("textbox", { name: "Edit prompt" }).fill("make it larger");
  await dialog(page).getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => startedRequests(page).then((r) => r.length)).toBeGreaterThan(0);
  expect((await startedRequests(page))[0]).toMatchObject({ resolution: "4k" });
});

test("End opens the list on the last option", async ({ page }) => {
  await openEditor(page);
  const ratio = dialog(page).getByRole("combobox", { name: "Aspect ratio" });
  await ratio.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(ratio).toHaveAttribute("data-value", "9:16");
});

test("Escape cancels without changing the value or closing the dialog", async ({ page }) => {
  await openEditor(page);
  await resolution(page).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(listbox(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveAttribute("data-value", "2k");
  await expect(dialog(page)).toBeVisible();
});

test("pressing outside closes the list without changing the value", async ({ page }) => {
  await openEditor(page);
  await resolution(page).click();
  await expect(listbox(page)).toBeVisible();
  await dialog(page).getByRole("textbox", { name: "Edit prompt" }).click();
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveAttribute("data-value", "2k");
});


test("a long option label keeps the list inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openView(page, 360, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const connection = dialog(page).getByRole("combobox", { name: "Image connection" });
  await connection.click();
  // Widen the first label far past the control; a resize makes the open list re-measure.
  await listbox(page).locator(".option-text").first().evaluate((el) => { el.textContent = "An exceedingly long connection name that cannot possibly fit within a narrow phone viewport"; });
  await page.evaluate(() => dispatchEvent(new Event("resize")));
  const box = (await listbox(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});

test("the list closes when focus leaves the control by other means, and a click on an option still selects", async ({ page }) => {
  await openEditor(page);
  await resolution(page).click();
  await expect(listbox(page)).toBeVisible();
  await resolution(page).evaluate((el) => (el as HTMLElement).blur());
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveAttribute("data-value", "2k");
  await resolution(page).click();
  await listbox(page).getByRole("option", { name: "1K" }).click();
  await expect(resolution(page)).toHaveAttribute("data-value", "1k");
});

test("clicking the wrapping label only focuses a closed control, and closes an open one", async ({ page }) => {
  await openEditor(page);
  const label = dialog(page).locator("label.prompt-field").filter({ hasText: /^Resolution/ });
  await label.click({ position: { x: 4, y: 4 } });
  await expect(resolution(page)).toBeFocused();
  await expect(listbox(page)).toHaveCount(0);
  await resolution(page).click();
  await expect(listbox(page)).toBeVisible();
  await label.click({ position: { x: 4, y: 4 } });
  await expect(listbox(page)).toHaveCount(0);
  await expect(resolution(page)).toHaveAttribute("aria-expanded", "false");
});

test("Enter and Space each toggle once", async ({ page }) => {
  await openEditor(page);
  await resolution(page).focus();
  await page.keyboard.press("Enter");
  await expect(listbox(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Space");
  await expect(listbox(page)).toBeVisible();
  await page.keyboard.press("Space"); // selects the active option and closes
  await expect(listbox(page)).toHaveCount(0);
});
