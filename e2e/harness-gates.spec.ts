import { test, expect, type Page } from "@playwright/test";
import { openView, key, settle, uncaught } from "./support";
import { sceneEvents, clearSceneEvents, expectActionContract, sampleFrames, byTransaction } from "./helpers/scene-events";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
const bandTiles = (page: Page, name: string) => stack(page, name).locator("[data-grid-band] [data-tile-key]");
const trace = <T>(page: Page, run: (trace: any) => T) => page.evaluate(`(${run.toString()})(window.trace)`) as Promise<Awaited<T>>;

test.describe("backend read gates", () => {
  test("a held node read keeps the view unchanged until it is released", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    const before = await page.locator("[data-tile-key]").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-tile-key")));
    await trace(page, (t) => t.backend.holdNodeReads());
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBe(1);
    const held = (await trace(page, (t) => t.backend.heldNodeReads()))[0];
    expect(held).toMatchObject({ method: "trace_component_nodes", offset: 0, directory: "/pictures" });
    expect(held.componentId).toBe(await stack(page, "photo-a").getAttribute("data-component"));
    // Nothing of the band is shown while its data is held.
    await page.waitForTimeout(300);
    await expect(bandTiles(page, "photo-a")).toHaveCount(0);
    expect(await page.locator("[data-tile-key]").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-tile-key")))).toEqual(before);
    expect(await trace(page, (t) => t.backend.releaseNextNodeRead())).toBe(true);
    await settle(page);
    expect(await trace(page, (t) => t.backend.heldNodeReads())).toEqual([]);
    await expect(bandTiles(page, "photo-a").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("a predicate holds only the matching component; others pass through", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    const heldId = (await stack(page, "photo-a").getAttribute("data-component"))!;
    await page.evaluate((id) => (window as any).trace.backend.holdNodeReads((read: { componentId: string }) => read.componentId === id), heldId);
    await stack(page, "photo-b").locator("[data-stack-toggle]").click();
    await settle(page);
    await expect(bandTiles(page, "photo-b").first()).toBeVisible();
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().map((read: { componentId: string }) => read.componentId))).toEqual([heldId]);
    await expect(bandTiles(page, "photo-a")).toHaveCount(0);
    await trace(page, (t) => t.backend.releaseNodeReads());
    await settle(page);
    await expect(bandTiles(page, "photo-a").first()).toBeVisible();
  });

  test("held reads keep the token of their request while later reads see the new index", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => t.backend.holdNodeReads());
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBe(1);
    const [first] = await trace(page, (t) => t.backend.heldNodeReads());
    await trace(page, (t) => t.backend.addInput("photo-a-edit", "photo-b"));
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBeGreaterThan(1);
    const held = await trace(page, (t) => t.backend.heldNodeReads());
    expect(held[0]).toEqual(first);
    expect(held.at(-1).token).not.toBe(first.token);
    await trace(page, (t) => t.backend.releaseNodeReads());
    await settle(page);
    expect(await uncaught(page)).toEqual([]);
  });

  test("a rejected node read surfaces as an error", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => t.backend.holdNodeReads());
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBe(1);
    expect(await trace(page, (t) => t.backend.rejectNextNodeRead("disk on fire"))).toBe(true);
    await expect(page.getByText(/disk on fire/)).toBeVisible();
    await expect(bandTiles(page, "photo-a")).toHaveCount(0);
    // With the gate released the stack can be opened again.
    await trace(page, (t) => t.backend.releaseNodeReads());
    const heading = stack(page, "photo-a").locator("[data-stack-toggle]");
    // Close the failed stack if it is still open, then open it again.
    if (await heading.getAttribute("aria-expanded") === "true") await heading.click();
    await heading.click();
    await settle(page);
    await expect(bandTiles(page, "photo-a").first()).toBeVisible();
  });

  test("folder reads can be held, released one at a time and rejected", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => t.backend.holdFolderReads((read: { method: string }) => read.method === "trace_folder_components"));
    await trace(page, (t) => t.backend.refresh());
    await expect.poll(() => trace(page, (t) => t.backend.heldFolderReads().map((read: { method: string }) => read.method))).toEqual(["trace_folder_components"]);
    expect(await trace(page, (t) => t.backend.rejectNextFolderRead("index unavailable"))).toBe(true);
    await expect(page.getByRole("alert")).toContainText("index unavailable");
    expect(await trace(page, (t) => t.backend.releaseNextFolderRead())).toBe(false);
  });

  test("resetGates stops holding and drops held reads", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => t.backend.holdNodeReads());
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.backend.heldNodeReads().length)).toBe(1);
    await trace(page, (t) => t.resetGates());
    expect(await trace(page, (t) => t.backend.heldNodeReads())).toEqual([]);
    await stack(page, "photo-b").locator("[data-stack-toggle]").click();
    await settle(page);
    await expect(bandTiles(page, "photo-b").first()).toBeVisible();
  });
});

