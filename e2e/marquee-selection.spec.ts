import { expect, test, type Locator, type Page } from "@playwright/test";
import { card, click, key, openView, settle, state, uncaught } from "./support";

const marquee = (page: Page) => page.locator(".marquee-rect");
const notifications = (page: Page) => page.evaluate(() => (window as any).trace.state().selectionNotifications as number);

async function closedGrid(page: Page, query = "") {
  await page.setViewportSize({ width: 1800, height: 1400 });
  await openView(page, 1400, query, false);
  for (const button of await page.getByRole("button", { name: "Collapse stack", exact: true }).all()) await button.click();
  await settle(page);
}

async function dragBounds(tiles: Locator) {
  return tiles.evaluateAll((elements) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    const start = { x: Math.min(...boxes.map((box) => box.left)) - 3, y: Math.min(...boxes.map((box) => box.top)) - 3 };
    const end = { x: Math.max(...boxes.map((box) => box.right)) + 3, y: Math.max(...boxes.map((box) => box.bottom)) + 3 };
    const target = document.elementFromPoint(start.x, start.y);
    if (!target?.closest('[data-testid="trace-view"]') || target.closest('button, [data-entry-path]')) throw new Error("Drag must start on real background");
    return { start, end };
  });
}

async function startDrag(page: Page, bounds: Awaited<ReturnType<typeof dragBounds>>) {
  await page.mouse.move(bounds.start.x, bounds.start.y);
  await page.mouse.down();
  await page.mouse.move(bounds.end.x, bounds.end.y, { steps: 10 });
  await expect(marquee(page)).toBeVisible();
}

async function finishDrag(page: Page) {
  await page.mouse.up();
  await expect(marquee(page)).toHaveCount(0);
  await settle(page);
}

for (const query of ["", "?fileTile=1&tileSize=medium"]) {
  test(`plain marquee selects exactly three stack covers, with live host state and styling (${query || "fallback"})`, async ({ page }) => {
    await closedGrid(page, query);
    const keys = await Promise.all(["village", "forest", "fan"].map((name) => key(page, name)));
    const covers = page.locator(keys.map((key) => `[data-node-key="${key}"]`).join(","));
    await expect(covers).toHaveCount(3);
    await page.evaluate(() => (window as any).trace.selectPath("/pictures/plain.png"));
    await startDrag(page, await dragBounds(covers));
    const expected = ["/pictures/village.png", "/pictures/forest.png", "/pictures/fan.png"].sort();
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(expected);
    await expect.poll(async () => (await state(page)).inputs.sort()).toEqual(expected);
    await expect(page.getByTestId("trace-view").locator(".selected")).toHaveCount(3);
    for (const cover of await covers.all()) await expect(cover).toHaveAttribute("aria-selected", "true");
    const before = await notifications(page);
    const end = (await dragBounds(covers)).end;
    await page.mouse.move(end.x + 1, end.y + 1);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await notifications(page)).toBe(before);
    await finishDrag(page);
    expect((await state(page)).selected.sort()).toEqual(expected);
  });

  test(`marquee selects ordinary files and folders (${query || "fallback"})`, async ({ page }) => {
    await closedGrid(page, query);
    const tiles = page.locator('[data-entry-path="/pictures/notes.txt"], [data-entry-path="/pictures/plain.png"], [data-entry-path="/pictures/refs"]');
    await expect(tiles).toHaveCount(3);
    await startDrag(page, await dragBounds(tiles));
    const expected = ["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"];
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(expected);
    for (const tile of await tiles.all()) { await expect(tile).toHaveClass(/selected/); await expect(tile).toHaveAttribute("aria-selected", "true"); }
    await finishDrag(page);
    expect((await state(page)).selected.sort()).toEqual(expected);
  });
}

