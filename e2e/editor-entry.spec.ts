import { expect, test, type Page } from "@playwright/test";
import { openView } from "./support";

const MENU = "openai-image.edit-in-editor";
const COMMAND = "plugin.openai-image.edit-in-editor";
const path = (page: Page, name: string) => page.evaluate((n) => (window as any).trace.backend.path(n) as string, name);
const dirPath = (page: Page, name: string) => page.evaluate((n) => ((window as any).trace.backend.path("warm") as string).replace(/[^/]+$/, n), name);
const menuIds = (page: Page, paths: string[]) => page.evaluate((p) => (window as any).trace.menuFor(p).map(([id]: string[]) => id as string), paths);
const calls = (page: Page) => page.evaluate(() => (window as any).trace.editorCalls() as Array<{ path: string; tool: string }>);

test("the menu entry and the command open the selected image in the host editor's AI edit tool", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  const warm = await path(page, "warm");
  await page.evaluate((p) => (window as any).trace.selectPath(p), warm);
  expect(await menuIds(page, [warm])).toContain(MENU);
  expect(await menuIds(page, [])).not.toContain(MENU);
  expect(await page.evaluate((p) => (window as any).trace.menuFor([p]).find(([id]: string[]) => id === "openai-image.edit-in-editor")[1], warm)).toBe("Edit in image editor with AI…");
  expect(await page.evaluate((id) => (window as any).trace.enabled(id), COMMAND)).toBe(true);

  await page.evaluate(([id, p]) => { void (window as any).trace.invokeMenu(id, [p]); }, [MENU, warm]);
  await expect(page.getByRole("dialog", { name: "AI edit" })).toBeVisible();
  expect(await calls(page)).toEqual([{ path: warm, tool: "openai-image" }]);

  // The host refuses a second editor while one is open: reported, not thrown.
  await page.evaluate((id) => (window as any).trace.command(id), COMMAND);
  expect(await calls(page)).toHaveLength(2);
  await expect(page.getByRole("dialog", { name: "AI edit" })).toHaveCount(1);
});

test("both entries are unavailable for no, several, non-image and directory selections", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  const warm = await path(page, "warm");
  const notes = await dirPath(page, "notes.txt");
  const refs = await dirPath(page, "refs");
  const enabled = () => page.evaluate((id) => (window as any).trace.enabled(id) as boolean, COMMAND);
  expect(await enabled()).toBe(false);
  for (const selection of [[warm, await path(page, "village")], [notes], [refs]]) {
    await page.evaluate((p) => (window as any).trace.setSelection(p), selection);
    expect(await menuIds(page, selection)).not.toContain(MENU);
    expect(await enabled()).toBe(false);
  }
  expect(await calls(page)).toEqual([]);
});

test("a host without openImageEditor offers neither entry", async ({ page }) => {
  await openView(page, 1400, "?ai=1&editorApi=0");
  const warm = await path(page, "warm");
  await page.evaluate((p) => (window as any).trace.selectPath(p), warm);
  expect(await menuIds(page, [warm])).toEqual(["openai-image.edit"]);
  expect(await page.evaluate((id) => (window as any).trace.enabled(id), COMMAND)).toBe(false);
  expect(await page.evaluate((id) => (window as any).trace.command(id), COMMAND)).toBeUndefined();
  expect(await calls(page)).toEqual([]);
});
