/**
 * The scene transaction contract (docs/scene-transactions.md §4–5), against the real view and the
 * mock backend's gates: the previous scene stays displayed while the next is prepared, an action
 * publishes geometry once, superseded work never publishes, and cold opens fail in their cover.
 */
import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught, key, state } from "./support";
import { sceneEvents, clearSceneEvents, expectActionContract, sampleFrames, byTransaction } from "./helpers/scene-events";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
const toggle = (page: Page, name: string) => stack(page, name).locator("[data-stack-toggle]");
const trace = <T>(page: Page, run: (trace: any) => T) => page.evaluate(`(${run.toString()})(window.trace)`) as Promise<Awaited<T>>;
/** What a frame shows: every tile with its position, and every band. */
const drawn = () => JSON.stringify([
  [...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => { const box = tile.getBoundingClientRect(); return [tile.dataset.tileKey, Math.round(box.left), Math.round(box.top)]; }).sort(),
  [...document.querySelectorAll<HTMLElement>("[data-grid-band]")].map((band) => band.dataset.gridBand).sort(),
]);
const publications = async (page: Page) => (await sceneEvents(page, "geometry-publication"));
const componentOf = async (page: Page, name: string) => (await stack(page, name).getAttribute("data-component"))!;

test("a new index waits for its open stack's held node page, then commits once", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await toggle(page, "photo-a").click();
  await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  const before = await page.evaluate(drawn);
  await clearSceneEvents(page);
  await trace(page, (t) => t.backend.holdNodeReads());
  // The edit gains an input from the other chain: one merged stack, whose nodes must be read again.
  const frames = await sampleFrames(page, drawn, 600, async () => {
    await trace(page, (t) => t.backend.addInput("photo-a-edit", "photo-b"));
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBeGreaterThan(0);
  });
  expect(new Set(frames), "the committed scene stays exactly as drawn while the page is held").toEqual(new Set([before]));
  expect(await publications(page)).toEqual([]);
  await trace(page, (t) => t.backend.releaseNodeReads());
  await settle(page);
  const published = await publications(page);
  expect(published).toHaveLength(1);
  expectActionContract(await sceneEvents(page), published[0].transaction);
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("a held worker layout keeps the previous scene until its reply, then commits once", async ({ page }) => {
  await openView(page, 800, "?fanChildren=45", false);
  const before = await page.evaluate(drawn);
  await clearSceneEvents(page);
  await trace(page, (t) => t.holdLayoutReplies());
  const frames = await sampleFrames(page, drawn, 500, async () => {
    await toggle(page, "fan").click();
    await expect.poll(() => trace(page, (t) => t.heldLayoutReplies().length)).toBeGreaterThan(0);
  });
  expect(new Set(frames)).toEqual(new Set([before]));
  expect(await trace(page, (t) => t.heldLayoutReplies().map((reply: { kind: string }) => reply.kind))).toContain("folder");
  expect(await publications(page)).toEqual([]);
  await trace(page, (t) => t.releaseLayoutReplies());
  await settle(page);
  const published = await publications(page);
  expect(published).toHaveLength(1);
  expectActionContract(await sceneEvents(page), published[0].transaction);
  await expect(stack(page, "fan").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  expect(await uncaught(page)).toEqual([]);
});

test("pressing a cold cover selects and expands it in one commit", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await clearSceneEvents(page);
  const frames = await sampleFrames(page, (() => {
    const section = document.querySelector(`section[data-component][aria-label="photo-b"]`)!;
    return [!!section.querySelector("[data-grid-band] [data-tile-key]"), !!section.querySelector(".card.selected")];
  }) as () => boolean[], 600, () => stack(page, "photo-b").locator(".cover-press").click());
  // Never the band without the selection, nor the selection without the band.
  expect(frames.every(([band, selected]) => band === selected), JSON.stringify(frames)).toBe(true);
  expect(frames.at(-1)).toEqual([true, true]);
  await settle(page);
  const events = await sceneEvents(page);
  const published = events.filter((event) => event.kind === "geometry-publication");
  expect(published).toHaveLength(1);
  expectActionContract(events, published[0].transaction);
  // A listed cover is selected in the host.
  expect((await state(page)).selected).toEqual(["/pictures/photo-b.png"]);
  expect(await uncaught(page)).toEqual([]);
});

test("a superseded action publishes nothing, even when its data arrives last", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  const a = await componentOf(page, "photo-a");
  await page.evaluate((id) => (window as any).trace.backend.holdNodeReads((read: { componentId: string }) => read.componentId === id), a);
  await clearSceneEvents(page);
  await toggle(page, "photo-a").click();
  await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBe(1);
  const first = (await sceneEvents(page, "action-begin")).at(-1)!.transaction;
  // B: photo-b's data is not held, but the scene still needs A's requested open; nothing partial shows.
  const frames = await sampleFrames(page, (() => document.querySelectorAll("[data-grid-band]").length) as () => number, 400,
    () => toggle(page, "photo-b").click());
  expect(Math.max(...frames)).toBe(0);
  const second = (await sceneEvents(page, "action-begin")).at(-1)!.transaction;
  expect(second).toBeGreaterThan(first);
  await trace(page, (t) => t.backend.releaseNodeReads());
  await settle(page);
  const events = await sceneEvents(page);
  const grouped = byTransaction(events);
  expect(grouped.get(first)!.filter((event) => event.kind === "geometry-publication")).toHaveLength(0);
  const published = events.filter((event) => event.kind === "geometry-publication");
  expect(published).toHaveLength(1);
  expect(published[0].transaction).toBeGreaterThanOrEqual(second);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
  expect(await uncaught(page)).toEqual([]);
});

