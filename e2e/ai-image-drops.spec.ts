import { expect, test, type Locator, type Page } from "@playwright/test";
import { click, openView } from "./support";

const dialog = (page: Page) => page.getByRole("dialog", { name: /Generate image with AI|Edit with AI/ });
const cards = (page: Page) => dialog(page).locator("[data-input-path]");
const inputs = (page: Page, names: string[]): Promise<string[]> => page.evaluate((names) => names.map((name) => (window as any).trace.backend.path(name)), names);
const starts = (page: Page) => page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
async function drop(page: Page, paths: string[], source: "pane" | "external" = "pane") {
  await dialog(page).locator(".inputs").scrollIntoViewIfNeeded();
  return page.evaluate(({ paths, source }) => (window as any).trace.dropFiles(".ai-image-overlay .inputs", paths, source), { paths, source });
}
async function openEmpty(page: Page, query = "") {
  await openView(page, 900, `?ai=1${query}`);
  await page.keyboard.press("Control+E");
  await expect(dialog(page).getByRole("heading", { name: "Generate image with AI" })).toBeVisible();
  await expect(dialog(page).getByRole("combobox", { name: "Image connection" })).toBeEnabled();
}

/** Observe announcements in the persistent live region, rather than only its final text. */
async function watchAnnouncements(region: Locator) {
  await region.evaluate((element) => {
    const messages: string[] = [];
    (window as any).dropAnnouncements = messages;
    new MutationObserver((records) => {
      if (records.some((record) => record.type === "characterData" || [...record.addedNodes].some((node) => node.textContent?.trim()))) {
        messages.push(element.textContent?.trim() ?? "");
      }
    }).observe(element, { childList: true, characterData: true, subtree: true });
  });
  return () => region.page().evaluate(() => [...(window as any).dropAnnouncements] as string[]);
}

for (const reason of ["duplicate", "unsupported", "unreadable"] as const) {
  test(`repeated identical ${reason} drops mutate the live region each time`, async ({ page }) => {
    await openEmpty(page);
    const [warm] = await inputs(page, ["warm"]);
    if (reason === "duplicate") {
      await drop(page, [warm]);
      await expect(cards(page)).toHaveCount(1);
    }
    const rejected = reason === "duplicate" ? warm : reason === "unsupported" ? "/pictures/animation.gif" : "/pictures/missing.png";
    const feedback = dialog(page).locator('[aria-live="polite"]');
    const announcements = await watchAnnouncements(feedback);
    await drop(page, [rejected]);
    await expect.poll(async () => (await announcements()).length).toBeGreaterThan(0);
    const first = await announcements();
    await drop(page, [rejected]);
    await expect.poll(async () => (await announcements()).length).toBeGreaterThan(first.length);
    expect((await announcements()).at(-1)).toBe(first.at(-1));
    await expect(cards(page)).toHaveCount(reason === "duplicate" ? 1 : 0);
  });
}

for (const rejectedPaths of [["/one.gif", "/two.gif"], Array.from({ length: 9 }, (_, i) => `/rejected-${i}.gif`)]) {
  test(`queued drops announce every result after a held inspection completes: ${rejectedPaths.length} rejections`, async ({ page }) => {
    await openEmpty(page);
    const [warm] = await inputs(page, ["warm"]);
    const feedback = dialog(page).locator('[aria-live="polite"]');
    await expect(feedback).toHaveCount(1);
    await expect(feedback).toHaveAttribute("aria-atomic", "true");
    const announcements = await watchAnnouncements(feedback);
    await page.evaluate((warm) => {
      const backend = (window as any).trace.backend;
      backend.symlinkInput("/a.png", warm);
      backend.holdInputs();
    }, warm);
    await dialog(page).locator(".inputs").scrollIntoViewIfNeeded();
    // Delivery awaits intake completion; retain promises without blocking the release step.
    await page.evaluate((rejectedPaths) => {
      (window as any).pendingDrops = ["/a.png", ...rejectedPaths].map((path) =>
        (window as any).trace.dropFiles(".ai-image-overlay .inputs", [path], "pane"));
    }, rejectedPaths);
    await expect(dialog(page).getByText("Reading input images…", { exact: true })).toBeVisible();
    expect(await announcements()).toEqual([]);
    await page.evaluate(() => (window as any).trace.backend.releaseInputs());
    expect(await page.evaluate(() => Promise.all((window as any).pendingDrops))).toEqual(Array(rejectedPaths.length + 1).fill("delivered"));
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page)).toHaveAttribute("data-input-path", "/a.png");
    for (const result of ["1 input added · 1 of 8", ...rejectedPaths.map((path) => `${path.slice(1)}: Unsupported format. Use PNG, JPEG or WebP`)]) {
      await expect.poll(async () => (await announcements()).some((message) => message.includes(result))).toBe(true);
    }
  });
}

