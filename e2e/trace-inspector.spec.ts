import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

for (const mode of ALL_VIEW_MODES) test(`${mode}: selected image displays its recorded source, operation, and output`, async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await switchViewMode(page, mode);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace).toContainText("No recorded edits for this image.");

  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 3,
      selectedRevisionStatus: "matched",
      artifacts: [
        { id: 3, path: "/home/user/Pictures/screenshot.png", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:01Z", generatingRun: 2, pathState: "present" },
        { id: 1, path: "/home/user/Pictures/source.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "missing" },
      ],
      runs: [{ id: 2, operation: "image.crop", parameters: { rect: { left: 20, top: 10, right: 420, bottom: 310 }, viewport: { width: 512, height: 384 } }, createdAt: "2026-10-03T00:00:01Z", status: "succeeded", finishedAt: "2026-10-03T00:00:02Z", error: null, recovered: false, inputIds: [1] }],
    });
    traceInvalidation.bump();
  });

  const provenance = trace.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("source.png");
  await expect(provenance.getByRole("button")).toHaveCount(2);
  await expect(provenance.locator("img")).toHaveCount(1);
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance.locator('[aria-current="true"]')).toContainText("screenshot.png");

  const details = trace.getByRole("region", { name: "Trace details" });
  await expect(details.getByRole("heading")).toContainText("screenshot.png");
  await expect(details.locator("pre")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText('"left": 20');
  await provenance.getByRole("button", { name: /source.png/ }).focus();
  await page.keyboard.press("Enter");
  await expect(details.getByRole("heading")).toContainText("source.png");
  await expect(details).toContainText("Missing from recorded path");
});

test("two source images remain visible when one operation joins them", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = (path) => ({
      currentArtifactId: path.endsWith("photo2.jpg") ? 2 : 1,
      selectedRevisionStatus: "matched",
      artifacts: [
        { id: 1, path: "/home/user/Pictures/screenshot.png", digest: "aaaaaaaaaaaaaaaa", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" },
        { id: 2, path: "/home/user/Pictures/photo2.jpg", digest: "bbbbbbbbbbbbbbbb", createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" },
        { id: 4, path: "/home/user/Pictures/composite.png", digest: "cccccccccccccccc", createdAt: "2026-10-03T00:00:01Z", generatingRun: 3, pathState: "present" },
      ],
      runs: [{ id: 3, operation: "image.compose", parameters: {}, createdAt: "2026-10-03T00:00:01Z", status: "succeeded", finishedAt: "2026-10-03T00:00:02Z", error: null, recovered: false, inputIds: [1, 2] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance).toContainText("screenshot.png");
  await expect(provenance).toContainText("photo2.jpg");
  await expect(provenance.getByRole("button")).toHaveCount(3);
  await expect(provenance).toContainText("composite.png");
  await provenance.getByRole("button", { name: /composite.png/ }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText('"inputIds"');
  await expect(details).toContainText("composite.png");
  await page.locator(".entry-item", { hasText: "photo2.jpg" }).click();
  await expect(details.locator("pre")).toBeHidden();
  await expect(details).toContainText("photo2.jpg");
  await expect(provenance.getByRole("button", { name: /photo2.jpg/ })).toHaveAttribute("aria-pressed", "true");
});

test("externally changed bytes show the last recorded revision without claiming a current match", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "changed",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [],
    });
    traceInvalidation.bump();
  });
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace.getByRole("status")).toContainText("This file changed since it was recorded");
  await expect(trace.getByRole("list", { name: "Image provenance" })).toContainText("Last recorded");
  await expect(trace.locator('[aria-current="true"]')).toHaveCount(0);
});

test("a large image reports that its revision was not verified", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "unverified",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [],
    });
    traceInvalidation.bump();
  });
  const trace = page.getByRole("complementary", { name: "File inspector" });
  await expect(trace.getByRole("status")).toContainText("current bytes were not checked");
  await expect(trace.getByRole("status")).not.toContainText("changed");
});

test("a failed crop remains visible from its source without an invented output", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({
      currentArtifactId: 1,
      selectedRevisionStatus: "matched",
      artifacts: [{ id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03T00:00:00Z", generatingRun: null, pathState: "present" }],
      runs: [{ id: 2, operation: "image.crop", parameters: {}, createdAt: "2026-10-03T00:00:01Z", status: "failed", finishedAt: "2026-10-03T00:00:02Z", error: "crop_failed", recovered: false, inputIds: [1] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance.getByRole("button", { name: /Crop failed/ })).toBeVisible();
  await expect(provenance.getByRole("button")).toHaveCount(2);
  await provenance.getByRole("button", { name: /Crop failed/ }).click();
  const details = page.getByRole("region", { name: "Trace details" });
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText("failed");
  await expect(details).toContainText("No recorded output");
  await expect(details).toContainText("crop_failed");
});

for (const width of [804, 1280]) test(`${width}px: preview and Trace leave files navigable`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 760 });
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const selected = page.locator(".entry-item", { hasText: "screenshot.png" });
  await selected.click();
  await page.keyboard.press("Space");
  await expect(page.locator(".preview-pane")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "File inspector" })).toBeVisible();
  // A real row-center click and keyboard navigation must keep working after
  // both auxiliary panes mount, including narrow native window dimensions.
  const files = page.locator(".pane-container");
  await expect.poll(async () => (await files.boundingBox())?.width ?? 0).toBeGreaterThan(200);
  await selected.click();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".entry-item.selected")).toContainText("photo2.jpg");
  await expect(page.locator(".preview-pane")).toContainText("photo2.jpg");
  await page.screenshot({ path: testInfo.outputPath("preview-trace-navigation.png") });
});