test("closing a pending open cancels it at once, and its late data never opens it", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await trace(page, (t) => t.backend.holdNodeReads());
  await clearSceneEvents(page);
  await toggle(page, "photo-a").click();
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-label", "Cancel opening stack");
  await expect(stack(page, "photo-a").locator('[aria-busy="true"]')).toHaveCount(1);
  await toggle(page, "photo-a").click();
  // Cleared immediately, without awaiting any read or worker.
  await expect(stack(page, "photo-a").locator("[data-cover-progress]")).toHaveCount(0);
  await expect(stack(page, "photo-a").locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-label", "Expand stack");
  await trace(page, (t) => t.backend.releaseNodeReads());
  await settle(page);
  await page.waitForTimeout(200);
  await expect(page.locator("[data-grid-band]")).toHaveCount(0);
  expect(await publications(page)).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});

test("a cold open that times out fails in its cover, never opens late, and Retry works after a merge", async ({ page }) => {
  test.setTimeout(test.info().timeout + 10_000);
  await openView(page, 900, "?grouping=two-chains", false);
  const a = await componentOf(page, "photo-a");
  await page.evaluate((id) => (window as any).trace.backend.holdNodeReads((read: { componentId: string }) => read.componentId === id), a);
  await clearSceneEvents(page);
  const geometry = await page.evaluate(drawn);
  await toggle(page, "photo-a").click();
  const error = stack(page, "photo-a").locator("[data-cover-error]");
  await expect(error).toBeVisible({ timeout: 8000 });
  await expect(error).toHaveAttribute("title", /too long/);
  await expect(stack(page, "photo-a").locator("[data-cover-progress]")).toHaveCount(0);
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-expanded", "false");
  expect((await sceneEvents(page, "failure")).some((event) => /too long/.test(event.message ?? ""))).toBe(true);
  // The held reply arrives late: nothing opens, nothing moves.
  await trace(page, (t) => t.backend.releaseNodeReads());
  await page.waitForTimeout(300);
  await settle(page);
  expect(await page.evaluate(drawn)).toBe(geometry);
  await expect(error).toBeVisible();
  expect(await publications(page)).toEqual([]);
  // The components merge: the failed cover's stable key resolves to the merged stack, whose Retry opens it.
  await trace(page, (t) => t.backend.joinGeneration(["photo-a", "photo-b"], "joined"));
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  const merged = page.locator("section[data-component]");
  await expect(merged.locator("[data-cover-error]")).toBeVisible();
  await merged.locator("[data-cover-retry]").click();
  await settle(page);
  await expect(merged.locator("[data-cover-error]")).toHaveCount(0);
  await expect(merged.locator(`[data-grid-band] [data-tile-key="${await key(page, "photo-a-edit")}"]`)).toHaveCount(1);
  await expect(merged.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  expect(await uncaught(page)).toEqual([]);
});

test("an open stack that can no longer be read fails in its cover; the rest of the folder still updates", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await toggle(page, "photo-a").click();
  await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await expect(stack(page, "photo-b")).toHaveAttribute("data-stack-count", "2 images");
  await trace(page, (t) => t.backend.failNodeReads(1000));
  await trace(page, (t) => { t.backend.startGeneration("photo-b", "gen-x"); t.backend.completeGeneration("gen-x"); t.backend.saveGeneration("gen-x"); });
  // One unreadable stack never blocks the folder: photo-b updates, photo-a shows its error and Retry, drawn closed.
  await expect(stack(page, "photo-b")).toHaveAttribute("data-stack-count", "3 images");
  const error = stack(page, "photo-a").locator("[data-cover-error]");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("title", /could not read/);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
  await settle(page);
  await expect(page.locator(".overlay[role=alert]")).toHaveCount(0);
  // It is still requested open: Retry reads it again and reopens it.
  await trace(page, (t) => t.backend.failNodeReads(0));
  await stack(page, "photo-a").locator("[data-cover-retry]").click();
  await settle(page);
  await expect(error).toHaveCount(0);
  await expect(stack(page, "photo-a").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-expanded", "true");
  expect(await uncaught(page)).toEqual([]);
});

test("a second press on a cover that is still opening selects it and keeps it opening", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await trace(page, (t) => t.backend.setFolderLatency(400));
  await stack(page, "photo-b").locator(".cover-press").dblclick();
  await settle(page);
  await expect(stack(page, "photo-b").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await expect(page.locator("[data-grid-band]")).toHaveCount(1);
  expect((await state(page)).selected).toEqual(["/pictures/photo-b.png"]);
  // Only the disclosure cancels a pending open.
  await trace(page, (t) => t.backend.holdNodeReads());
  await toggle(page, "photo-a").click();
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-label", "Cancel opening stack");
  await stack(page, "photo-a").locator(".cover-press").click();
  await expect(toggle(page, "photo-a")).toHaveAttribute("aria-label", "Cancel opening stack");
  await trace(page, (t) => t.backend.releaseNodeReads());
  await settle(page);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
  expect(await uncaught(page)).toEqual([]);
});

// Review of dc33274 (H1): with the host's grid padding, a scene already wider than its pane, at an
// unchanged width, is still laid out off the main thread; only a pane that narrowed past the scene
// forces an inline layout.
for (const [label, query] of [["host grid padding", "&fileTile=1"], ["no grid padding", ""]] as const) {
  test(`a click inside a scene wider than its pane goes to the worker (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
    await openView(page, 400, `?fanChildren=200&wideRoots=70${query}`, false);
    await toggle(page, "wr-0").click();
    await settle(page);
    const wide = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!, grid = view.querySelector<HTMLElement>('[role="grid"]')!;
      return { view: view.clientWidth, grid: grid.getBoundingClientRect().width };
    });
    expect(wide.grid, "the scene is wider than its pane").toBeGreaterThan(wide.view);
    await trace(page, (t) => t.holdLayoutReplies());
    await toggle(page, "fan").evaluate((element: HTMLElement) => element.click());
    await expect.poll(() => trace(page, (t) => t.heldLayoutReplies().length), { message: "the expand was laid out by the worker" }).toBeGreaterThan(0);
    await trace(page, (t) => t.releaseLayoutReplies());
    await settle(page);
    await expect(toggle(page, "fan")).toHaveAttribute("aria-expanded", "true");
    expect(await uncaught(page)).toEqual([]);
  });
}