for (const modifier of ["Control", "Meta"] as const) {
  test(`${modifier}-drag adds cumulatively without toggling existing selection`, async ({ page }) => {
    await closedGrid(page);
    await page.evaluate(() => (window as any).trace.setSelection(["/pictures/plain.png", "/pictures/village.png"]));
    const village = await card(page, "village");
    await page.keyboard.down(modifier);
    await startDrag(page, await dragBounds(village));
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/plain.png", "/pictures/village.png"]);
    const forestBounds = await dragBounds(await card(page, "forest"));
    await page.mouse.move(forestBounds.end.x, forestBounds.end.y, { steps: 5 });
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/forest.png", "/pictures/plain.png", "/pictures/village.png"]);
    const villageBounds = await dragBounds(village);
    await page.mouse.move(villageBounds.start.x + 1, villageBounds.start.y + 1, { steps: 5 });
    // Items visited by an additive drag stay selected when the rectangle shrinks, as in the host.
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/forest.png", "/pictures/plain.png", "/pictures/village.png"]);
    await finishDrag(page);
    await page.keyboard.up(modifier);
  });
}

test("drag starting on a tile leaves marquee unattached and tile clicks work", async ({ page }) => {
  await closedGrid(page);
  const ordinary = page.locator('[data-entry-path="/pictures/plain.png"]');
  await ordinary.click();
  const before = await state(page);
  const box = (await ordinary.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 20, box.y - 20, { steps: 10 });
  await expect(marquee(page)).toHaveCount(0);
  await page.mouse.up();
  expect((await state(page)).selected).toEqual(before.selected);
  await ordinary.click();
  await expect(ordinary).toHaveClass(/selected/);
});

test("graph background marquee selects its two child tiles, including after scrolling and zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await openView(page, 1400);
  await click(page, "forest");
  const keys = await Promise.all(["forest-mist", "autumn"].map((name) => key(page, name)));
  const tiles = page.locator(keys.map((key) => `[data-node-key="${key}"]`).join(","));
  await page.evaluate(() => { document.documentElement.style.zoom = "80%"; });
  await tiles.last().scrollIntoViewIfNeeded();
  await settle(page);
  const bounds = await dragBounds(tiles);
  // Reverse direction exercises clamping and normalization over a scrolled graph.
  await page.mouse.move(bounds.end.x, bounds.end.y);
  await page.mouse.down();
  await page.mouse.move(bounds.start.x, bounds.start.y, { steps: 10 });
  await expect(marquee(page)).toBeVisible();
  const expected = ["/pictures/forest-mist.png", "/pictures/autumn.png"].sort();
  await expect.poll(async () => (await state(page)).selected.sort()).toEqual(expected);
  for (const tile of await tiles.all()) await expect(tile).toHaveClass(/selected/);
  await finishDrag(page);
  expect((await state(page)).selected.sort()).toEqual(expected);
});

test("Escape clears selection during marquee like the host command, without restoring the old selection", async ({ page }) => {
  await closedGrid(page);
  await page.evaluate(() => (window as any).trace.selectPath("/pictures/plain.png"));
  await startDrag(page, await dragBounds(await card(page, "village")));
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/village.png"]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).selected).toEqual([]);
  await finishDrag(page);
  expect((await state(page)).selected).toEqual([]);
  expect((await state(page)).inputs).toEqual([]);
});

for (const loaded of [false, true]) {
  test(`marquee selects a closed cover while an edit is running (${loaded ? "loaded" : "cold"})`, async ({ page }) => {
    await closedGrid(page);
    if (loaded) {
      await click(page, "village");
      await page.getByRole("button", { name: "Collapse stack", exact: true }).click();
    }
    await page.evaluate(() => (window as any).trace.backend.startGeneration("village", "pending-marquee"));
    const section = page.locator('section[data-component][aria-label="village"]');
    await expect(section.getByRole("status", { name: "Generating", exact: true })).toBeVisible();
    await settle(page);
    await startDrag(page, await dragBounds(await card(page, "village")));
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/village.png"]);
    await finishDrag(page);
    expect((await state(page)).inputs).toEqual(["/pictures/village.png"]);
  });

  test(`marquee over an earlier cover never selects the newer file at its path (${loaded ? "loaded" : "cold"})`, async ({ page }) => {
    await closedGrid(page, "?grouping=in-place-edit");
    if (loaded) {
      await page.locator("[data-stack-toggle]").click();
      await settle(page);
      await page.getByRole("button", { name: "Collapse stack", exact: true }).click();
      await settle(page);
    }
    const cover = page.locator('[data-node-key="a:1"]');
    await startDrag(page, await dragBounds(cover));
    await expect.poll(async () => (await state(page)).selected).toEqual([]);
    await expect.poll(async () => (await state(page)).inputs).toEqual([]);
    await finishDrag(page);
    expect((await state(page)).selected).toEqual([]);
    await expect(cover).toHaveAttribute("aria-selected", "false");
  });
}