test("Trace reveals an offscreen output and an ancestor excluded by the file filter", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.evaluate(async () => {
    const { mockFiles, file } = await import("/src/lib/api/mock-fixtures.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const folder = "/home/user/Pictures";
    mockFiles[folder] = [file("000-source.png", `${folder}/000-source.png`, 20), ...Array.from({ length: 300 }, (_, i) => file(`image-${String(i).padStart(3, "0")}.png`, `${folder}/image-${String(i).padStart(3, "0")}.png`, 20)), file("zzz-output.png", `${folder}/zzz-output.png`, 20)];
    getMockControl().traceForImage = (path) => ({
      currentArtifactId: path.endsWith("zzz-output.png") ? 3 : 1, selectedRevisionStatus: "matched",
      artifacts: [
        { id: 1, path: `${folder}/000-source.png`, digest: "a".repeat(64), createdAt: "2026-10-03", generatingRun: null, pathState: "present" },
        { id: 3, path: `${folder}/zzz-output.png`, digest: "b".repeat(64), createdAt: "2026-10-03", generatingRun: 2, pathState: "present" },
      ], runs: [{ id: 2, operation: "openai.image.edit", parameters: { prompt: "Test reveal" }, createdAt: "2026-10-03", status: "succeeded", finishedAt: "2026-10-03", error: null, recovered: false, inputIds: [1] }],
    });
    await windowTabsManager.getActiveExplorer()!.refresh();
  });
  await page.locator(".entry-item", { hasText: "000-source.png" }).click();
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(page.locator(".entry-item", { hasText: "zzz-output.png" })).toHaveCount(0);
  await provenance.getByRole("button", { name: /zzz-output.png/ }).click();
  await expect(page.locator(".entry-item.selected")).toContainText("zzz-output.png");
  await expect(page.locator(".entry-item.selected")).toBeInViewport();
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    windowTabsManager.getActiveExplorer()!.setFilter("zzz-output");
  });
  await provenance.getByRole("button", { name: /000-source.png/ }).click();
  await expect(page.locator(".entry-item.selected")).toContainText("000-source.png");
  await expect(page.locator(".entry-item.selected")).toBeInViewport();
});

test("Trace uses output nodes with thumbnails, prompt details, raw disclosure and a pane toggle", async ({ page }, testInfo) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    const completed = { id: 2, operation: "openai.image.edit", parameters: { prompt: "A warmer scene", resolution: "2k", aspect_ratio: "keep" }, createdAt: "2026-10-03", status: "succeeded" as const, finishedAt: "2026-10-03", error: null, recovered: false, inputIds: [1], details: { usage: { total_tokens: 123 }, request_id: "req_fixture" } };
    getMockControl().traceForImage = (path) => ({ currentArtifactId: path.endsWith("photo1.jpg") ? 3 : 1, selectedRevisionStatus: "matched",
      artifacts: [
        { id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03", generatingRun: null, pathState: "present" },
        { id: 3, path: "/home/user/Pictures/photo1.jpg", digest: "b".repeat(64), createdAt: "2026-10-03", generatingRun: 2, pathState: "present" },
      ], runs: [completed, { ...completed, id: 4, status: "running", finishedAt: null, details: null }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance.getByRole("button")).toHaveCount(3);
  await expect(provenance.locator("img")).toHaveCount(2);
  await expect(provenance.getByRole("button", { name: /Generating/ }).locator(".spinner")).toBeVisible();
  await provenance.getByRole("button", { name: /photo1.jpg/ }).click();
  await expect(page.locator(".entry-item.selected")).toContainText("photo1.jpg");
  const details = page.getByRole("region", { name: "Trace details" });
  await expect(details.getByText("A warmer scene", { exact: true })).toBeVisible();
  await expect(details.locator("pre")).toBeHidden();
  await expect(provenance).not.toContainText("aaaa");
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText("total_tokens");
  await expect(details.locator("pre")).toContainText("req_fixture");
  await page.screenshot({ path: testInfo.outputPath("thumbnail-trace.png") });
  for (const visible of [false, true]) {
    await page.keyboard.press("Control+Shift+p");
    await page.locator(".command-palette-dialog .search-input").fill("Toggle Trace Pane");
    await page.locator(".command-item").filter({ hasText: "Toggle Trace Pane" }).click();
    if (visible) await expect(provenance).toBeVisible();
    else await expect(page.getByRole("complementary", { name: "File inspector" })).toBeHidden();
  }
});

test("earlier revisions at a replaced path do not show the latest file as their thumbnail", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).click();
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { traceInvalidation } = await import("/src/lib/plugins/trace/invalidation.svelte.ts");
    getMockControl().traceForImage = () => ({ currentArtifactId: 3, selectedRevisionStatus: "matched",
      artifacts: [
        { id: 1, path: "/home/user/Pictures/screenshot.png", digest: "a".repeat(64), createdAt: "2026-10-03", generatingRun: null, pathState: "present" },
        { id: 3, path: "/home/user/Pictures/screenshot.png", digest: "b".repeat(64), createdAt: "2026-10-03", generatingRun: 2, pathState: "present" },
      ], runs: [{ id: 2, operation: "image.crop", parameters: {}, createdAt: "2026-10-03", status: "succeeded", finishedAt: "2026-10-03", error: null, recovered: false, inputIds: [1] }],
    });
    traceInvalidation.bump();
  });
  const provenance = page.getByRole("list", { name: "Image provenance" });
  await expect(provenance.getByRole("button")).toHaveCount(2);
  await expect(provenance.locator("img")).toHaveCount(1);
  await expect(provenance.getByText("Earlier revision", { exact: true })).toBeVisible();
});
