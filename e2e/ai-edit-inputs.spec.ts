import { expect, test, type Page } from "@playwright/test";
import { card, click, openView, settle, state, tile } from "./support";

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

/** The AI Edit dialog's inputs for the current selection, in order; closes the dialog again. */
async function editInputs(page: Page): Promise<string[]> {
  await command(page, "plugin.openai-image.edit");
  await expect(strip(page)).toBeVisible();
  const paths = await strip(page).locator("[data-input-path]").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.inputPath!));
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  return paths;
}

test.describe("host selection changes the view did not make", () => {
  test("an external change and back does not bring back an unsaved pick", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    const [warm, village] = await Promise.all([path(page, "warm"), path(page, "village")]);
    expect(await editInputs(page)).toEqual([warm, await path(page, "merge")]);
    await page.evaluate((p) => (window as any).trace.setSelection([p]), village);
    await page.evaluate((p) => (window as any).trace.setSelection([p]), warm);
    expect(await editInputs(page)).toEqual([warm]);
  });

  test("the host selecting the same files again notifies nothing, so the unsaved picks stay", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    // Warm last, so it stays the focus and merge stays in view.
    const listed = await Promise.all([path(page, "village"), path(page, "warm")]);
    await page.evaluate((paths) => (window as any).trace.setSelection(paths), listed);
    await click(page, "merge", { modifiers: ["Control"] });
    const merge = await path(page, "merge");
    const before = await editInputs(page);
    expect(before.toSorted()).toEqual([...listed, merge].toSorted());
    // The host's selection is a set mutated in place: the same files change nothing.
    await page.evaluate((paths) => (window as any).trace.setSelection(paths), listed);
    await expect(await card(page, "merge")).toHaveAttribute("aria-pressed", "true");
    expect(await editInputs(page)).toEqual(before);
  });

  test("a re-sort of the listing keeps the picks and their order", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    await click(page, "village", { modifiers: ["Control"] });
    const picked = await Promise.all(["warm", "merge", "village"].map((name) => path(page, name)));
    expect(await editInputs(page)).toEqual(picked);
    await page.evaluate(() => (window as any).trace.resort());
    await settle(page);
    expect(await editInputs(page)).toEqual(picked);
  });
});

test.describe("the view's own clicks", () => {
  test("a Shift range over an image already picked keeps the unsaved and subfolder picks", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "village");
    await click(page, "warm", { modifiers: ["Control"] });
    await click(page, "mist", { modifiers: ["Control"] });
    const [warm, mist] = await Promise.all([path(page, "warm"), path(page, "mist")]);
    // The host's range from warm (its anchor) to warm: village leaves the selection.
    await click(page, "warm", { modifiers: ["Shift"] });
    expect((await state(page)).selected).toEqual([warm]);
    expect(await editInputs(page)).toEqual([warm, mist]);
  });

  test("a refresh of the Preview target keeps the other picks", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await click(page, "mist", { modifiers: ["Control"] });
    const picked = await Promise.all([path(page, "merge"), path(page, "mist")]);
    expect(await editInputs(page)).toEqual(picked);
    await page.evaluate(() => (window as any).trace.backend.setPrompt("merge", "a new prompt"));
    await settle(page);
    await expect(await card(page, "mist")).toHaveAttribute("aria-pressed", "true");
    expect(await editInputs(page)).toEqual(picked);
  });

  test("Ctrl-clicking an image that cannot be an input changes no picks", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    await click(page, "mist", { modifiers: ["Control"] });
    const picked = await Promise.all(["warm", "merge", "mist"].map((name) => path(page, name)));
    await page.evaluate(() => (window as any).trace.backend.startGeneration("warm", "gen"));
    await settle(page);
    await click(page, "gen", { modifiers: ["Control"] });
    await click(page, "gen", { modifiers: ["Shift"] });
    expect((await state(page)).selected).toEqual([picked[0]]);
    expect(await editInputs(page)).toEqual(picked);
  });

  test("Shift-clicking an unsaved image already picked keeps it picked", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    await click(page, "merge", { modifiers: ["Shift"] });
    expect(await editInputs(page)).toEqual([await path(page, "warm"), await path(page, "merge")]);
  });

  test("Ctrl-clicking the Preview target unpicks it and its highlight", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await click(page, "mist", { modifiers: ["Control"] });
    await click(page, "merge", { modifiers: ["Control"] });
    await expect(await card(page, "merge")).toHaveAttribute("aria-pressed", "false");
    expect(await editInputs(page)).toEqual([await path(page, "mist")]);
  });
});

