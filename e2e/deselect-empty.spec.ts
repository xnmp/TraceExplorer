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
        if (target && element.contains(target) && !target.closest('button, [data-tile-key], [data-entry-path]')) return { x, y };
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
  await expect(page.getByTestId("trace-view").locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).selected).toEqual([]);
  await expect.poll(async () => (await state(page)).inputs).toEqual([]);
}

for (const host of [{ name: "fallback tiles", query: "" }, { name: "host tiles", query: "?fileTiles=1" }]) {
  test(`empty graph space and Other files gaps clear host selection and ordered inputs (${host.name})`, async ({ page }) => {
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
    const list = page.getByRole("list", { name: "Other files and folders" });
    const ordinaryImage = list.locator('[data-entry-path="/pictures/plain.png"]');
    await ordinaryImage.click({ modifiers: ["Control"] });
    await expect(ordinaryImage).toHaveAttribute("aria-pressed", "true");
    // Pick the actual horizontal gap between the first two tiles.
    const buttons = list.locator("[data-entry-path]");
    const first = (await buttons.nth(0).boundingBox())!;
    const second = (await buttons.nth(1).boundingBox())!;
    point = { x: (first.x + first.width + second.x) / 2, y: first.y + first.height / 2 };
    await page.mouse.click(point.x, point.y);
    await expectEmpty(page);
    // Repeated clearing also works when the host selection was already empty.
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

test("section controls and secondary clicks preserve selection", async ({ page }) => {
  await openView(page, 1400);
  const before = await selectImages(page);
  const section = page.locator("section[data-component]").filter({ has: await card(page, "warm") });
  const heading = section.locator("button.heading");
  await heading.locator(".name").click();
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  expect((await state(page)).selected).toEqual(before.selected);
  expect((await state(page)).inputs).toEqual(before.inputs);
  await heading.click();
  await settle(page);
  const point = await emptyPoint(section.locator(".graph"));
  await page.mouse.click(point.x, point.y, { button: "right" });
  expect((await state(page)).selected).toEqual(before.selected);
  expect((await state(page)).inputs).toEqual(before.inputs);
});
