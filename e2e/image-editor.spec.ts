import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries, runPaletteCommand } from "./helpers";

test("palette switches crop and AI tools and submits its captured revision with Trace disabled", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, { showPreviewPane: true, pluginsEnabled: { trace: false } });
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { captureImageCrop } = await import("/src/lib/api/image-crop.ts");
    const { pluginJobsController } = await import("/src/lib/state/plugin-jobs.ts");
    const capture = await captureImageCrop("/home/user/Pictures/screenshot.png");
    if (!capture.ok) throw new Error(capture.error);
    pluginJobsController.accept = (_registration, start) => start();
    getMockControl().openAIImageStart = (request) => {
      if (request.expectedSourceDigest !== capture.data.revision.digest || request.sourcePath !== capture.data.path || request.prompt !== "Make the sky green" || !/^screenshot_edit_[a-f0-9-]+\.png$/.test(request.outputFilename)) throw new Error("Wrong captured revision or edit recipe");
      (window as any).__acceptedImageEdit = request;
      return 9;
    };
  });
  await page.locator(".entry-item").filter({ hasText: "screenshot.png" }).click();
  await runPaletteCommand(page, "Crop Image…");
  const dialog = page.getByRole("dialog", { name: "Edit image", exact: true });
  const right = page.getByRole("slider", { name: "Right crop edge" });
  await expect(right).toBeVisible();
  await right.focus(); await page.keyboard.press("ArrowLeft");
  await expect(right).toHaveAttribute("aria-valuenow", "511");
  await dialog.getByRole("button", { name: "AI edit", exact: true }).click();
  await expect(right).toHaveCount(0);
  await expect(dialog.getByLabel("Resolution")).toHaveValue("2k");
  await dialog.getByRole("button", { name: "Crop", exact: true }).click();
  await expect(right).toHaveAttribute("aria-valuenow", "511");
  await dialog.getByRole("button", { name: "AI edit", exact: true }).click();
  await dialog.getByLabel("Edit prompt").fill("Make the sky green");
  await expect(dialog.getByLabel("Output filename (.png)")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__acceptedImageEdit?.prompt)).toBe("Make the sky green");
  await expect(page.getByRole("list", { name: "Image provenance" })).toHaveCount(0);
});