test("success after removing an input announces even when the previous success text is identical", async ({ page }) => {
  await openEmpty(page);
  const [warm, cool] = await inputs(page, ["warm", "cool"]);
  await drop(page, [warm]);
  await expect(cards(page)).toHaveCount(1);
  const feedback = dialog(page).locator('[aria-live="polite"]');
  const announcements = await watchAnnouncements(feedback);
  await drop(page, [cool]);
  await expect(feedback).toContainText("1 input added · 2 of 8");
  await expect(cards(page)).toHaveCount(2);
  const first = await announcements();
  await dialog(page).getByRole("button", { name: "Remove Image 2", exact: true }).click();
  await expect(cards(page)).toHaveCount(1);
  await drop(page, [cool]);
  await expect.poll(async () => (await announcements()).length).toBeGreaterThan(first.length);
  expect((await announcements()).at(-1)).toBe(first.at(-1));
  await expect(cards(page)).toHaveCount(2);
});

test("symlink parent traversal accepts distinct files and rejects only inspected canonical duplicates", async ({ page }) => {
  await openEmpty(page);
  const [warm, cool] = await inputs(page, ["warm", "cool"]);
  await page.evaluate((cool) => {
    const backend = (window as any).trace.backend;
    backend.directoryInput("/other/subdir");
    backend.symlinkInput("/pictures/link", "/other/subdir");
    backend.symlinkInput("/other/warm.png", cool);
  }, cool);
  const viaParent = "/pictures/link/../warm.png";
  await drop(page, [warm, viaParent]);
  await expect(cards(page)).toHaveCount(2);
  expect(await cards(page).evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.inputPath))).toEqual([warm, viaParent]);
  await drop(page, [cool]);
  await expect(cards(page)).toHaveCount(2);
  await expect(dialog(page).locator('[aria-live="polite"]')).toContainText("cool.png: Already an input");
});

test("fixed-aspect submission blocks failed input inspection and recovers with pinned revisions", async ({ page }) => {
  await openView(page, 900, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.backend.failInputs(2));
  await page.keyboard.press("Control+E");
  await expect(dialog(page).getByRole("combobox", { name: "Image connection" })).toBeEnabled();
  await expect(dialog(page).locator(".error")).toContainText("Could not read the input images: The image service is busy");
  await dialog(page).getByRole("combobox", { name: "Aspect ratio" }).click();
  await page.getByRole("option", { name: "16:9", exact: true }).click();
  await dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true }).fill("Keep this draft through a failed inspection");
  await dialog(page).getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog(page).locator(".error")).toContainText("Could not read the input images: The image service is busy");
  await expect(dialog(page).getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  expect(await starts(page)).toEqual([]);
  await dialog(page).getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(async () => (await starts(page)).length).toBe(1);
  expect((await starts(page))[0].params.request.expectedSourceDigest).toMatch(/^[0-9a-f]{64}$/);
});

