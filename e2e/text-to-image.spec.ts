import { expect, test } from "@playwright/test";
import { click, openView } from "./support";

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
  await expect(dialog.getByRole("textbox", { name: "Edit prompt" })).toBeFocused();
  const inputs = dialog.getByRole("list", { name: /Inputs/ }).locator("[data-input-path]");
  await expect(inputs).toHaveCount(2);
  expect(await inputs.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")))).toEqual(["Image 1: warm.png", "Image 2: village.png"]);
  await expect(dialog.getByLabel("Temperature", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Seed", { exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Edit prompt" }).fill("Combine these images");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start")[0].params.request)).toMatchObject({ sourcePath: "/pictures/warm.png", referencePaths: ["/pictures/village.png"] });
});

test("an unsuitable pane folder gives actionable output guidance before submission", async ({ page }) => {
  await openView(page, 1400, "?ai=1");
  await page.evaluate(() => { (window as any).trace.leaveView(); (window as any).trace.navigate("demo://pictures"); });
  await page.keyboard.press("Control+e");
  const dialog = page.getByRole("dialog", { name: "Generate image with AI" });
  await expect(dialog.getByRole("status")).toContainText("Open a local output folder in Explorer, then press Ctrl+E again");
  await dialog.getByRole("textbox", { name: "Image prompt" }).fill("A lighthouse");
  await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+Enter");
  await expect(dialog.getByRole("alert")).toContainText("Open a local output folder");
  expect(await page.evaluate(() => (window as any).trace.backend.calls("jobs.start"))).toEqual([]);
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
