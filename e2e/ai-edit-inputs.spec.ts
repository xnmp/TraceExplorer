import { expect, test, type Page } from "@playwright/test";
import { click, openView, settle } from "./support";

const SHOTS = process.env.ROUND4_SHOTS;
const path = (page: Page, name: string) => page.evaluate((n) => (window as any).trace.backend.path(n) as string, name);
const command = (page: Page, id: string) => page.evaluate((i) => (window as any).trace.command(i), id);
const dialog = (page: Page) => page.getByRole("dialog");
const strip = (page: Page) => dialog(page).getByRole("list", { name: /Inputs/ });

/** The numbered cards in the dialog: [number, file name]. */
async function cards(page: Page): Promise<string[][]> {
  return strip(page).locator("[data-input-path]").evaluateAll((items) => items.map((item) => [
    item.querySelector(".number")!.textContent!.trim(), item.querySelector(".name")!.textContent!.trim(),
  ]));
}

test("a Trace selection of listed, subfolder and unsaved images arrives whole, in click order", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  // merge is unsaved and mist is in a subfolder: the host cannot select either.
  for (const name of ["merge", "mist", "village"]) await click(page, name, { modifiers: ["Control"] });
  const picked = await Promise.all(["warm", "merge", "mist", "village"].map((name) => path(page, name)));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/trace-selection-4.png` });
  await command(page, "plugin.openai-image.edit");
  await expect(strip(page).locator("[data-input-path]")).toHaveCount(4);
  expect(await cards(page)).toEqual([["Image 1", "warm.png"], ["Image 2", "merge.png"], ["Image 3", "mist.png"], ["Image 4", "village.png"]]);
  await expect(dialog(page).getByText("References:")).toHaveCount(0);
  await expect(dialog(page).getByLabel("Edit target")).toHaveCount(0);
  await expect(dialog(page).getByRole("combobox", { name: "Aspect ratio" })).toHaveValue("keep");
  await expect(dialog(page).getByRole("option", { name: "Keep (Image 1)" })).toHaveCount(1);
  if (SHOTS) { await settle(page); await dialog(page).locator(".plugin-dialog").screenshot({ path: `${SHOTS}/edit-inputs-4.png` }); }

  // Removing Image 3 renumbers the rest.
  await dialog(page).getByRole("button", { name: "Remove Image 3" }).click();
  expect(await cards(page)).toEqual([["Image 1", "warm.png"], ["Image 2", "merge.png"], ["Image 3", "village.png"]]);
  // Focus moves to the image that took its place, so removing can continue from the keyboard.
  await expect(dialog(page).getByRole("button", { name: "Remove Image 3" })).toBeFocused();
  // Moving by keyboard: the moved image keeps focus, so the key can be pressed again.
  await dialog(page).getByRole("button", { name: "Move Image 3 earlier" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(await cards(page)).toEqual([["Image 1", "village.png"], ["Image 2", "warm.png"], ["Image 3", "merge.png"]]);
  await expect(dialog(page).getByRole("button", { name: "Move Image 1 earlier" })).toBeDisabled();
  if (SHOTS) await dialog(page).locator(".plugin-dialog").screenshot({ path: `${SHOTS}/edit-inputs-reordered.png` });

  await dialog(page).getByRole("textbox", { name: "Edit prompt" }).fill("Put the hat in Image 3 on the man in Image 1");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
  const [start] = await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
  const [warm, merge, , village] = picked;
  expect(start.params.request).toMatchObject({
    sourcePath: village, referencePaths: [warm, merge], prompt: "Put the hat in Image 3 on the man in Image 1",
    outputDir: "/pictures", outputFilename: "village_edit.png", backend: "codex", model: "gpt-image-2", resolution: "2k", aspectRatio: "keep",
  });
  // Every input is pinned to the revision the dialog read, in the same order.
  const described = await page.evaluate(() => (window as any).trace.backend.calls("openai_image_inputs"));
  expect(described.at(-1).params.paths).toEqual(picked);
  expect(start.params.request.expectedSourceDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(start.params.request.expectedReferenceDigests).toHaveLength(2);
  expect(start.params.request.expectedReferenceDigests[0]).not.toBe(start.params.request.expectedSourceDigest);
  expect(await page.evaluate(() => (window as any).trace.accepted())).toEqual([{ label: "village_edit.png", detail: "Put the hat in Image 3 on the man in Image 1" }]);
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
});

test("an ordinary host selection of three images arrives whole", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.evaluate(() => (window as any).trace.toggle());
  const listing = page.getByRole("list", { name: "Built-in listing" });
  await listing.getByRole("button", { name: "village.png" }).click();
  await listing.getByRole("button", { name: "plain.png" }).click({ modifiers: ["Control"] });
  await listing.getByRole("button", { name: "cool.png" }).click({ modifiers: ["Control"] });
  await command(page, "plugin.openai-image.edit");
  await expect(strip(page).locator("[data-input-path]")).toHaveCount(3);
  // The host reports its selection in listing order.
  expect((await cards(page)).map(([, name]) => name).sort()).toEqual(["cool.png", "plain.png", "village.png"]);
  expect((await cards(page)).map(([number]) => number)).toEqual(["Image 1", "Image 2", "Image 3"]);
  await expect(dialog(page).getByRole("button", { name: "Remove Image 1" })).toBeEnabled();
  await dialog(page).getByRole("button", { name: "Remove Image 3" }).click();
  // After the last card, focus moves to the one before it.
  await expect(dialog(page).getByRole("button", { name: "Remove Image 2" })).toBeFocused();
  await page.keyboard.press("Enter");
  // The last image cannot be removed: focus stays in the strip.
  await expect(dialog(page).getByRole("button", { name: "Remove Image 1" })).toBeDisabled();
  await expect(strip(page)).toBeFocused();
  await expect(strip(page).locator("[data-input-path]")).toHaveCount(1);
});

test("at 1280×800 the inputs, the prompt and every setting are visible without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openView(page, 900, "?ai=1");
  await click(page, "warm");
  for (const name of ["merge", "mist", "village"]) await click(page, name, { modifiers: ["Control"] });
  await command(page, "plugin.openai-image.edit");
  await expect(strip(page).locator("[data-input-path]")).toHaveCount(4);
  await settle(page);
  const box = (await dialog(page).locator(".plugin-dialog").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  // Nothing in the dialog scrolls, and every control lies inside the visible dialog.
  const scrolled = await dialog(page).locator(".plugin-dialog, .dialog-body").evaluateAll((elements) => elements.map((element) => element.scrollHeight - element.clientHeight));
  expect(scrolled.every((overflow) => overflow <= 1)).toBe(true);
  for (const control of [
    strip(page), dialog(page).getByRole("textbox", { name: "Edit prompt" }),
    dialog(page).getByRole("combobox", { name: "Resolution" }), dialog(page).getByRole("spinbutton", { name: "Images" }),
    dialog(page).getByRole("textbox", { name: "Temperature" }), dialog(page).getByRole("textbox", { name: "Seed" }),
    dialog(page).getByRole("combobox", { name: "Aspect ratio" }), dialog(page).getByRole("button", { name: "Generate" }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const inner = (await control.boundingBox())!;
    expect(inner.y + inner.height).toBeLessThanOrEqual(box.y + box.height);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/edit-dialog-1280x800.png` });
});