test.describe("layout worker reply gate", () => {
  test("a held worker reply holds the band's layout until it is released", async ({ page }) => {
    await openView(page, 800, "?fanChildren=45", false);
    await trace(page, (t) => t.holdLayoutReplies());
    await stack(page, "fan").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.heldLayoutReplies().length)).toBeGreaterThan(0);
    const replies = await trace(page, (t) => t.heldLayoutReplies());
    expect(replies.every((reply: { error: string | null }) => reply.error === null)).toBe(true);
    expect(replies.some((reply: { itemKeys: string[] }) => reply.itemKeys.length > 40)).toBe(true);
    await page.waitForTimeout(300);
    await expect(bandTiles(page, "fan")).toHaveCount(0);
    await trace(page, (t) => t.releaseLayoutReplies());
    await settle(page);
    await expect(bandTiles(page, "fan").first()).toBeVisible();
    expect(await trace(page, (t) => t.heldLayoutReplies())).toEqual([]);
    expect(await uncaught(page)).toEqual([]);
  });

  test("replies are released one at a time, oldest first, keeping their ids", async ({ page }) => {
    await openView(page, 800, "?fanChildren=45", false);
    await trace(page, (t) => t.holdLayoutReplies());
    await stack(page, "fan").locator("[data-stack-toggle]").click();
    await expect.poll(() => trace(page, (t) => t.heldLayoutReplies().length)).toBeGreaterThan(0);
    const first = (await trace(page, (t) => t.heldLayoutReplies()))[0];
    expect(Number.isInteger(first.id)).toBe(true);
    // Releasing replies until none is left leaves the band laid out.
    for (let guard = 0; guard < 10 && await trace(page, (t) => t.releaseNextLayoutReply()); guard++) await settle(page);
    await trace(page, (t) => t.releaseLayoutReplies());
    await settle(page);
    await expect(bandTiles(page, "fan").first()).toBeVisible();
  });

  test("a predicate holds only matching replies", async ({ page }) => {
    await openView(page, 800, "?fanChildren=45", false);
    const child = await key(page, "fan-child-0");
    await page.evaluate((child) => (window as any).trace.holdLayoutReplies((reply: { itemKeys: string[] }) => !reply.itemKeys.includes(child)), child);
    await stack(page, "fan").locator("[data-stack-toggle]").click();
    await settle(page);
    // The reply containing the child is not held, so the band is laid out and shown.
    await expect(bandTiles(page, "fan").first()).toBeVisible();
    expect(await trace(page, (t) => t.heldLayoutReplies())).toEqual([]);
  });
});

test.describe("scene event sink", () => {
  test("records events from the production hooks with their metadata, and clears them", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => {
      t.scene.hooks.actionBegin({ transaction: 7, scope: "/pictures", geometryVersion: 3, requestKeys: ["c:1"] });
      t.scene.hooks.geometryPublication({ transaction: 7, scope: "/pictures", geometryVersion: 4, requestKeys: ["c:1", "c:2"] });
      t.scene.hooks.failure({ transaction: 8, scope: "/pictures", geometryVersion: 4, requestKeys: [], message: "nope" });
      t.scene.hooks.settled({ transaction: 7, scope: "/pictures", geometryVersion: 4, requestKeys: [] });
    });
    const events = await sceneEvents(page);
    expect(events.map((event) => [event.kind, event.transaction, event.geometryVersion])).toEqual([
      ["action-begin", 7, 3], ["geometry-publication", 7, 4], ["failure", 8, 4], ["settled", 7, 4]]);
    expect(events[1].requestKeys).toEqual(["c:1", "c:2"]);
    expect(events[2].message).toBe("nope");
    expect(await sceneEvents(page, "failure")).toHaveLength(1);
    expect([...byTransaction(events).keys()]).toEqual([7, 8]);
    expectActionContract(events, 7);
    await clearSceneEvents(page);
    expect(await sceneEvents(page)).toEqual([]);
  });

  test("production code that emits nothing records nothing", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await settle(page);
    expect(await sceneEvents(page)).toEqual([]);
  });

  test("expectActionContract rejects a second geometry publication", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    await trace(page, (t) => { for (let version = 1; version <= 2; version++) t.scene.hooks.geometryPublication({ transaction: 1, scope: "s", geometryVersion: version, requestKeys: [] }); });
    const events = await sceneEvents(page);
    expect(() => expectActionContract(events, 1)).toThrow();
    expect(() => expectActionContract(events, 1, { geometry: false })).toThrow();
  });

  test("frame sampling reports one result per presented frame", async ({ page }) => {
    await openView(page, 900, "?grouping=two-chains", false);
    const frames = await sampleFrames(page, () => document.querySelectorAll("[data-tile-key]").length, 200,
      () => stack(page, "photo-a").locator("[data-stack-toggle]").click());
    expect(frames.length).toBeGreaterThan(3);
    expect(frames.every((count) => Number.isInteger(count))).toBe(true);
  });
});
