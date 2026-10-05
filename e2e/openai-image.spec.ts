import { test, expect, type Page } from "./fixtures";
import { waitForEntries, MULTI_SELECT_MODIFIER } from "./helpers";

async function captureJobs(page: Page) {
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    (window as any).__imageSubmissions = [];
    pluginJobsController.accept = async (registration, start) => {
      const result = await start();
      if (result.ok) pluginJobsController.register({ ...registration, id: result.data });
      return result;
    };
    getMockControl().openAIImageStart = (request, apiKey) => {
      const submissions = (window as any).__imageSubmissions;
      submissions.push({ request, apiKey });
      return 40 + submissions.length;
    };
  });
}
async function openEdit(page: Page) {
  await page.locator(".entry-item").filter({ hasText: "screenshot.png" }).first().click();
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Edit image", exact: true });
  await expect(dialog.getByLabel("Edit prompt")).toBeVisible();
  return dialog;
}
async function lastSubmission(page: Page) {
  return page.evaluate(() => (window as any).__imageSubmissions.at(-1));
}

test("Ctrl+E opens compact AI edit and Ctrl+Enter starts background generation", async ({ page }, testInfo) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  const dialog = await openEdit(page);
  await expect(dialog.getByRole("button", { name: "AI edit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Model", { exact: true })).toHaveValue("codex");
  await expect(dialog.getByLabel("Resolution")).toHaveValue("2k");
  await expect(dialog.getByLabel("Aspect ratio")).toHaveValue("keep");
  await expect(dialog.getByLabel("Seed")).toBeDisabled();
  await expect(dialog.getByLabel("Seed")).toHaveValue("Not supported");
  await expect(dialog.getByLabel("Output filename (.png)")).toHaveCount(0);
  await dialog.getByLabel("Edit prompt").fill("Make the sky green");
  await page.screenshot({ path: testInfo.outputPath("compact-ai-edit.png"), animations: "disabled" });
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toBeHidden();
  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress).toContainText("screenshot_edit_");
  await expect(progress).toContainText("Make the sky green");
  await expect(progress).toContainText("Generating…");
  const submitted = await lastSubmission(page);
  expect(submitted.apiKey).toBe("");
  expect(submitted.request).toMatchObject({ backend: "codex", prompt: "Make the sky green", sourcePath: "/home/user/Pictures/screenshot.png", size: "2048x1536", resolution: "2k", aspectRatio: "keep" });
  expect(submitted.request.outputFilename).toMatch(/^screenshot_edit_[a-f0-9-]+\.png$/);
  expect(submitted.request.expectedSourceDigest).toMatch(/^[a-f0-9]{64}$/);
  await page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    jobsStore.completeJob(41, "/home/user/Pictures/output.png");
  });
  await expect(progress).toContainText("Complete");
  await progress.getByRole("button", { name: /Dismiss screenshot_edit_/ }).click();
  await expect(progress).toBeHidden();
});

test("connection settings persist without losing the prompt and reach Codex", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  const dialog = await openEdit(page);
  await dialog.getByLabel("Edit prompt").fill("A warmer scene");
  await dialog.getByRole("button", { name: "Connection settings", exact: true }).click();
  await dialog.getByLabel("Codex executable path").fill("/opt/custom tools/codex");
  await dialog.getByLabel("OpenAI API key").fill("fixture-secret");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByLabel("Edit prompt")).toHaveValue("A warmer scene");
  const stored = await page.evaluate(async () => {
    const { createPluginStorage } = await import("/src/lib/plugins/api.ts");
    return createPluginStorage("openai-image").get();
  });
  expect(stored).toMatchObject({ codexPath: "/opt/custom tools/codex", apiKey: "fixture-secret" });
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await lastSubmission(page)).request.codexPath).toBe("/opt/custom tools/codex");
  expect((await lastSubmission(page)).apiKey).toBe("");
});

test("API generation uses chosen dimensions and shows a background error", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  await page.evaluate(async () => {
    const { createPluginStorage } = await import("/src/lib/plugins/api.ts");
    await createPluginStorage("openai-image").set({ apiKey: "api-fixture" });
  });
  const dialog = await openEdit(page);
  await dialog.getByLabel("Model", { exact: true }).selectOption("gpt-image-2.5-flare");
  await dialog.getByLabel("Resolution").selectOption("4k");
  await dialog.getByLabel("Aspect ratio").selectOption("16:9");
  await dialog.getByLabel("Edit prompt").fill("A cinematic landscape");
  await dialog.getByLabel("Aspect ratio").focus();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toBeHidden();
  const submitted = await lastSubmission(page);
  expect(submitted.apiKey).toBe("api-fixture");
  expect(submitted.request).toMatchObject({ backend: "api_key", model: "gpt-image-2.5-flare", size: "3840x2160", resolution: "4k", aspectRatio: "16:9" });
  await page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    jobsStore.failJob(41, "Provider unavailable");
  });
  await expect(page.getByRole("region", { name: "Background progress" })).toContainText("Provider unavailable");
});

