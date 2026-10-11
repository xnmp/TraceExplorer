import { expect, test, type Locator, type Page } from "@playwright/test";
import { card, click, openView, settle, state } from "./support";

/** Find real unused space, rather than dispatching a synthetic click through a tile. */
async function emptyPoint(area: Locator): Promise<{ x: number; y: number }> {
  await area.scrollIntoViewIfNeeded();
  return area.evaluate((element) => {
    const box = element.getBoundingClientRect();
    for (let y = Math.max(0, box.top) + 3; y < Math.min(innerHeight, box.bottom) - 3; y += 4) {
      for (let x = Math.max(0, box.left) + 3; x < Math.min(innerWidth, box.right) - 3; x += 4) {
        const target = document.elementFromPoint(x, y);
        if (target && target.closest("[data-testid=trace-view]") && !target.closest('button, [data-tile-key], [data-entry-path]')) return { x, y };
      }
    }
    throw new Error("No visible empty space in the requested area");
  });
}

async function selectImages(page: Page) {
  await click(page, "village");
  await click(page, "warm", { modifiers: ["Shift"] });
  await click(page, "mist", { modifiers: ["Control"] });
  await click(page, "merge", { modifiers: ["Control"] });
  const before = await state(page);
  expect(before.selected.length).toBeGreaterThan(1);
  expect(before.inputs.length).toBeGreaterThan(before.selected.length);
  return before;
}

async function expectEmpty(page: Page) {
  await expect(page.getByTestId("trace-view").locator('[aria-pressed="true"], [aria-selected="true"]')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).selected).toEqual([]);
  await expect.poll(async () => (await state(page)).inputs).toEqual([]);
}

for (const host of [{ name: "fallback tiles", query: "" }, { name: "host tiles", query: "?fileTile=1" }]) {
  test(`empty graph space and folder grid gaps clear host selection and ordered inputs (${host.name})`, async ({ page }) => {
    await openView(page, 1400, host.query);
    await selectImages(page);
    const graph = page.locator("section[data-component]").filter({ has: await card(page, "warm") }).locator(".graph");
    let point = await emptyPoint(graph);
    await page.mouse.click(point.x, point.y);
    await expectEmpty(page);

    // The next tile click still selects through the host.
    await click(page, "warm");
    await expect(await card(page, "warm")).toHaveAttribute("aria-pressed", "true");
    expect((await state(page)).selected).toEqual(["/pictures/warm.png"]);

    await selectImages(page);
    // The host's Tiles view is a grid of gridcells with aria-selected; the fallback is a list of buttons with aria-pressed.
    const list = page.getByRole("grid", { name: "Folder" });
    const ordinaryImage = list.locator('[data-entry-path="/pictures/plain.png"]');
    await ordinaryImage.click({ modifiers: ["Control"] });
    await expect(ordinaryImage).toHaveAttribute("aria-selected", "true");
    // Measure the gap only once the tiles have stopped moving.
    await settle(page);
    // Pick the actual horizontal gap between the first two tiles.
    point = await emptyPoint(list);
    await page.mouse.click(point.x, point.y);
    await expectEmpty(page);
    // Repeated clearing also works when the host selection was already empty.
    // The unsaved image is only drawn while a related node has focus.
    await click(page, "warm");
    await click(page, "merge");
    expect((await state(page)).selected).toEqual([]);
    expect((await state(page)).inputs).toHaveLength(1);
    point = await emptyPoint(list);
    await page.mouse.click(point.x, point.y);
    await expectEmpty(page);
    expect((await state(page)).target).toBeNull();
  });
}

test("canvas drag gestures preserve selection, including dragging away and back", async ({ page }) => {
  await openView(page, 1400);
  const before = await selectImages(page);
  const graph = page.locator("section[data-component]").filter({ has: await card(page, "warm") }).locator(".graph");
  const point = await emptyPoint(graph);
  for (const returns of [false, true]) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y + 20, { steps: 8 });
    if (returns) await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect((await state(page)).selected).toEqual(before.selected);
    expect((await state(page)).inputs).toEqual(before.inputs);
    await expect(await card(page, "warm")).toHaveAttribute("aria-pressed", "true");
  }
});

test("closing preserves selection, reopening selects its cover, and background right-click clears like the host list", async ({ page }) => {
  await openView(page, 1400);
  const before = await selectImages(page);
  // Pin the section by its id: collapsing unmounts its cards, so a locator
  // filtered by a card stops matching once the section collapses.
  const component = await page.locator("section[data-component]").filter({ has: await card(page, "warm") }).getAttribute("data-component");
  const section = page.locator(`section[data-component="${component}"]`);
  const heading = section.locator("[data-stack-toggle]");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  expect((await state(page)).selected).toEqual(before.selected);
  expect((await state(page)).inputs).toEqual(before.inputs);
  await heading.click();
  await settle(page);
  expect((await state(page)).selected).toEqual(["/pictures/village.png"]);
  const point = await emptyPoint(section.locator(".graph"));
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expectEmpty(page);
  expect((await state(page)).menus).toEqual([null]);

  // The host cannot select this unsaved image, so its unchanged empty selection
  // must not leave a Trace-only pick or Preview target behind.
  await click(page, "warm");
  await click(page, "merge");
  expect((await state(page)).selected).toEqual([]);
  expect((await state(page)).inputs).toHaveLength(1);
  const extraPoint = await emptyPoint(section.locator(".graph"));
  await page.mouse.click(extraPoint.x, extraPoint.y, { button: "right" });
  await expectEmpty(page);
  expect((await state(page)).target).toBeNull();
  expect((await state(page)).menus).toEqual([null, null]);
});

