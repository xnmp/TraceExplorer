import { expect, test } from "@playwright/test";
import { click, openView } from "./support";

test("configuring shared connections retains the caller draft and submits the refreshed HTTP recipe without credentials", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Keep the entire caller draft and all its images");
  await caller.getByRole("spinbutton", { name: "Images" }).fill("2");
  await expect(caller.getByText(/adapter-managed/)).toBeVisible();
  await expect(caller.getByRole("textbox", { name: "Image model" })).toHaveCount(0);
  await caller.getByRole("button", { name: "Configure connections" }).click();
  await page.getByRole("dialog", { name: "Image connections", exact: true }).getByRole("button", { name: "Use custom connection" }).click();
  await expect(caller.getByRole("combobox", { name: "Image connection" })).toHaveValue("saved-login");
  await expect(caller.getByRole("textbox", { name: "Edit prompt" })).toHaveValue("Keep the entire caller draft and all its images");
  await expect(caller.getByRole("spinbutton", { name: "Images" })).toHaveValue("2");
  await expect(caller.getByText(/adapter-managed/)).toBeVisible();
  await caller.getByRole("combobox", { name: "Image connection" }).selectOption("custom-http");
  await caller.getByRole("textbox", { name: "Image model" }).fill("vendor/custom-image-42");
  await caller.getByRole("combobox", { name: "Quality" }).selectOption("high");
  await caller.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(2);
  const starts = await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
  expect(starts.map((s: any) => s.params.request)).toEqual([
    expect.objectContaining({ connectionId: "custom-http", expectedConnectionRevision: "configured-revision", model: "vendor/custom-image-42", quality: "high", prompt: "Keep the entire caller draft and all its images", batch: expect.objectContaining({ index: 0, count: 2 }) }),
    expect.objectContaining({ connectionId: "custom-http", expectedConnectionRevision: "configured-revision", model: "vendor/custom-image-42", batch: expect.objectContaining({ index: 1, count: 2 }) }),
  ]);
  expect(starts[0].params.request.batch.id).toBe(starts[1].params.request.batch.id);
  for (const start of starts) {
    expect(start.params).not.toHaveProperty("apiKey");
    expect(start.params.request).not.toHaveProperty("codexPath");
    expect(start.params.request).not.toHaveProperty("backend");
    expect(start.params.request.expectedSourceDigest).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("a missing package blocks generation while a disabled settings contribution has its own actionable error", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => {
    const trace = (window as any).trace;
    trace.backend.setImageService({ version: 1, available: false, reason: { code: "missing_package", message: "Install the Image Generation package in Plugins." } });
    trace.setConfigureFailure("Enable the Image Generation settings contribution in Plugins.");
    return trace.command("plugin.openai-image.edit");
  });
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await expect(caller.getByRole("status")).toHaveText("Install the Image Generation package in Plugins.");
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Keep me while fixing settings");
  await expect(caller.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
  await caller.getByRole("button", { name: "Configure connections" }).click();
  await expect(caller.getByRole("alert")).toHaveText("Enable the Image Generation settings contribution in Plugins.");
  await expect(caller.getByRole("status")).toHaveText("Install the Image Generation package in Plugins.");
  await expect(caller.getByRole("textbox", { name: "Edit prompt" })).toHaveValue("Keep me while fixing settings");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
});

test("a disabled configuration contribution does not disable an available native image connection", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => { (window as any).trace.setConfigureFailure("Enable the Image Generation settings contribution in Plugins."); return (window as any).trace.command("plugin.openai-image.edit"); });
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("The existing native connection still works");
  await caller.getByRole("button", { name: "Configure connections" }).click();
  await expect(caller.getByRole("alert")).toContainText("settings contribution");
  await expect(caller.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await caller.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
});

test("a description arriving after caller disposal cannot restore its connection or start work", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => { (window as any).trace.backend.holdImageDescriptions(); return (window as any).trace.command("plugin.openai-image.edit"); });
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("image_service_describe").length)).toBe(1);
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Disposed draft");
  await caller.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => { (window as any).trace.backend.configureImages(); return (window as any).trace.command("plugin.openai-image.edit"); });
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("image_service_describe").length)).toBe(2);
  await page.evaluate(() => (window as any).trace.backend.releaseImageDescriptions());
  await expect(caller.getByRole("combobox", { name: "Image connection" })).toHaveValue("custom-http");
  await expect(caller.getByRole("textbox", { name: "Edit prompt" })).toHaveValue("");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
  expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
});

test("reloading connections preserves a custom model draft and refreshes the revision on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openView(page, 900, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await caller.getByRole("combobox", { name: "Image connection" }).selectOption("custom-http");
  await caller.getByRole("textbox", { name: "Image model" }).fill("my-mobile-custom-model");
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Preserve this narrow caller draft");
  await page.evaluate(() => (window as any).trace.backend.configureImages());
  await caller.getByRole("button", { name: "Reload connections" }).click();
  await expect(caller.getByRole("textbox", { name: "Image model" })).toHaveValue("my-mobile-custom-model");
  await expect(caller.getByRole("textbox", { name: "Edit prompt" })).toHaveValue("Preserve this narrow caller draft");
  await expect(caller.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
  await expect(caller.getByRole("status")).toContainText("This connection changed");
  await caller.getByRole("button", { name: "Use updated connection" }).click();
  expect(await caller.locator(".plugin-dialog").evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await caller.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
  const [start] = await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"));
  expect(start.params.request).toMatchObject({ model: "my-mobile-custom-model", expectedConnectionRevision: "configured-revision", prompt: "Preserve this narrow caller draft" });
});

test("removing a pinned connection requires an explicit choice instead of switching to the new default", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await expect(caller.getByRole("combobox", { name: "Image connection" })).toHaveValue("saved-login");
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Keep this draft until I choose");
  await page.evaluate(() => {
    const backend = (window as any).trace.backend;
    const value = backend.imageService();
    value.description.profiles = value.description.profiles.filter((p: any) => p.id !== "saved-login");
    value.description.defaultConnectionId = "custom-http";
    backend.setImageService(value);
  });
  await caller.getByRole("button", { name: "Reload connections" }).click();
  await expect(caller.getByRole("status")).toContainText("selected connection was removed");
  await expect(caller.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
  await expect(caller.getByRole("textbox", { name: "Edit prompt" })).toHaveValue("Keep this draft until I choose");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
  await caller.getByRole("combobox", { name: "Image connection" }).selectOption("custom-http");
  await caller.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
});

test("Ctrl+Enter cannot submit stale capabilities while Reload is pending", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const caller = page.getByRole("dialog", { name: "Edit with OpenAI" });
  await expect(caller.getByRole("combobox", { name: "Image connection" })).toHaveValue("saved-login");
  await caller.getByRole("textbox", { name: "Edit prompt" }).fill("Wait for the pending capability read");
  await page.evaluate(() => (window as any).trace.backend.holdImageDescriptions());
  await caller.getByRole("button", { name: "Reload connections" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("image_service_describe").length)).toBe(2);
  await expect(caller.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
  await caller.getByRole("textbox", { name: "Edit prompt" }).focus();
  await page.keyboard.press("Control+Enter");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
  await page.evaluate(() => (window as any).trace.backend.releaseImageDescriptions());
  await caller.getByRole("button", { name: "Generate", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
});