test("failed submission retains its draft for retry", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().openAIImageStart = () => { throw new Error("Connection unavailable"); };
  });
  const dialog = await openEdit(page);
  await dialog.getByLabel("Edit prompt").fill("Keep this draft");
  await page.keyboard.press("Control+Enter");
  await expect(dialog.getByRole("alert")).toContainText("Connection unavailable");
  await expect(dialog.getByLabel("Edit prompt")).toHaveValue("Keep this draft");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
});

test("references survive changing the edit target", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  await page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first().click();
  await page.locator(".entry-item").filter({ hasText: "screenshot.png" }).first().click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Edit image", exact: true });
  await dialog.getByLabel("Edit target", { exact: true }).selectOption("/home/user/Pictures/screenshot.png");
  await expect(dialog).toContainText("References: photo1.jpg");
  await dialog.getByLabel("Edit prompt").fill("Use reference lighting");
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toBeHidden();
  expect((await lastSubmission(page)).request).toMatchObject({ sourcePath: "/home/user/Pictures/screenshot.png", referencePaths: ["/home/user/Pictures/photo1.jpg"] });
});

test("folder generation has no source and assigns its output name", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await waitForEntries(page); await captureJobs(page);
  const entry = page.locator(".entry-item").filter({ hasText: "Pictures" }).first();
  await entry.click(); await entry.click({ button: "right" });
  const ai = page.locator(".context-menu > .submenu-wrapper").filter({ hasText: "AI" });
  await ai.hover();
  await ai.locator(".submenu .menu-item").filter({ hasText: "Generate image with OpenAI…" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate image with OpenAI", exact: true });
  await dialog.getByLabel("Image prompt").fill("A green mug");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await lastSubmission(page)).request).toMatchObject({ sourcePath: null, outputDir: "/home/user/Pictures", size: "2048x2048" });
});

test("two in-flight edits have distinct output paths", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  for (const prompt of ["First edit", "Second edit"]) {
    const dialog = await openEdit(page);
    await dialog.getByLabel("Edit prompt").fill(prompt);
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toBeHidden();
  }
  const outputs = await page.evaluate(() => (window as any).__imageSubmissions.map((submission: any) => submission.request.outputFilename));
  expect(new Set(outputs).size).toBe(2);
  await expect(page.getByRole("region", { name: "Background progress" })).toContainText("First edit");
  await expect(page.getByRole("region", { name: "Background progress" })).toContainText("Second edit");
});

test("settings write failure preserves the draft and reports the error", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().failures = { write_config_file: "Disk unavailable" };
  });
  const dialog = await openEdit(page);
  await dialog.getByLabel("Edit prompt").fill("Preserve this edit");
  await dialog.getByRole("button", { name: "Connection settings" }).click();
  await dialog.getByLabel("Codex executable path").fill("/new/codex");
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Disk unavailable");
  await expect(dialog.getByLabel("Codex executable path")).toHaveValue("/new/codex");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByLabel("Edit prompt")).toHaveValue("Preserve this edit");
});

test("keep ratio cannot become square if source dimensions are unavailable", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page); await captureJobs(page);
  await page.evaluate(async () => {
    const { captureImageCrop } = await import("/src/lib/api/image-crop.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const capture = await captureImageCrop("/home/user/Pictures/screenshot.png");
    if (!capture.ok) throw new Error(capture.error);
    getMockControl().imageCropCapture = () => ({ ...capture.data, dataUrl: "data:image/png;base64,AAAA" });
  });
  const dialog = await openEdit(page);
  await dialog.getByLabel("Edit prompt").fill("Keep composition");
  await page.keyboard.press("Control+Enter");
  await expect(dialog.getByText("Wait for the source image to load, or choose an aspect ratio", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__imageSubmissions)).toEqual([]);
});

test("failed generation remains inspectable through image run history", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().openAIImageHistory = [{
      run: { id: 12, operation: "openai.image.generate", parameters: { model: "gpt-image-2", prompt: "A lantern in a ruined workshop" }, createdAt: "2026-10-03T00:00:00Z", status: "failed", finishedAt: "2026-10-03T00:00:02Z", error: "openai_image_failed", recovered: false, inputIds: [] }, outputPath: null,
    }];
  });
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("OpenAI: Image Run History");
  await palette.locator(".command-item").filter({ hasText: "OpenAI: Image Run History" }).click();
  const history = page.getByRole("dialog", { name: "OpenAI image history" });
  await expect(history).toBeVisible();
  await history.locator("summary").click();
  await expect(history).toContainText("failed");
  await expect(history).toContainText("A lantern in a ruined workshop");
  await expect(history).toContainText("No recorded output");
});
