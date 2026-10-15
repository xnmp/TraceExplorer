import { expect, test } from "@playwright/test";
import { click, openView, tile, key, ensureExpanded } from "./support";

test("Ctrl+E with nothing selected generates an image with zero inputs", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Generate image with AI", exact: true });
  const prompt = dialog.getByRole("textbox", { name: "Image prompt" });
  await expect(prompt).toBeFocused();
  await expect(dialog.getByRole("list", { name: /Inputs/ })).toHaveCount(0);
  await expect(dialog.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Seed", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Aspect ratio" })).toHaveAttribute("data-value", "1:1");
  await prompt.fill("A lighthouse above a misty sea");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
  expect(calls).toHaveLength(1);
  expect(calls[0].params.request).toMatchObject({
    sourcePath: null, referencePaths: [], prompt: "A lighthouse above a misty sea",
    outputDir: "/pictures", outputFilename: "generated.png", model: null, aspectRatio: "1:1",
  });
  expect(calls[0].params.request).not.toHaveProperty("expectedSourceDigest");
  expect(await page.evaluate(() => (window as any).trace.accepted())).toEqual([{ label: "generated.png", detail: "A lighthouse above a misty sea" }]);
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
  // As the native provider finishes: publish a managed, unsaved output with
  // no inputs, then save it through the real Preview action into the hint folder.
  await page.evaluate(() => (window as any).trace.backend.completeJob(901));
  const componentId = `c:${await key(page, "job-901")}`;
  await ensureExpanded(page.locator(`section.component[data-component="${componentId}"]`));
  const root = await tile(page, "job-901");
  await expect(root.locator("img")).toBeVisible();
  const rootKey = await root.getAttribute("data-tile-key");
  await expect(page.locator(`svg path[data-route][data-to="node:${rootKey}"]`)).toHaveCount(0);
  await click(page, "job-901");
  await expect(page.getByTestId("preview-title")).toHaveText("generated.png");
  await expect(page.getByTestId("preview-badge")).toHaveText("Unsaved");
  const trace = page.getByRole("region", { name: "Trace", exact: true });
  await expect(trace.getByTestId("trace-prompt")).toHaveText("A lighthouse above a misty sea");
  await trace.getByRole("button", { name: "Trace details", exact: true }).click();
  await expect(trace.locator(".row").filter({ has: page.getByText("Operation", { exact: true }) })).toHaveText("OperationAI image");
  await expect(trace.getByRole("button", { name: /Preview input/ })).toHaveCount(0);
  await trace.locator("summary", { hasText: "Raw" }).click();
  const raw = await trace.locator("pre").textContent();
  expect(JSON.parse(raw!)).toMatchObject({ node: { parents: [] }, run: { operation: "openai.image.generate" } });
  await page.getByRole("complementary", { name: "Preview" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(root.locator(".unsaved-dot")).toHaveCount(0);
  await expect(page.getByTestId("preview-badge")).toHaveCount(0);
  await expect(page.getByTestId("preview-title")).toHaveText("generated.png");
  await expect(root.locator("img")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).trace.state().selected)).toEqual(["/pictures/generated.png"]);
  await expect(page.locator(`svg path[data-route][data-to="node:${rootKey}"]`)).toHaveCount(0);
  await expect(trace.getByText("AI image", { exact: true })).toBeVisible();
  await expect.poll(async () => JSON.parse((await trace.locator("pre").textContent())!)).toMatchObject({
    node: { path: "/pictures/generated.png", parents: [], temporary: false },
    run: { operation: "openai.image.generate", parameters: { output_storage: "saved", save_directory_hint: "/pictures" } },
  });
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
});

test("Ctrl+E from a built-in listing also uses the current empty-selection pane folder", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.evaluate(() => { (window as any).trace.leaveView(); (window as any).trace.navigate("/output"); });
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Generate image with AI" });
  await dialog.getByRole("textbox", { name: "Image prompt" }).fill("A paper lantern");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start")[0].params.request)).toMatchObject({ sourcePath: null, referencePaths: [], outputDir: "/output" });
});

test("Ctrl+E still edits selected Trace images in click order", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await click(page, "village", { modifiers: ["Control"] });
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Edit with AI", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused();
  const inputs = dialog.getByRole("list", { name: /Inputs/ }).locator("[data-input-path]");
  await expect(inputs).toHaveCount(2);
  expect(await inputs.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")))).toEqual(["Image 1: warm.png", "Image 2: village.png"]);
  await expect(dialog.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Seed", { exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill("Combine these images");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start")[0].params.request)).toMatchObject({ sourcePath: "/pictures/warm.png", referencePaths: ["/pictures/village.png"] });
});