test("releasing a marquee outside the pane commits the clamped selection and removes the rectangle", async ({ page }) => {
  await closedGrid(page);
  const pane = (await page.getByTestId("trace-view").boundingBox())!;
  await page.mouse.move(pane.x + 2, pane.y + 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width + 150, pane.y + 130, { steps: 10 });
  await expect(marquee(page)).toBeVisible();
  await finishDrag(page);
  expect((await state(page)).selected.sort()).toEqual(["/pictures/fan.png", "/pictures/forest.png", "/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs", "/pictures/village.png"]);
});

test("marquee includes graph references in ordered AI inputs alongside the listed file", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  await openView(page, 1400);
  await click(page, "warm");
  const warm = await key(page, "warm"), mist = await key(page, "mist"), lantern = await key(page, "lantern");
  const tiles = page.locator(`[data-node-key="${warm}"], [data-tile-key="${warm}"] [data-reference-key="${mist}"], [data-tile-key="${warm}"] [data-reference-key="${lantern}"]`);
  await expect(tiles).toHaveCount(3);
  await startDrag(page, await dragBounds(tiles));
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/warm.png"]);
  await expect.poll(async () => (await state(page)).inputs.sort()).toEqual(["/elsewhere/lantern.png", "/pictures/refs/mist.png", "/pictures/warm.png"]);
  for (const tile of await tiles.all()) await expect(tile).toHaveClass(/selected/);
  await finishDrag(page);
  expect((await state(page)).inputs.sort()).toEqual(["/elsewhere/lantern.png", "/pictures/refs/mist.png", "/pictures/warm.png"]);
});

for (const loaded of [false, true]) {
  test(`marquee selects an unsaved cover as an AI input (${loaded ? "loaded" : "cold"})`, async ({ page }) => {
    await closedGrid(page, "?draftStack=1");
    if (loaded) {
      await click(page, "draft");
      await page.getByRole("button", { name: "Collapse stack", exact: true }).click();
      await settle(page);
    }
    const cover = await card(page, "draft");
    await startDrag(page, await dragBounds(cover));
    await expect.poll(async () => (await state(page)).inputs).toEqual(["/managed/draft.png"]);
    expect((await state(page)).selected).toEqual([]);
    await expect(cover).toHaveAttribute("aria-selected", "true");
    await finishDrag(page);
    expect((await state(page)).inputs).toEqual(["/managed/draft.png"]);
  });
}

test("stationary marquee follows a grid relayout before release", async ({ page }) => {
  await closedGrid(page);
  const cover = await card(page, "fan");
  const bounds = await dragBounds(cover);
  await startDrag(page, bounds);
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/fan.png"]);
  await page.evaluate(() => (window as any).trace.setWidth(300));
  await settle(page);
  const box = (await cover.boundingBox())!;
  expect(box.x + box.width < bounds.start.x || box.x > bounds.end.x || box.y > bounds.end.y || box.y + box.height < bounds.start.y).toBe(true);
  // No pointer movement: the selection must already reflect the displayed geometry.
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/forest.png"]);
  await finishDrag(page);
  expect((await state(page)).selected).toEqual(["/pictures/forest.png"]);
});

