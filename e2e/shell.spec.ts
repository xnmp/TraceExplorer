import { test, expect } from "@playwright/test";
import { openView, click, state, uncaught, settle, rendered, tile, ensureExpanded } from "./support";

const view = (page: import("@playwright/test").Page) => page.getByTestId("trace-view");
const builtin = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "Built-in listing" });

for (const host of [
  { name: "a host with ui/file-tile", query: "?fileTile=1", module: true },
  { name: "an older SDK 2 host", query: "", module: false },
]) {
  test(`with ${host.name}, the folder grid lists files without provenance and keeps selection, opening and menus working`, async ({ page }) => {
    await openView(page, undefined, host.query);
    // The host's Tiles view is a grid of gridcells with aria-selected; the built-in fallback is a list of buttons with aria-pressed.
    const list = page.getByRole("grid", { name: "Folder" });
    const selectedAttribute = "aria-selected";
    const entry = (path: string) => list.locator(`[data-entry-path="${path}"]`);
    await expect(list.locator("[data-entry-path]")).toHaveCount(3);
    for (const path of ["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]) await expect(entry(path)).toHaveCount(1);
    // The host's Tiles view renders the entries when available; the plugin then draws no icons of its own.
    await expect(page.locator("[data-host-file-tile]")).toHaveCount(host.module ? 3 : 0);
    if (host.module) await expect(list.locator("[data-host-file-tile] svg")).toHaveCount(0);

    const notes = entry("/pictures/notes.txt");
    await notes.click();
    await expect(notes).toHaveAttribute(selectedAttribute, "true");
    expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    await entry("/pictures/plain.png").click({ modifiers: ["Control"] });
    expect((await state(page)).selected.sort()).toEqual(["/pictures/notes.txt", "/pictures/plain.png"]);
    await notes.dblclick();
    expect((await state(page)).opened).toContain("/pictures/notes.txt");
    await entry("/pictures/plain.png").click();
    expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
    await expect(notes).toHaveAttribute(selectedAttribute, "false");
    // Selecting something without provenance removes any lineage dimming.
    expect(await rendered(page, "tone", "focus")).toEqual([]);

    // A context menu targets the entry, selecting it first.
    await entry("/pictures/refs").click({ button: "right" });
    const after = await state(page);
    expect(after.menus.at(-1)).toBe("/pictures/refs");
    expect(after.selected).toEqual(["/pictures/refs"]);

    // Keyboard: entries are focusable; the built-in buttons select on Space (the host's gridcells do not).
    await notes.focus();
    await expect(notes).toBeFocused();
    if (!host.module) {
      await page.keyboard.press("Space");
      expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    }
  });
}

test("an image whose only history is failed edits lists with the other files until an edit draws its section", async ({ page }) => {
  await openView(page, undefined, "?lone=1");
  const lonely = "/pictures/lonely.png";
  const others = page.getByRole("grid", { name: "Folder" });
  await expect(others.locator(`[data-entry-path="${lonely}"]`)).toHaveCount(1);
  await expect(others.locator("[data-entry-path]")).toHaveCount(4);
  await expect(await tile(page, "lonely")).toHaveCount(0);
  const sections = await page.locator("section.component[data-component]").count();

  // A new edit from it draws a relationship: the image gets its own section and leaves the ordinary files.
  await page.evaluate(() => (window as any).trace.backend.startGeneration("lonely", "retry"));
  await expect(page.locator("section.component[data-component]")).toHaveCount(sections + 1);
  await expect(others.locator(`[data-entry-path="${lonely}"]`)).toHaveCount(0);
  await expect(others.locator("[data-entry-path]")).toHaveCount(3);
  const section = page.locator('section.component[aria-label="lonely"]');
  await ensureExpanded(section);
  await expect(section.locator(await tile(page, "lonely"))).toHaveCount(1);
  await expect(section.locator(await tile(page, "retry"))).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("an image whose edit fails before any output goes back to the other files", async ({ page }) => {
  await openView(page, undefined, "?lone=1");
  const lonely = "/pictures/lonely.png";
  const others = page.getByRole("grid", { name: "Folder" });
  const sections = await page.locator("section.component[data-component]").count();
  await page.evaluate(() => (window as any).trace.backend.startGeneration("lonely", "retry"));
  await expect(page.locator("section.component[data-component]")).toHaveCount(sections + 1);
  await expect(others.locator(`[data-entry-path="${lonely}"]`)).toHaveCount(0);

  await page.evaluate(() => (window as any).trace.backend.failGeneration("retry"));
  await expect(page.locator("section.component[data-component]")).toHaveCount(sections);
  await expect(page.locator('section.component[aria-label="lonely"]')).toHaveCount(0);
  await expect(others.locator(`[data-entry-path="${lonely}"]`)).toHaveCount(1);
  await expect(others.locator("[data-entry-path]")).toHaveCount(4);
  expect(await uncaught(page)).toEqual([]);
});

test("a Preview target whose generation fails is cleared and dims no section", async ({ page }) => {
  await openView(page, undefined, "?lone=1");
  await page.evaluate(() => (window as any).trace.backend.startGeneration("lonely", "retry"));
  const section = page.locator('section.component[aria-label="lonely"]');
  await expect(section).toHaveCount(1);
  await ensureExpanded(section);
  await click(page, "retry");
  expect((await state(page)).target?.badge).toBe("Generating");
  await expect(page.locator("section.component.dimmed[data-component]")).not.toHaveCount(0);

  await page.evaluate(() => (window as any).trace.backend.failGeneration("retry"));
  await expect(section).toHaveCount(0);
  await expect.poll(async () => (await state(page)).target).toBeNull();
  await expect(page.locator("section.component.dimmed[data-component]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("the toggle command switches to the built-in listing and back", async ({ page }) => {
  await openView(page);
  await expect(view(page)).toBeVisible();
  await page.evaluate(() => (window as any).trace.toggle());
  await expect(builtin(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect((await state(page)).fileView).toBeNull();
  await page.evaluate(() => (window as any).trace.toggle());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  // Stacks start closed; opening the village's shows its lineage again.
  await ensureExpanded(page.locator('section[data-component][aria-label="village"]'));
  await click(page, "warm");
  expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
});

test("a folder without provenance shows the built-in listing while the Trace view stays chosen", async ({ page }) => {
  await openView(page);
  await page.evaluate(() => (window as any).trace.navigate("/elsewhere"));
  await expect(builtin(page)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  expect((await state(page)).fileView).toBe("trace.view");
  await page.evaluate(() => (window as any).trace.navigate("/pictures"));
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
});

test("disabling removes the view cleanly and re-enabling restores a working one", async ({ page }) => {
  await openView(page);
  await click(page, "warm");
  await page.evaluate(() => (window as any).trace.disable());
  await expect(view(page)).toHaveCount(0);
  await expect(page.locator("[data-tile-key]")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  expect(await uncaught(page)).toEqual([]);
  await page.evaluate(() => (window as any).trace.enable());
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  await settle(page);
  await click(page, "rain");
  expect(await rendered(page, "tone", "focus")).toEqual(["rain"]);
  expect(await rendered(page, "tone", "related")).toContain("quiet");
  expect(await uncaught(page)).toEqual([]);
});


test("a preloaded Trace folder paints Trace on its first visit with no plain listing frame", async ({ page }) => {
  await page.goto("/view.html?directory=/ordinary");
  await page.waitForFunction(() => !!(window as any).trace);
  await expect(builtin(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).trace.backend.calls("folder_has_trace").filter((call: any) => call.params.directory === "/pictures"))).toEqual([]);
  expect(await page.evaluate(() => (window as any).trace.backend.calls("trace_folder_candidates").length)).toBe(1);

  // Start before navigation. Native IPC stays in flight across many frames;
  // no folder session or exact visibility answer has been cached for /pictures.
  await page.evaluate(async () => {
    const w = window as any;
    w.trace.backend.setFolderLatency(600);
    w.firstVisitFrames = [];
    let running = true;
    w.stopFirstVisitSampling = () => { running = false; };
    const sample = () => {
      const pane = document.querySelector('[aria-label="Explorer pane"]')!;
      w.firstVisitFrames.push({ directory: pane.getAttribute("data-directory"),
        view: pane.querySelector('[data-file-view="trace.view"]') ? "trace" : pane.querySelector('.builtin') ? "listing" : "empty" });
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    w.trace.navigate("/pictures");
  });
  await expect(view(page)).toBeVisible();
  await expect(page.locator("[data-tile-key]").first()).toBeVisible({ timeout: 20_000 });
  await settle(page);
  const frames = await page.evaluate(() => { (window as any).stopFirstVisitSampling(); return (window as any).firstVisitFrames as Array<{ directory: string; view: string }>; });
  expect(frames.some((frame) => frame.directory === "/ordinary" && frame.view === "listing")).toBe(true);
  const visited = frames.filter((frame) => frame.directory === "/pictures");
  expect(visited.length).toBeGreaterThan(0);
  expect(visited[0].view).toBe("trace");
  expect(visited.every((frame) => frame.view === "trace")).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});
