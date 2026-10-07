import { test, expect, type Page } from "@playwright/test";

async function respond(page: Page, path: string, status = "matched") {
  await page.waitForFunction((path) => (window as any).traceHarness.pending().some((request: any) => request.path === path), path);
  await page.evaluate(({ path, status }) => {
    const api = (window as any).traceHarness;
    api.succeed(api.pending().filter((request: any) => request.path === path).at(-1).id, status);
  }, { path, status });
}

for (const status of ["changed", "unverified"]) {
  test(`${status} revisions distinguish live file previews from the recorded revision`, async ({ page }) => {
    await page.goto("/"); await respond(page, "/fixture/one/source.png", status);
    const source = page.locator(".artifact").filter({ has: page.locator("strong", { hasText: /^source\.png$/ }) });
    await expect(source.locator("img")).toBeVisible();
    await expect(source.locator(".thumbnail small")).toHaveText(status === "changed" ? "Modified file preview" : "Unverified file preview");
    await expect(source.locator(".artifact-text small")).toHaveText("Last recorded");
    const fits = await source.evaluate((node) => node.querySelector(".artifact-text")!.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom);
    expect(fits).toBe(true);
    await expect(page.getByText("Current file preview", { exact: true })).toHaveCount(0);
  });
}

test("tree navigation and remounts reuse loaded thumbnails without placeholders or new reads", async ({ page }) => {
  await page.goto("/");
  await respond(page, "/fixture/one/source.png");
  await expect(page.locator(".artifact img")).toHaveCount(3);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".artifact img")].every((image) => image.complete && image.naturalWidth > 0));
  const sources = await page.locator(".artifact img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src));
  await page.evaluate(() => {
    (window as any).thumbnailPlaceholders = [];
    new MutationObserver(() => {
      const count = document.querySelectorAll(".artifact .placeholder").length;
      if (count) (window as any).thumbnailPlaceholders.push(count);
    }).observe(document.querySelector(".inspector")!, { childList: true, subtree: true });
  });
  await page.locator('.artifact[data-path="/fixture/two/source_edit_2.png"]').click();
  await expect(page.locator("[data-explorer-selection]")).toHaveText("/fixture/two/source_edit_2.png");
  await expect(page.locator(".artifact img")).toHaveCount(3);
  expect(await page.locator(".artifact img").evaluateAll((images) => images.map((image) => (image as HTMLImageElement).src))).toEqual(sources);
  await respond(page, "/fixture/two/source_edit_2.png");
  await page.getByRole("button", { name: "Remount inspector", exact: true }).click();
  await expect(page.locator(".artifact img")).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).traceHarness.thumbnailCalls())).toHaveLength(3);
  expect(await page.evaluate(() => (window as any).thumbnailPlaceholders)).toEqual([]);
});

test("refresh keeps images and their geometry visible until updated thumbnails are ready", async ({ page }) => {
  await page.goto("/"); await respond(page, "/fixture/one/source.png");
  await expect(page.locator(".artifact img")).toHaveCount(3);
  const before = await page.locator(".thumbnail").evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  await page.evaluate(() => (window as any).traceHarness.holdThumbnails());
  await page.getByRole("button", { name: "Refresh trace", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).traceHarness.thumbnailCalls().length)).toBe(6);
  await expect(page.locator(".artifact img")).toHaveCount(3);
  await expect(page.locator(".artifact .placeholder")).toHaveCount(0);
  expect(await page.locator(".thumbnail").evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })))).toEqual(before);
  await respond(page, "/fixture/one/source.png");
  await page.evaluate(() => (window as any).traceHarness.releaseThumbnails());
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".artifact img")].every((image) => image.complete && image.naturalWidth > 0));
  await expect(page.locator(".artifact .placeholder")).toHaveCount(0);
});

for (const theme of ["light", "dark"]) {
  test(`cards are compact, remove redundant captions, and distinguish selection in ${theme} mode`, async ({ page }) => {
    await page.goto("/"); await respond(page, "/fixture/one/source.png");
    if (theme === "dark") await page.addStyleTag({ content: "body { --text-primary:#f3f3f3;--text-secondary:#a2a2a2;--background-card-secondary:#242424;--background-solid:#191919;--control-stroke:#484848;--accent-text:#91bdff; } .inspector { background:#191919; }" });
    await expect(page.locator(".artifact img")).toHaveCount(3);
    await expect(page.getByText("Current file preview", { exact: true })).toHaveCount(0);
    const cards = await page.locator(".artifact").evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); const text = node.querySelector(".artifact-text")!.getBoundingClientRect(); const style = getComputedStyle(node);
      return { selected: node.getAttribute("aria-pressed") === "true", bottomGap: rect.bottom - text.bottom, border: style.borderColor, background: style.backgroundColor, ring: style.boxShadow };
    }));
    for (const card of cards) {
      expect(card.bottomGap).toBeGreaterThanOrEqual(0);
      expect(card.bottomGap).toBeLessThanOrEqual(4);
    }
    const selected = cards.find((card) => card.selected)!; const other = cards.find((card) => !card.selected)!;
    expect(selected.border).not.toBe(other.border);
    expect(selected.background).not.toBe(other.background);
    expect(selected.ring).not.toBe("none");
    await page.screenshot({ path: `/tmp/trace-thumbnails-${theme}.png` });
  });
}