test("two dropped images turn an empty Ctrl+E draft into an edit and submit in delivery order", async ({ page }) => {
  await openEmpty(page);
  await expect(dialog(page).getByText("Drop PNG, JPEG or WebP images here", { exact: false })).toBeVisible();
  await expect(dialog(page).getByText("Up to 8 inputs", { exact: true })).toBeVisible();
  await expect(dialog(page).locator("#openai-image-inputs-label")).toContainText("0 / 8");
  await dialog(page).getByRole("combobox", { name: "Image connection" }).click();
  await page.getByRole("option", { name: "Custom images", exact: true }).click();
  await dialog(page).getByRole("textbox", { name: "Image model", exact: true }).fill("custom-model-draft");
  await dialog(page).getByRole("combobox", { name: "Resolution" }).click();
  await page.getByRole("option", { name: "1K", exact: true }).click();
  await dialog(page).getByRole("combobox", { name: "Aspect ratio" }).click();
  await page.getByRole("option", { name: "16:9", exact: true }).click();
  await dialog(page).getByRole("spinbutton", { name: "Images", exact: true }).fill("2");
  const prompt = "Put Image 2's light on Image 1";
  await dialog(page).getByRole("textbox", { name: "Image prompt", exact: true }).fill(prompt);
  const delivered = await inputs(page, ["cool", "warm"]);
  expect(await drop(page, delivered)).toBe("delivered");
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).locator(".number")).toHaveText(["Image 1", "Image 2"]);
  await expect(cards(page).locator(".thumb .thumbnail")).toHaveCount(2);
  await expect(dialog(page).getByRole("heading", { name: "Edit with AI", exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true })).toHaveValue(prompt);
  await expect(dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true })).toBeFocused();
  await expect(dialog(page).getByRole("textbox", { name: "Image model", exact: true })).toHaveValue("custom-model-draft");
  await expect(dialog(page).getByRole("combobox", { name: "Image connection" })).toHaveAttribute("data-value", "custom-http");
  await expect(dialog(page).getByRole("combobox", { name: "Resolution" })).toHaveAttribute("data-value", "1k");
  await expect(dialog(page).getByRole("combobox", { name: "Aspect ratio" })).toHaveAttribute("data-value", "16:9");
  await expect(dialog(page).getByRole("spinbutton", { name: "Images", exact: true })).toHaveValue("2");
  await dialog(page).getByRole("combobox", { name: "Aspect ratio" }).click();
  await expect(page.getByRole("option", { name: "Auto", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Keep", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "16:9", exact: true }).click();
  await dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true }).focus();
  await page.keyboard.press("Control+Enter");
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  for (const start of await starts(page)) {
    expect(start.params.request).toMatchObject({ sourcePath: delivered[0], referencePaths: [delivered[1]], prompt,
      outputDir: "/pictures", connectionId: "custom-http", model: "custom-model-draft", resolution: "1k", aspectRatio: "16:9" });
    expect(start.params.request.expectedSourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(start.params.request.expectedReferenceDigests).toHaveLength(1);
  }
  await expect.poll(() => page.evaluate(() => (window as any).trace.registeredDropTargets())).toBe(0);
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
});

test("duplicates and unsupported drops explain each file and add no cards", async ({ page }) => {
  await openEmpty(page);
  const [warm] = await inputs(page, ["warm"]);
  await drop(page, [warm]);
  await expect(cards(page)).toHaveCount(1);
  const reads = await page.evaluate(() => (window as any).trace.backend.calls("openai_image_inputs").length);
  await drop(page, [warm, "/pictures/animation.gif"]);
  await expect(cards(page)).toHaveCount(1);
  const feedback = dialog(page).locator('[aria-live="polite"]');
  await expect(feedback).toContainText("warm.png: Already an input");
  await expect(feedback).toContainText("animation.gif: Unsupported format. Use PNG, JPEG or WebP");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("openai_image_inputs").length)).toBe(reads);
});

test("consecutive successful drops update the live region with the resulting input count", async ({ page }) => {
  await openEmpty(page);
  const [warm, cool] = await inputs(page, ["warm", "cool"]);
  const feedback = dialog(page).locator('[aria-live="polite"]');
  await drop(page, [warm]);
  await expect(feedback).toContainText("1 input added · 1 of 8");
  await drop(page, [cool]);
  await expect(feedback).toContainText("1 input added · 2 of 8");
  await expect(cards(page)).toHaveCount(2);
});