test.describe("picks in sections that are not shown", () => {
  async function section(page: Page, name: string) {
    const id = await (await tile(page, name)).locator("xpath=ancestor::section[@data-component]").getAttribute("data-component");
    return page.locator(`section[data-component="${id}"]`).locator("button.heading").first();
  }

  test("an unsaved pick discarded while its section is collapsed is no longer an input", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    const heading = await section(page, "merge");
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (window as any).trace.backend.discardGeneration("merge"));
    await settle(page);
    await expect.poll(() => editInputs(page)).toEqual([await path(page, "warm")]);
  });

  test("a section expanded again shows what changed while it was collapsed", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    const heading = await section(page, "merge");
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (window as any).trace.backend.discardGeneration("merge"));
    await settle(page);
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await expect(await card(page, "merge")).toHaveAttribute("aria-label", /Deleted/);
  });
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

  test("saving a picked unsaved image keeps its place among the picks", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await click(page, "mist", { modifiers: ["Control"] });
    const mist = await path(page, "mist");
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
    await settle(page);
    expect(await editInputs(page)).toEqual(["/pictures/merge.png", mist]);
  });

  test("a pick made while a save is running wins over the save", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await page.evaluate(() => (window as any).trace.backend.holdSaves());
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await click(page, "mist", { modifiers: ["Control"] });
    const mist = await path(page, "mist");
    await page.evaluate(() => (window as any).trace.backend.releaseSaves());
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    // Both picks stay, merge as its saved file; the save selected nothing else.
    expect(await editInputs(page)).toEqual(["/pictures/merge.png", mist]);
    expect((await state(page)).selected).not.toContain(mist);
  });

  test("Ctrl-clicking an image saved after a newer pick unpicks it rather than selecting it", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    await page.evaluate(() => (window as any).trace.backend.holdSaves());
    const merge = await tile(page, "merge");
    await merge.hover();
    await merge.getByRole("button", { name: "Save image permanently" }).click();
    await click(page, "mist", { modifiers: ["Control"] });
    await page.evaluate(() => (window as any).trace.backend.releaseSaves());
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    const [warm, mist] = await Promise.all([path(page, "warm"), path(page, "mist")]);
    expect(await editInputs(page)).toEqual([warm, "/pictures/merge.png", mist]);
    await click(page, "merge", { modifiers: ["Control"] });
    expect((await state(page)).selected).toEqual([warm]);
    await expect(await card(page, "merge")).toHaveAttribute("aria-pressed", "false");
    expect(await editInputs(page)).toEqual([warm, mist]);
  });

  test("a save does not bring back an image a Shift range dropped", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "village");
    await click(page, "warm", { modifiers: ["Control"] });
    await click(page, "daylight", { modifiers: ["Shift"] });
    const range = (await state(page)).selected;
    const village = await path(page, "village");
    expect(range).not.toContain(village);
    await click(page, "merge", { modifiers: ["Control"] });
    const merge = await tile(page, "merge");
    await merge.hover();
    await merge.getByRole("button", { name: "Save image permanently" }).click();
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    expect((await state(page)).selected.toSorted()).toEqual([...range, "/pictures/merge.png"].toSorted());
    const inputs = await editInputs(page);
    expect(inputs).not.toContain(village);
    expect(inputs.at(-1)).toBe("/pictures/merge.png");
  });

  test("a slow save of the Preview target the user unpicked meanwhile leaves the newer picks alone", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await page.evaluate(() => (window as any).trace.backend.holdSaves());
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await click(page, "mist", { modifiers: ["Control"] });
    await click(page, "merge", { modifiers: ["Control"] });
    const mist = await path(page, "mist");
    expect(await editInputs(page)).toEqual([mist]);
    await page.evaluate(() => (window as any).trace.backend.releaseSaves());
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    expect((await state(page)).selected).toEqual([]);
    expect(await editInputs(page)).toEqual([mist]);
  });

  test("saving the Preview target after unpicking it selects its file alone, as a plain click would", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge");
    await click(page, "mist", { modifiers: ["Control"] });
    await click(page, "merge", { modifiers: ["Control"] });
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => path(page, "merge")).toBe("/pictures/merge.png");
    await settle(page);
    // The save is the newest action: the saved file alone, with no input added unseen.
    expect((await state(page)).selected).toEqual(["/pictures/merge.png"]);
    expect(await editInputs(page)).toEqual(["/pictures/merge.png"]);
  });

  test("hover-saving an unsaved image picked alongside a listed one keeps both, in place", async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    await click(page, "warm");
    await click(page, "merge", { modifiers: ["Control"] });
    const warm = await path(page, "warm");
    const merge = await tile(page, "merge");
    await merge.hover();
    await merge.getByRole("button", { name: "Save image permanently" }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual([warm, "/pictures/merge.png"]);
    await settle(page);
    expect(await editInputs(page)).toEqual([warm, "/pictures/merge.png"]);
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