test("editing an external generated parent saves into the current Trace folder", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  const generate = async (prompt: string, jobId: number) => {
    await page.keyboard.press("Control+e");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: /Image prompt|^Prompt$/ }).fill(prompt);
    await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toHaveCount(0);
    await page.evaluate((id) => (window as any).trace.backend.completeJob(id), jobId);
  };
  await generate("A lantern", 901);
  const componentId = `c:${await key(page, "job-901")}`;
  await ensureExpanded(page.locator(`section.component[data-component="${componentId}"]`));
  await click(page, "job-901");
  // A present child keeps the parent indexed after it is saved outside this folder.
  await generate("A brighter lantern", 902);
  await click(page, "job-901");
  await page.evaluate(() => (window as any).trace.backend.setPicker("/elsewhere/lantern.png"));
  await page.getByRole("complementary", { name: "Preview" }).getByRole("button", { name: "Save as…", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.node("job-901")))
    .toMatchObject({ path: "/elsewhere/lantern.png", scope: "external", temporary: false });
  await click(page, "job-901");
  await generate("A blue lantern", 903);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start").at(-1).params.request))
    .toMatchObject({ sourcePath: "/elsewhere/lantern.png", outputDir: "/pictures" });
  await click(page, "job-903");
  const trace = page.getByRole("region", { name: "Trace", exact: true });
  await trace.getByRole("button", { name: "Trace details", exact: true }).click();
  await trace.locator("summary", { hasText: "Raw" }).click();
  await expect.poll(async () => JSON.parse((await trace.locator("pre").textContent())!))
    .toMatchObject({ run: { parameters: { save_directory_hint: "/pictures" } } });
  await page.getByRole("complementary", { name: "Preview" }).getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("preview-badge")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).trace.state().selected)).toEqual(["/pictures/lantern_edit.png"]);
  await expect(page.getByTestId("preview-title")).toHaveText("lantern_edit.png");
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
});

test("an unsuitable pane folder rejects generation with actionable output guidance", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.evaluate(() => { (window as any).trace.leaveView(); (window as any).trace.navigate("demo://pictures"); });
  await page.keyboard.press("Control+e");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).trace.toasts())).toContainEqual({
    message: "Open a local output folder in Explorer, then press Ctrl+E again. Generated images need a local folder for saving.", variant: "info",
  });
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
});

for (const status of [{ earlierRevision: true }, { state: "unavailable" }, { state: "missing" }] as const) {
  test(`an unusable highlighted Trace target rejects Ctrl+E (${JSON.stringify(status)})`, async ({ page }) => {
    await openView(page, 1400, "?ai=1");
    // Native indexing retains an unusable revision only as a seed's parent.
    await page.evaluate((patch) => {
      const backend = (window as any).trace.backend;
      backend.startGeneration("merge", "merge-child");
      backend.completeGeneration("merge-child");
      backend.saveGeneration("merge-child");
      backend.setNodeStatus("merge", patch);
    }, status);
    await click(page, "warm");
    await click(page, "merge");
    await expect(page.getByTestId("preview-title")).toHaveText("merge.png");
    await page.keyboard.press("Control+e");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).trace.toasts())).toContainEqual({ message: "Select one to eight PNG, JPEG, or WebP images first", variant: "info" });
    expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
  });
}

test("local images in a search listing edit into their own folder", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.evaluate(() => {
    (window as any).trace.leaveView();
    (window as any).trace.navigate("search://images", [{ path: "/pictures/warm.png", name: "warm.png", kind: "file", size: 20, modified: "" }]);
  });
  await page.getByRole("list", { name: "Built-in listing" }).getByRole("button", { name: "warm.png", exact: true }).click();
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Edit with AI", exact: true });
  await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill("Add moonlight");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start")[0].params.request)).toMatchObject({ sourcePath: "/pictures/warm.png", outputDir: "/pictures" });
});

test("other-pane selections are inputs when the combined-selection extension is present", async ({ page }) => {
  await openView(page, 1400, "?ai=1&combinedSelection=1");
  await page.evaluate(() => (window as any).trace.setOtherPaneSelection([
    { path: "/pictures/warm.png", name: "warm.png", kind: "file", size: 20, modified: "" },
    { path: "/pictures/warm.png", name: "warm.png", kind: "file", size: 20, modified: "" },
  ]));
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Edit with AI" });
  await expect(dialog.getByRole("list", { name: /Inputs/ }).locator("[data-input-path]")).toHaveCount(1);
  await expect(dialog.getByLabel("Image 1: warm.png", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => (window as any).trace.setOtherPaneSelection([{ path: "/pictures/clip.gif", name: "clip.gif", kind: "file", size: 20, modified: "" }]));
  await page.keyboard.press("Control+e");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.toasts())).toContainEqual({ message: "Select one to eight PNG, JPEG, or WebP images first", variant: "info" });
});