for (const paneDialogs of [true, false]) {
  test(`reopening preserves the prompt draft and dropped inputs: paneDialogs=${paneDialogs}`, async ({ page }) => {
    await openEmpty(page, `&paneDialogs=${Number(paneDialogs)}`);
    const [warm] = await inputs(page, ["warm"]);
    await drop(page, [warm]);
    const prompt = "Keep this prompt when the same dialog is opened again";
    await dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true }).fill(prompt);
    await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
    await expect(dialog(page)).toHaveCount(1);
    await expect(dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true })).toHaveValue(prompt);
    await expect(cards(page)).toHaveCount(1);
    expect(await cards(page).getAttribute("data-input-path")).toBe(warm);
    expect(await page.evaluate(() => (window as any).trace.registeredDropTargets())).toBe(1);
    await dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true }).focus();
    await page.keyboard.press("Control+Enter");
    await expect.poll(async () => (await starts(page)).length).toBe(1);
    expect((await starts(page))[0].params.request).toMatchObject({ prompt, sourcePath: warm });
  });
}

test("the ninth input is rejected with the limit reason and the first eight remain ordered", async ({ page }) => {
  await openEmpty(page);
  const firstEight = await inputs(page, ["daylight", "warm", "cool", "village", "quiet", "mist", "merge", "rain"]);
  await drop(page, firstEight, "external");
  await expect(cards(page)).toHaveCount(8);
  const [ninth] = await inputs(page, ["morning"]);
  await drop(page, [ninth]);
  await expect(cards(page)).toHaveCount(8);
  await expect(dialog(page).locator('[aria-live="polite"]')).toContainText("morning.png: Up to 8 inputs");
  expect(await cards(page).evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.inputPath))).toEqual(firstEight);
  await dialog(page).getByRole("textbox", { name: "Edit prompt", exact: true }).fill("Combine these eight inputs");
  await page.keyboard.press("Control+Enter");
  await expect.poll(async () => (await starts(page)).length).toBe(1);
  expect((await starts(page))[0].params.request).toMatchObject({ sourcePath: firstEight[0], referencePaths: firstEight.slice(1) });
});

test("unreadable drops leave an empty form in generate mode and external valid drops work", async ({ page }) => {
  await openEmpty(page);
  await drop(page, ["/pictures/missing.png"], "external");
  await expect(cards(page)).toHaveCount(0);
  await expect(dialog(page).getByRole("heading", { name: "Generate image with AI" })).toBeVisible();
  await expect(dialog(page).locator('[aria-live="polite"]')).toContainText("missing.png: Cannot read image: Path not found: No such file or directory (os error 2)");
  const delivered = await inputs(page, ["warm", "cool"]);
  await drop(page, delivered, "external");
  await expect(cards(page)).toHaveCount(2);
  await dialog(page).getByRole("button", { name: "Move Image 2 earlier", exact: true }).click();
  await dialog(page).getByRole("button", { name: "Remove Image 2", exact: true }).click();
  await expect(cards(page).locator(".number")).toHaveText(["Image 1"]);
  await expect(cards(page).locator(".name")).toHaveText(["cool.png"]);
});

for (const paneDialogs of [true, false]) for (const fileDropTargets of [true, false]) {
  test(`capabilities: paneDialogs=${paneDialogs}, fileDropTargets=${fileDropTargets}`, async ({ page }) => {
    await openEmpty(page, `&paneDialogs=${Number(paneDialogs)}&fileDropTargets=${Number(fileDropTargets)}`);
    const [call] = await page.evaluate(() => (window as any).trace.dialogCalls());
    if (paneDialogs) expect(call.options).toEqual({ scope: "pane", pane: { paneId: "pane-1" } });
    else expect(call).not.toHaveProperty("options");
    if (fileDropTargets) {
      await expect(dialog(page).getByText("Drop PNG, JPEG or WebP images here", { exact: false })).toBeVisible();
      expect(await page.evaluate(() => (window as any).trace.registeredDropTargets())).toBe(1);
    } else {
      await expect(dialog(page).getByText("Drop PNG, JPEG or WebP images here", { exact: false })).toHaveCount(0);
      await expect(dialog(page).locator(".drop-enabled")).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).trace.registeredDropTargets())).toBe(0);
    }
    await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).trace.registeredDropTargets())).toBe(0);
  });
}
