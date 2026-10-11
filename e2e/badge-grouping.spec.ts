import { test, expect } from "@playwright/test";
import { openView, key, state, settle, uncaught } from "./support";

test("two chains sharing only a style render separate stacks with one reference badge each", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains");
  const sections = page.locator("section[data-component]");
  await expect(sections).toHaveCount(2);
  const style = await key(page, "style");
  for (const name of ["photo-a", "photo-b"]) {
    const section = page.locator(`section[data-component][aria-label="${name}"]`);
    await expect(section).toHaveAttribute("data-stack-count", "2 images");
    await expect(section.locator(`[data-reference-key="${style}"]`)).toHaveCount(1);
    await expect(section.locator(`[data-node-key="${await key(page, `${name}-edit`)}"]`)).toBeVisible();
  }
  // A duplicated node key must still select the clicked section's copy and
  // Preview path, and must enter the AI inputs only once.
  const a = page.locator('section[data-component][aria-label="photo-a"]');
  const b = page.locator('section[data-component][aria-label="photo-b"]');
  await a.locator(`[data-reference-key="${style}"]`).click();
  await settle(page);
  expect((await state(page)).inputs).toEqual(["/pictures/refs/style.png"]);
  expect((await state(page)).target?.title).toBe("style.png");
  await expect(page.locator(`[data-tile-key="${style}"]`)).toHaveCount(0);
  for (const name of ["photo-a-edit", "photo-b-edit"]) await expect(page.locator(`[data-tile-key="${await key(page, name)}"]`)).toHaveAttribute("data-tone", "related");
  await expect(page.locator(`path[data-from="node:${style}"]`)).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("one style applied to many photos remains one copy per separate stack", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1600 });
  await openView(page, 900, "?grouping=style-many");
  const sections = page.locator("section[data-component]");
  await expect(sections).toHaveCount(4);
  for (const heading of await sections.locator("[data-stack-toggle]").all()) {
    if (await heading.getAttribute("aria-expanded") === "false") await heading.click();
  }
  const style = await key(page, "style");
  await expect(page.locator(`[data-reference-key="${style}"]`)).toHaveCount(4);
  for (const name of ["photo-a", "photo-b", "photo-c", "photo-d"]) {
    const section = page.locator(`section[data-component][aria-label="${name}"]`);
    await expect(section).toHaveAttribute("data-stack-count", "2 images");
    await expect(section.locator(`[data-node-key="${await key(page, name)}"]`)).toBeVisible();
  }
  expect(await uncaught(page)).toEqual([]);
});

test("a generated cover keeps its external reference without counting it as a folder image", async ({ page }) => {
  await openView(page, 900, "?grouping=external-cover");
  const section = page.locator('section[data-component][aria-label="cover"]');
  await expect(section).toHaveAttribute("data-stack-count", "2 images");
  for (const name of ["cover", "cover-edit"]) {
    await expect(section.locator(`[data-node-key="${await key(page, name)}"]`)).toBeVisible();
  }
  // The reference fed both images, so each carries its own badge for it.
  const reference = await key(page, "reference");
  await expect(section.locator(`[data-reference-key="${reference}"]`)).toHaveCount(2);
  await section.locator(`[data-tile-key="${await key(page, "cover")}"]`).locator(`[data-reference-key="${reference}"]`).click();
  await settle(page);
  expect((await state(page)).inputs).toEqual(["/elsewhere/reference.png"]);
  expect((await state(page)).target?.title).toBe("reference.png");
  expect(await uncaught(page)).toEqual([]);
});

test("a missing reference Preview survives merging and splitting its stacks", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains");
  await page.evaluate(() => (window as any).trace.backend.setNodeStatus("style", { state: "missing" }));
  await settle(page);
  const style = await key(page, "style");
  await page.locator('section[data-component][aria-label="photo-b"]').locator(`[data-reference-key="${style}"]`).click();
  await settle(page);
  await page.evaluate(() => {
    (window as any).trace.backend.setFolderLatency(30);
    (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined");
  });
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await settle(page);
  expect((await state(page)).target?.title).toBe("style.png");
  await page.evaluate(() => (window as any).trace.backend.failGeneration("joined"));
  await expect(page.locator("section[data-component]")).toHaveCount(2);
  await settle(page);
  expect((await state(page)).target?.title).toBe("style.png");
  expect(await uncaught(page)).toEqual([]);
});