test("release re-measures geometry before another animation frame", async ({ page }) => {
  await closedGrid(page);
  const cover = await card(page, "fan");
  await startDrag(page, await dragBounds(cover));
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/fan.png"]);
  await cover.evaluate((element) => {
    // An unobserved geometry change and release in one turn, with no pending move.
    (element as HTMLElement).style.transform = "translateY(300px)";
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, button: 0, isPrimary: true }));
  });
  await finishDrag(page);
  expect((await state(page)).selected).toEqual([]);
});

test("a resolved cold cover keeps marquee ownership through stationary relayout", async ({ page }) => {
  await closedGrid(page, "?draftStack=1");
  const cover = await card(page, "draft");
  const bounds = await dragBounds(cover);
  await startDrag(page, bounds);
  await expect.poll(async () => (await state(page)).inputs).toEqual(["/managed/draft.png"]);
  await page.evaluate(() => (window as any).trace.setWidth(300));
  await settle(page);
  const box = (await cover.boundingBox())!;
  expect(box.y > bounds.end.y).toBe(true);
  await expect.poll(async () => (await state(page)).inputs.includes("/managed/draft.png")).toBe(false);
  await finishDrag(page);
  expect((await state(page)).inputs).not.toContain("/managed/draft.png");
});

test("stationary relayout and automatic scroll yield to a newer host selection", async ({ page }) => {
  await closedGrid(page);
  await startDrag(page, await dragBounds(await card(page, "fan")));
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/fan.png"]);
  await page.evaluate(() => {
    (window as any).trace.selectPath("/pictures/plain.png");
    (window as any).trace.setWidth(300);
  });
  await settle(page);
  await page.getByTestId("trace-view").evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await finishDrag(page);
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  expect((await state(page)).inputs).toEqual(["/pictures/plain.png"]);
});

test("a pointer move queued before a newer host command cannot overwrite it on release", async ({ page }) => {
  await closedGrid(page);
  await startDrag(page, await dragBounds(await card(page, "fan")));
  await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/fan.png"]);
  const { end } = await dragBounds(await card(page, "village"));
  await page.evaluate((end) => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: end.x, clientY: end.y, buttons: 1, isPrimary: true }));
    (window as any).trace.selectPath("/pictures/plain.png");
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, button: 0, isPrimary: true }));
  }, end);
  await finishDrag(page);
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  expect((await state(page)).inputs).toEqual(["/pictures/plain.png"]);
});

for (const merge of [false, true]) {
  test(`pending cold-cover marquee survives ${merge ? "a component merge" : "an index refresh"}`, async ({ page }) => {
    await closedGrid(page, "?draftStack=1");
    await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
    await startDrag(page, await dragBounds(await card(page, "draft")));
    await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_component_nodes").length)).toBeGreaterThan(0);
    // Exercise both active geometry and committed intent after the rectangle is gone.
    if (merge) await finishDrag(page);
    await page.evaluate((merge) => {
      const backend = (window as any).trace.backend;
      backend.setFolderLatency(100);
      if (merge) backend.joinGeneration(["village", "draft"], "marquee-merge");
      else backend.startGeneration("forest", "marquee-refresh");
    }, merge);
    await settle(page);
    await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
    await expect.poll(async () => (await state(page)).inputs).toEqual(["/managed/draft.png"]);
    expect((await state(page)).selected).toEqual([]);
    if (!merge) {
      await expect(await card(page, "draft")).toHaveAttribute("aria-selected", "true");
      await finishDrag(page);
      expect((await state(page)).inputs).toEqual(["/managed/draft.png"]);
    }
  });
}

