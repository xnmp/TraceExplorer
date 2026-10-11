import { test, expect, type Page } from "@playwright/test";
import { openView, key, state, settle, uncaught } from "./support";
import { holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
const gridBoxes = (page: Page) => page.evaluate(() => {
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
  return Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((element) => {
    const box = element.getBoundingClientRect();
    return [element.dataset.gridCell!, { x: box.x, y: box.y + view.scrollTop, width: box.width }];
  }));
});
const sameColumns = (before: Awaited<ReturnType<typeof gridBoxes>>, after: Awaited<ReturnType<typeof gridBoxes>>) => {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const id of Object.keys(before)) expect(after[id].x, id).toBeCloseTo(before[id].x, 1);
};

for (const host of ["", "&fileTile=1&tileSize=medium"]) {
  test(`opening and closing stacks preserves every column and the cover's position (${host ? "host tile" : "fallback"})`, async ({ page }) => {
    await openView(page, 420, `?grouping=style-many${host}`, false);
    const before = await gridBoxes(page), cover = stack(page, "photo-a").locator("[data-tile-key]");
    const coverX = (await cover.boundingBox())!.x;
    await cover.click(); await settle(page);
    sameColumns(before, await gridBoxes(page));
    expect((await stack(page, "photo-a").locator(`[data-tile-key="${await key(page, "photo-a")}"]`).boundingBox())!.x).toBeCloseTo(coverX, 1);
    await expect(stack(page, "photo-a").locator(`[data-node-key="${await key(page, "photo-a-edit")}"]`)).toBeVisible();
    await stack(page, "photo-a").getByRole("button", { name: "Close stack" }).click(); await settle(page);
    sameColumns(before, await gridBoxes(page));
    expect((await stack(page, "photo-a").locator("[data-tile-key]").boundingBox())!.x).toBeCloseTo(coverX, 1);
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    expect((await state(page)).selected).toEqual(["/pictures/photo-a.png"]);
    await expect(stack(page, "photo-a").locator("[data-stack-toggle]")).toHaveClass(/selected/);
  });
}

test("selection inside a band moves only rows below vertically, including another open band", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1400 });
  await openView(page, 220, "?deeper=1", false);
  for (const name of ["village", "forest"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await stack(page, "village").locator(`[data-node-key="${await key(page, "warm")}"]`).click(); await settle(page);
  const before = await gridBoxes(page);
  const forestChild = page.locator(`[data-tile-key="${await key(page, "forest-mist")}"]`);
  const childBefore = await forestChild.evaluate((element) => element.getBoundingClientRect().y + document.querySelector<HTMLElement>('[data-testid="trace-view"]')!.scrollTop);
  await holdScriptedAnimations(page);
  let samples: Awaited<ReturnType<typeof gridBoxes>>[];
  try {
    await stack(page, "village").locator(`[data-node-key="${await key(page, "rain")}"]`).click();
    await page.waitForFunction(() => (window as any).trace.layoutsPending() === 0);
    samples = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await frame();
      const animations = ((window as any).__heldAnimations as Animation[]).filter((animation) => animation.playState === "running");
      const view = document.querySelector<HTMLElement>('[data-testid="trace-view"]')!;
      const samples = [];
      for (const time of [0, 40, 80, 120, 160]) {
        for (const animation of animations) animation.currentTime = time;
        await frame();
        samples.push(Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((element) => {
          const box = element.getBoundingClientRect();
          return [element.dataset.gridCell!, { x: box.x, y: box.y + view.scrollTop, width: box.width }];
        })));
      }
      return samples;
    });
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  const after = await gridBoxes(page); sameColumns(before, after);
  // The village band grows under the village cover, so the cover stays put while every row below it,
  // including the other open stack's cover, only slides vertically by the band's growth.
  const village = await key(page, "village"), forest = await key(page, "forest"), below = await key(page, "fan");
  for (const sample of samples) {
    sameColumns(before, sample);
    expect(sample[village].y).toBeCloseTo(before[village].y, 1);
  }
  const delta = after[below].y - before[below].y;
  expect(Math.abs(delta)).toBeGreaterThan(40);
  expect(after[forest].y - before[forest].y).toBeCloseTo(delta, 1);
  expect(samples.some((sample) => Math.abs(sample[below].y - before[below].y) > 1 && Math.abs(sample[below].y - after[below].y) > 1)).toBe(true);
  expect(after["/pictures/notes.txt"].y - before["/pictures/notes.txt"].y).toBeCloseTo(delta, 1);
  const childAfter = await forestChild.evaluate((element) => element.getBoundingClientRect().y + document.querySelector<HTMLElement>('[data-testid="trace-view"]')!.scrollTop);
  expect(childAfter - childBefore).toBeCloseTo(delta, 1);
});