test("native scrollbar press keeps selection and Preview inputs", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 400 });
  await openView(page, 900);
  await click(page, "warm");
  const before = await state(page);
  const pane = page.getByTestId("trace-view");
  const scrollTop = await pane.evaluate((element) => element.scrollTop);
  const point = await pane.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const gutter = (element as HTMLElement).offsetWidth - element.clientWidth;
    if (element.scrollHeight <= element.clientHeight || gutter <= 0) throw new Error("Expected a scrolling pane with a native scrollbar gutter");
    // Press the thumb rather than paging the track: no movement or scroll event
    // should be needed to preserve the selection.
    const trackHeight = element.clientHeight;
    const thumbHeight = Math.max(20, trackHeight * element.clientHeight / element.scrollHeight);
    const thumbTop = element.scrollTop / (element.scrollHeight - element.clientHeight) * (trackHeight - thumbHeight);
    return { x: box.left + element.clientWidth + gutter / 2, y: box.top + thumbTop + thumbHeight / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page);
  expect(await pane.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  expect((await state(page)).selected).toEqual(before.selected);
  expect((await state(page)).inputs).toEqual(before.inputs);
  await expect(await card(page, "warm")).toHaveAttribute("aria-pressed", "true");
});

test("wheel during an empty-background press keeps selection and Preview inputs", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 500 });
  await openView(page, 1400);
  await click(page, "warm");
  const before = await state(page);
  const graph = page.locator("section[data-component]").filter({ has: await card(page, "warm") }).locator(".graph");
  const point = await emptyPoint(graph);
  const pane = page.getByTestId("trace-view");
  const scrollTop = await pane.evaluate((element) => element.scrollTop);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.wheel(0, 40);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).not.toBe(scrollTop);
  expect(await graph.evaluate((element, point) => {
    const target = document.elementFromPoint(point.x, point.y);
    return !!target && target.closest("[data-testid=trace-view]") && !target.closest('button, [data-tile-key], [data-entry-path]');
  }, point)).toBe(true);
  await page.mouse.up();
  await settle(page);
  expect((await state(page)).selected).toEqual(before.selected);
  expect((await state(page)).inputs).toEqual(before.inputs);
  await expect(await card(page, "warm")).toHaveAttribute("aria-pressed", "true");
});

for (const zoom of ["125%", "80%"]) {
  test(`with the host's document zoom at ${zoom}, edge background clears and a scrollbar press does not`, async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 400 });
    await openView(page, 900);
    await page.evaluate((value) => { document.documentElement.style.zoom = value; }, zoom);
    await settle(page);
    await click(page, "warm");
    const before = await state(page);
    const pane = page.getByTestId("trace-view");
    const edges = await pane.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const zoom = box.width / (element as HTMLElement).offsetWidth;
      const right = box.left + (element.clientLeft + element.clientWidth) * zoom;
      const gutter = ((element as HTMLElement).offsetWidth - element.clientWidth - element.clientLeft) * zoom;
      if (element.scrollHeight <= element.clientHeight || gutter <= 0) throw new Error("Expected a scrolling pane with a native scrollbar gutter");
      // Empty content pixel just inside the right edge, found rather than assumed.
      let empty: { x: number; y: number } | null = null;
      for (let y = box.top + 4; y < Math.min(innerHeight, box.bottom) - 4 && !empty; y += 4) {
        const x = right - 3;
        const target = document.elementFromPoint(x, y);
        if (target && target.closest("[data-testid=trace-view]") && !target.closest('button, [data-tile-key], [data-entry-path], [tabindex]')) empty = { x, y };
      }
      if (!empty) throw new Error("No empty space beside the scrollbar");
      return { empty, scrollbar: { x: right + gutter / 2, y: box.top + 40 }, zoom };
    });
    expect(edges.zoom).toBeCloseTo(parseFloat(zoom) / 100, 2);
    await page.mouse.click(edges.scrollbar.x, edges.scrollbar.y);
    await settle(page);
    expect((await state(page)).selected).toEqual(before.selected);
    expect((await state(page)).inputs).toEqual(before.inputs);
    await page.mouse.click(edges.empty.x, edges.empty.y);
    await expectEmpty(page);
  });
}