test.describe("picks follow saves and deletes", () => {
  const preview = (page: Page) => page.getByRole("complementary", { name: "Preview" });
  const enabled = (page: Page) => page.evaluate(() => (window as any).trace.enabled("plugin.openai-image.edit") as boolean);

  test("an unsaved pick that is then saved arrives once, as the saved file", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    const unsaved = await path(page, "merge");
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    await command(page, "plugin.openai-image.edit");
    await expect(strip(page).locator("[data-input-path]")).toHaveCount(1);
    expect(await strip(page).locator("[data-input-path]").getAttribute("data-input-path")).toBe("/pictures/merge.png");
    expect(unsaved).not.toBe("/pictures/merge.png");
  });

  test("deleting the picked unsaved image leaves nothing to edit", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    expect(await enabled(page)).toBe(true);
    await preview(page).getByRole("button", { name: /^Delete/ }).click();
    await expect(page.getByTestId("preview-badge")).toHaveText("Deleted");
    await expect.poll(() => enabled(page)).toBe(false);
  });
});

test.describe("when the inputs cannot be read", () => {
  const editor = (page: Page) => page.getByRole("dialog", { name: "AI edit" });
  const fail = (page: Page, count: number) => page.evaluate((n) => (window as any).trace.backend.failInputs(n), count);
  const starts = (page: Page) => page.evaluate(() => (window as any).trace.backend.calls("jobs.start") as Array<{ params: { request: Record<string, any> } }>);

  test("a failed read is tried again on Generate", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await fail(page, 1);
    await command(page, "plugin.openai-image.edit");
    await expect(dialog(page).getByRole("alert")).toContainText("Could not read the input images");
    await dialog(page).getByRole("textbox", { name: "Edit prompt" }).fill("Warmer light");
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await starts(page)).length).toBe(1);
    const [start] = await starts(page);
    expect(start.params.request).toMatchObject({ sourcePath: "/pictures/warm.png", aspectRatio: "keep" });
    expect(start.params.request.expectedSourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the image editor's Image 1 keeps its revision and follows its size", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    const digest = "d".repeat(64);
    await fail(page, 2);
    await page.evaluate((d) => (window as any).trace.openEditor("/pictures/warm.png", d), digest);
    await expect(editor(page).getByRole("alert")).toContainText("Could not read the input images");
    await editor(page).getByRole("textbox", { name: "Edit prompt" }).fill("Warmer light");
    // Keep needs Image 1's size: neither the backend nor the editor has it yet.
    await page.keyboard.press("Control+Enter");
    await expect(editor(page).getByRole("alert")).toHaveText("Could not read the input images: The image service is busy. Try again, or choose an aspect ratio");
    expect(await starts(page)).toEqual([]);
    // The editor's preview loads: the open form follows its source.
    await page.evaluate(() => (window as any).trace.editorLoaded(1600, 900));
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await starts(page)).length).toBe(1);
    const [start] = await starts(page);
    // Image 1 stays pinned to the revision the editor captured, though the backend never described it.
    expect(start.params.request).toMatchObject({ sourcePath: "/pictures/warm.png", expectedSourceDigest: digest, aspectRatio: "keep" });
    const [width, height] = (start.params.request.size as string).split("x").map(Number);
    expect(width / height).toBeCloseTo(16 / 9, 1);
  });
});