test("a shared style is one badge on each of two separate stacks; click selects its path and hover highlights both consumers", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  const style = await key(page, "style");
  await expect(page.locator("section[data-component]")).toHaveCount(2);
  await expect(page.locator(`[data-tile-key="${style}"]`)).toHaveCount(0);
  const badges = page.locator(`[data-reference-key="${style}"]`); await expect(badges).toHaveCount(2);
  await badges.first().hover(); await settle(page);
  for (const name of ["photo-a-edit", "photo-b-edit"]) await expect(page.locator(`[data-tile-key="${await key(page, name)}"]`)).toHaveAttribute("data-tone", "related");
  await badges.last().click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/pictures/refs/style.png"]);
  expect(await page.evaluate(() => (window as any).trace.state().target.imagePath)).toBe("/pictures/refs/style.png");
  await expect(page.locator(`path[data-from="node:${style}"], path[data-to="node:${style}"]`)).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("a cover made from an external reference hangs in place with its reference badge", async ({ page }) => {
  await openView(page, 420, "?grouping=external-cover", false);
  const before = await gridBoxes(page);
  await stack(page, "cover").locator("[data-stack-toggle]").click(); await settle(page);
  sameColumns(before, await gridBoxes(page));
  const reference = await key(page, "reference"), cover = await key(page, "cover");
  // The reference fed both images, so each carries a badge for it.
  await expect(page.locator(`[data-tile-key="${cover}"] [data-reference-key="${reference}"]`)).toBeVisible();
  await expect(page.locator(`[data-tile-key="${await key(page, "cover-edit")}"] [data-reference-key="${reference}"]`)).toBeVisible();
  await expect(page.locator(`[data-tile-key="${reference}"]`)).toHaveCount(0);
  const root = (await page.locator(`[data-tile-key="${cover}"]`).boundingBox())!;
  const child = (await page.locator(`[data-tile-key="${await key(page, "cover-edit")}"]`).boundingBox())!;
  expect(child.y).toBeGreaterThan(root.y + root.height);
  await page.locator(`[data-tile-key="${cover}"] [data-reference-key="${reference}"]`).click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/elsewhere/reference.png"]);
});

test("reference overflow expands to selectable references with path and scope tooltips", async ({ page }) => {
  await openView(page, 420, "?moreBadges=1");
  const warm = stack(page, "village").locator(`[data-tile-key="${await key(page, "warm")}"]`);
  await expect(warm.locator("[data-reference-key]")).toHaveCount(3);
  await warm.getByRole("button", { name: "Show 1 more references" }).click();
  await expect(warm.locator("[data-reference-key]")).toHaveCount(4);
  const reference = warm.locator(`[data-reference-key="${await key(page, "reference-4")}"]`);
  await reference.hover();
  await expect(page.getByRole("tooltip")).toContainText("/elsewhere/reference-4.png");
  await expect(page.getByRole("tooltip")).toContainText(/Outside this folder/i);
  await reference.click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/elsewhere/reference-4.png"]);
});

test("hovering a reference preserves a deeper selected tile and keyboard focus", async ({ page }) => {
  await openView(page, 420);
  for (const name of ["warm", "rain", "quiet"]) {
    await page.locator(`[data-node-key="${await key(page, name)}"]`).click(); await settle(page);
  }
  const selected = page.locator(`[data-node-key="${await key(page, "quiet")}"]`);
  await selected.focus();
  const before = await selected.boundingBox();
  await stack(page, "village").locator(`[data-reference-key="${await key(page, "mist")}"]`).hover(); await settle(page);
  await expect(selected).toBeFocused();
  await expect(selected).toBeVisible();
  await expect(page.locator(`[data-tile-key="${await key(page, "quiet")}"]`)).toHaveAttribute("data-tone", "focus");
  expect(await selected.boundingBox()).toEqual(before);
  expect((await state(page)).selected).toEqual(["/pictures/quiet.png"]);
});

test("closing during emergence reverses from the displayed tile position and opacity", async ({ page }) => {
  await openView(page, 420, "?grouping=two-chains", false);
  await holdScriptedAnimations(page);
  try {
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    const child = await key(page, "photo-a-edit");
    await expect(page.locator(`[data-node-key="${child}"]`)).toHaveCount(1);
    await page.waitForFunction(() => (window as any).trace.layoutsPending() === 0);
    const result = await page.evaluate(async (key) => {
      const w = window as any, frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await frame();
      for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 40;
      await frame();
      const tile = document.querySelector<HTMLElement>(`[data-tile-key="${key}"]`)!;
      const before = { y: tile.getBoundingClientRect().y, opacity: Number(getComputedStyle(tile).opacity) };
      tile.closest("section")!.querySelector<HTMLElement>('[aria-label="Close stack"]')!.click();
      await frame();
      const ghost = document.querySelector<HTMLElement>(`[data-grid-ghost] [data-ghost-tile-key="${key}"]`)!;
      const closing = (w.__heldAnimations as Animation[]).filter((animation) => animation.playState === "running");
      const samples = [];
      for (const time of [0, 40, 80, 120]) {
        for (const animation of closing) animation.currentTime = time;
        await frame();
        samples.push({ y: ghost.getBoundingClientRect().y, opacity: Number(getComputedStyle(ghost).opacity) });
      }
      return { before, samples };
    }, child);
    expect(result.samples[0].y).toBeCloseTo(result.before.y, 0);
    expect(result.samples[0].opacity).toBeCloseTo(result.before.opacity, 2);
    let previous = result.before;
    for (const sample of result.samples) {
      expect(sample.y).toBeLessThanOrEqual(previous.y + .5);
      expect(sample.opacity).toBeLessThanOrEqual(previous.opacity + .02);
      previous = sample;
    }
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("host selection opens every selected stack and focused bands survive refreshed component ids", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await page.evaluate(() => (window as any).trace.setSelection(["/pictures/photo-a-edit.png", "/pictures/photo-b-edit.png"])); await settle(page);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined")); await settle(page);
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await expect(page.locator("[data-grid-band]")).toHaveCount(1);
  await page.evaluate(() => (window as any).trace.backend.failGeneration("joined")); await settle(page);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
});

test("grid Shift selection follows listing ranges and unchanged selection contents do not notify", async ({ page }) => {
  await openView(page, 900, "", false);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click();
  const before = await page.evaluate(() => (window as any).trace.state().selectionNotifications);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click();
  expect(await page.evaluate(() => (window as any).trace.state().selectionNotifications)).toBe(before);
  await page.locator('[data-entry-path="/pictures/refs"]').click({ modifiers: ["Shift"] });
  expect((await state(page)).selected).toEqual(["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]);
});

test("End reaches the final virtualized row and arrows can cross the mounted window", async ({ page }) => {
  await openView(page, 220, "?many=80", false);
  const cover = page.locator("[data-stack-toggle]").first(); await cover.focus();
  await page.keyboard.press("End"); await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/refs"]')).toBeFocused();
  await expect(page.locator('[data-entry-path="/pictures/refs"]')).toBeInViewport();
  expect((await state(page)).selected).toEqual(["/pictures/refs"]);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop)).toBeGreaterThan(1200);
  await page.keyboard.press("ArrowUp"); await settle(page);
  // One column: the listing order is notes.txt, plain.png, refs.
  await expect(page.locator('[data-entry-path="/pictures/plain.png"]')).toBeFocused();
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  expect(await uncaught(page)).toEqual([]);
});

test("keyboard focus remains on the cover across opening and chevron closing", async ({ page }) => {
  await openView(page, 420, "?grouping=two-chains", false);
  const keyA = await key(page, "photo-a"), section = stack(page, "photo-a");
  await section.locator("[data-stack-toggle]").focus();
  await page.keyboard.press("Space"); await settle(page);
  await expect(section.locator(`[data-node-key="${keyA}"]`)).toBeFocused();
  await section.getByRole("button", { name: "Close stack" }).focus();
  await page.keyboard.press("Enter"); await settle(page);
  await expect(section.locator("[data-stack-toggle]")).toBeFocused();
  await page.keyboard.press("ArrowRight"); await settle(page);
  expect((await state(page)).selected).toEqual(["/pictures/photo-b.png"]);
});

test("ordinary host tile editing keeps navigation keys in the editor", async ({ page }) => {
  await openView(page, 420, "?fileTile=1", false);
  const entry = page.locator('[data-entry-path="/pictures/notes.txt"]');
  await entry.click();
  // The real host forwards bubbled keys from its inline rename textarea.
  // Supply an editable descendant without duplicating host rename logic.
  await entry.evaluate((element) => {
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Rename filename"); input.value = "notes.txt";
    element.append(input); input.focus();
  });
  const editor = page.getByRole("textbox", { name: "Rename filename" });
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter"]) {
    await page.keyboard.press(key);
    await expect(editor).toBeFocused();
    expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    expect((await state(page)).opened).toEqual([]);
  }
});

test("double-clicking a closed stack opens the cover file", async ({ page }) => {
  await openView(page, 420, "?grouping=two-chains", false);
  await stack(page, "photo-a").locator("[data-stack-toggle]").dblclick(); await settle(page);
  expect((await state(page)).opened).toEqual(["/pictures/photo-a.png"]);
  expect((await state(page)).selected).toEqual(["/pictures/photo-a.png"]);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
});

test("reduced motion opens and closes bands without animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openView(page, 420, "?grouping=two-chains", false);
  await stack(page, "photo-a").locator("[data-stack-toggle]").click(); await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await stack(page, "photo-a").getByRole("button", { name: "Close stack" }).click(); await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("an in-place edit's stack hangs from its root revision, inside the view and joined to the edit by a route", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  const root = page.locator('[data-tile-key="a:1"]'), edit = page.locator('[data-tile-key="o:5:0"]');
  await expect(root).toBeVisible(); await expect(edit).toBeVisible();
  const [r, e] = [(await root.boundingBox())!, (await edit.boundingBox())!];
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(e.y).toBeGreaterThan(r.y + r.height);
  await expect(page.locator('path[data-from="node:a:1"][data-to="node:o:5:0"]')).toHaveCount(1);
  // The root is the earlier revision: it previews as such rather than selecting the file the edit now holds.
  await root.click(); await settle(page);
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
});

test("an unsaved cover that is not the component's namesake selects itself as the AI input", async ({ page }) => {
  // The unsaved draft is the cover; the component is named after the later source it merged with.
  await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
  await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
  await expect(page.locator('[data-tile-key="o:10:0"]')).toBeVisible();
  expect((await state(page)).inputs).toEqual(["/managed/draft.png"]);
  expect((await state(page)).selected).not.toContain("/pictures/source.png");
  expect(await uncaught(page)).toEqual([]);
});

const tabStops = (page: Page) => page.locator('[role="grid"] [tabindex="0"]');
const focusIsInGrid = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="grid"]'));

test("deselecting the focused band tile leaves one tab stop and keeps the keyboard working", async ({ page }) => {
  await openView(page, 900, "", false);
  await stack(page, "village").locator("[data-stack-toggle]").click(); await settle(page);
  for (const name of ["warm", "rain", "quiet"]) { await page.locator(`[data-node-key="${await key(page, name)}"]`).click(); await settle(page); }
  await page.locator(`[data-node-key="${await key(page, "quiet")}"]`).click({ modifiers: ["Control"] }); await settle(page);
  await expect(tabStops(page)).toHaveCount(1);
  expect(await focusIsInGrid(page)).toBe(true);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null);
  const before = await focused();
  expect(before).not.toBeNull();
  await page.keyboard.press("ArrowDown"); await settle(page);
  const after = await focused();
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);
  expect(await uncaught(page)).toEqual([]);
});

test("merging the focused child's stack into another keeps one tab stop and focus in the grid", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await page.locator(`[data-node-key="${await key(page, "photo-b-edit")}"]`).click(); await settle(page);
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined"));
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await settle(page);
  await expect(tabStops(page)).toHaveCount(1);
  expect(await focusIsInGrid(page)).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});