for (const supersede of ["external-choice", "blur", "new-frame", "unmount"] as const) {
  test(`a pending cold-cover read cannot overwrite selection after ${supersede}`, async ({ page }) => {
    await closedGrid(page, "?draftStack=1");
    await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
    const bounds = await dragBounds(await card(page, "draft"));
    await startDrag(page, bounds);
    if (supersede === "blur") {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(marquee(page)).toHaveCount(0);
      await page.mouse.up();
    } else if (supersede === "new-frame") {
      await page.mouse.move(bounds.start.x + 1, bounds.start.y + 1, { steps: 5 });
      await finishDrag(page);
    } else {
      await finishDrag(page);
      if (supersede === "unmount") await page.evaluate(() => (window as any).trace.leaveView());
      await page.evaluate(() => (window as any).trace.selectPath("/pictures/plain.png"));
    }
    await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
    await settle(page);
    const expected = supersede === "external-choice" || supersede === "unmount" ? ["/pictures/plain.png"] : [];
    expect((await state(page)).selected).toEqual(expected);
    expect((await state(page)).inputs).toEqual(supersede === "unmount" ? [] : expected);
  });
}

for (const modifier of ["Control", "Meta"] as const) {
  test(`${modifier} marquee starts a new additive baseline after Escape clears the host selection`, async ({ page }) => {
    await closedGrid(page);
    const village = await key(page, "village"), forest = await key(page, "forest");
    const covers = page.locator(`[data-node-key="${village}"], [data-node-key="${forest}"]`);
    await page.keyboard.down(modifier);
    await startDrag(page, await dragBounds(covers));
    await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/forest.png", "/pictures/village.png"]);
    // The host captures the modifier at press; Escape itself is an unmodified shortcut.
    await page.keyboard.up(modifier);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await state(page)).selected).toEqual([]);
    const bounds = await dragBounds(await card(page, "village"));
    await page.mouse.move(bounds.end.x, bounds.end.y, { steps: 5 });
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/village.png"]);
    await expect.poll(async () => (await state(page)).inputs).toEqual(["/pictures/village.png"]);
    await finishDrag(page);
    expect((await state(page)).selected).toEqual(["/pictures/village.png"]);
  });
}


for (const fileTile of [false, true]) {
  for (const keepAnchor of [false, true]) {
    test(`Shift-click after Ctrl-marquee uses ${keepAnchor ? "original" : "legacy"} host anchor (${fileTile ? "host tile" : "fallback tile"})`, async ({ page }) => {
      await closedGrid(page, `?selectionAnchor=${keepAnchor ? "1" : "0"}${fileTile ? "&fileTile=1" : ""}`);
      const notes = page.locator('[data-entry-path="/pictures/notes.txt"]');
      const plain = page.locator('[data-entry-path="/pictures/plain.png"]');
      const refs = page.locator('[data-entry-path="/pictures/refs"]');
      await notes.click();
      await page.keyboard.down("Control");
      await startDrag(page, await dragBounds(plain));
      await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/notes.txt", "/pictures/plain.png"]);
      await finishDrag(page);
      await page.keyboard.up("Control");
      expect((await state(page)).cursor).toBe(keepAnchor ? "/pictures/notes.txt" : "/pictures/plain.png");
      await refs.click({ modifiers: ["Shift"] });
      const expected = keepAnchor ? ["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"] : ["/pictures/plain.png", "/pictures/refs"];
      await expect.poll(async () => (await state(page)).selected.sort()).toEqual(expected);
      await expect(plain).toHaveAttribute("aria-selected", "true");
      await expect(refs).toHaveAttribute("aria-selected", "true");
      await expect(notes).toHaveAttribute("aria-selected", String(keepAnchor));
      expect(await uncaught(page)).toEqual([]);
    });
  }
}

test("plain marquee leaves an unselected cursor and its Shift-range anchor untouched", async ({ page }) => {
  await closedGrid(page);
  const notes = page.locator('[data-entry-path="/pictures/notes.txt"]');
  const plain = page.locator('[data-entry-path="/pictures/plain.png"]');
  await notes.click();
  await startDrag(page, await dragBounds(plain));
  await finishDrag(page);
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  expect((await state(page)).cursor).toBe("/pictures/notes.txt");
  await page.locator('[data-entry-path="/pictures/refs"]').click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await state(page)).selected.sort()).toEqual(["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]);
});
