import { test, expect, type Page } from "@playwright/test";
import { openView, key, state, settle, uncaught } from "./support";
import { awaitAnimationsCreated, holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";

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
    // Every animation of the opening exists before any is seeked (grid motion and geometry arrive in later turns).
    await awaitAnimationsCreated(page);
    const result = await page.evaluate(async (key) => {
      const w = window as any, frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 40;
      await frame();
      const tile = document.querySelector<HTMLElement>(`[data-tile-key="${key}"]`)!;
      const before = { y: tile.getBoundingClientRect().y, opacity: Number(getComputedStyle(tile).opacity) };
      tile.closest("section")!.querySelector<HTMLElement>('[aria-label="Close stack"]')!.click();
      // The closing copy and its animations are created in turns after the click; wait until none are new.
      for (let count = -1, stable = 0; stable < 4;) { await frame(); const now = w.__heldAnimations.length + w.trace.layoutsPending(); stable = now === count ? stable + 1 : 0; count = now; }
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

test("clicking a closed in-place-edit stack selects its cover revision, as clicking the open cover does", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
});

test("a band wider than the pane scrolls the view sideways, keeping routes attached to their cover", async ({ page }) => {
  await openView(page, 220, "?wideRoots=24", false);
  await stack(page, "wr-0").locator("[data-stack-toggle]").click(); await settle(page);
  const cover = await key(page, "wr-0");
  const view = page.getByTestId("trace-view");
  expect(await view.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // Where the cover hangs its outgoing route, against the route's first point as drawn.
  const attachment = () => page.evaluate((cover) => {
    const tile = document.querySelector(`[data-tile-key="${cover}"]`)!.getBoundingClientRect();
    const routes = [...document.querySelectorAll<SVGPathElement>(`path[data-route][data-from="node:${cover}"]`)];
    return { center: tile.left + tile.width / 2, starts: routes.map((route) => {
      const start = route.getPointAtLength(0), at = route.getScreenCTM()!;
      return start.x * at.a + start.y * at.c + at.e;
    }) };
  }, cover);
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await attachment();
  expect(before.starts.length).toBeGreaterThan(0);
  for (const wheel of [100, 5000, -5000]) {
    const left = await view.evaluate((element) => element.scrollLeft);
    await page.mouse.wheel(wheel, 0);
    await expect.poll(() => view.evaluate((element) => element.scrollLeft)).not.toBe(left);
    await settle(page);
    const now = await attachment();
    for (const start of now.starts) expect(Math.abs(start - now.center), `route start vs cover centre after wheel ${wheel}`).toBeLessThan(3);
  }
  // Every tile is reachable: at the far end of the scroll the rightmost tile lies inside the view.
  await page.mouse.wheel(5000, 0);
  await expect.poll(() => view.evaluate((element) => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThan(20);
  const rightmost = await view.evaluate((element) => Math.max(...[...element.querySelectorAll("[data-tile-key]")].map((tile) => tile.getBoundingClientRect().right)) <= element.getBoundingClientRect().right + 1);
  expect(rightmost).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});

test("the focused tile stays mounted when windowing scrolls it out of range", async ({ page }) => {
  await openView(page, 420, "?fanChildren=140", false);
  await stack(page, "fan").locator("[data-stack-toggle]").click(); await settle(page);
  const target = page.locator(`[data-node-key="${await key(page, "fan-1")}"]`);
  const box = (await target.boundingBox())!;
  // Press, drag outside the tile and release: the tile takes focus but nothing is selected.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height + 400); await page.mouse.up();
  await page.getByTestId("trace-view").evaluate((view) => { view.scrollTop = view.scrollHeight; });
  await settle(page);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null)).not.toBeNull();
  await expect(tabStops(page)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("arrowing into a closed in-place-edit stack selects its cover revision, as clicking it does", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  const ordinary = page.locator("[data-grid-cell]:not([data-stack-key]) [data-entry-path]").first();
  await ordinary.focus();
  const heading = page.locator("[data-stack-toggle]");
  const stackX = (await heading.boundingBox())!.x, ordinaryX = (await ordinary.boundingBox())!.x;
  await page.keyboard.press(stackX < ordinaryX ? "ArrowLeft" : "ArrowRight"); await settle(page);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node-key"))).toBe("a:1");
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
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

test("saving an unsaved cover through its Save button moves no cell, even while the index lags the listing", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
  await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
  const cells = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => {
    const rect = cell.getBoundingClientRect();
    return [cell.dataset.gridCell!, [Math.round(rect.x), Math.round(rect.y)]];
  })));
  const before = await cells();
  const backend = (fn: string) => page.evaluate((fn) => (window as any).trace.backend[fn](), fn);
  // The host lists the saved file while Trace's index read is still outstanding.
  await backend("holdFolderReads");
  const cover = page.locator('[data-tile-key="o:10:0"]');
  await cover.hover();
  await cover.getByRole("button", { name: "Save image permanently" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.listing().some((entry: { path: string }) => entry.path === "/pictures/draft.png"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("save_generated_image").length)).toBeGreaterThan(0);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  expect(await cells()).toEqual(before);
  await backend("releaseFolderReads"); await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  expect(await cells()).toEqual(before);
  expect(await uncaught(page)).toEqual([]);
});

test("a refresh that merges the stack during activation still selects the clicked cover", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-and-placeholder", false);
  const backend = (fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as any).trace.backend[fn as string](...(args as unknown[])), [fn, args] as const);
  await backend("holdFolderReads");
  // An unsaved cover is not a listed file, so pressing it loads its component before selecting.
  await stack(page, "out").locator("[data-stack-toggle]").click();
  await backend("joinGeneration", ["o:10:0", "out"], "joined");
  await backend("releaseFolderReads");
  await settle(page);
  await expect.poll(async () => (await state(page)).target).toMatchObject({ id: "trace:o:11:0" });
  expect(await uncaught(page)).toEqual([]);
});

for (const outcome of ["delayed", "failed"] as const) {
  test(`a stack whose data is ${outcome} can be closed again`, async ({ page }) => {
    await openView(page, 420, "?grouping=two-chains", false);
    const backend = (fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as any).trace.backend[fn as string](...(args as unknown[])), [fn, args] as const);
    await backend(outcome === "delayed" ? "holdFolderReads" : "failNodeReads", 1);
    const heading = stack(page, "photo-a").locator("[data-stack-toggle]");
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "true");
    await heading.click();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    if (outcome === "delayed") await backend("releaseFolderReads");
    await settle(page);
    // Still closed once the data arrives, and openable again.
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    await heading.click(); await settle(page);
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
  });
}

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
