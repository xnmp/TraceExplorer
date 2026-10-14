/**
 * Windowing from the published scene (docs/scene-transactions.md §7). Only records near the
 * viewport are mounted; the motion of a commit is limited to its participants (records near the
 * viewport, chosen or already moving), which stay mounted until they settle. A record mounted
 * later, by scrolling while motion runs, shows its target pose (in its section, which may itself
 * be moving) and creates no effect: it never publishes geometry, starts motion or restarts the
 * clock. Keyboard navigation reaches logical tiles that are not mounted.
 */
import { test, expect, type Page } from "@playwright/test";
import { awaitMotionRunning, awaitMotionStarted, holdMotion, motionState, releaseMotion, seekMotion } from "./animation-control";
import { clearSceneEvents, samplePaintedFrames, sampleFrames, sceneEvents } from "./helpers/scene-events";
import { key, openView, settle, uncaught } from "./support";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
const view = (page: Page) => page.getByTestId("trace-view");

const seek = seekMotion;

/**
 * Every mounted grid cell and band tile: whether it moves on values the motion driver writes to it, and how far it is
 * displayed from its laid-out place (cells against the grid, band tiles against their band's
 * canvas, so a tile riding with its moving section shows no offset). Self-contained: it runs in the page.
 */
function mounted() {
  const zoom = (element: Element) => { const style = getComputedStyle(element), box = element.getBoundingClientRect(); return box.width && parseFloat(style.width) ? box.width / parseFloat(style.width) : 1; };
  const grid = document.querySelector<HTMLElement>('[role="grid"]');
  if (!grid) return { cells: [], tiles: [] };
  const origin = grid.getBoundingClientRect(), scale = zoom(grid);
  const own = (element: Element) => (window as any).trace.motion.owns(element) as boolean;
  const cells = [...grid.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => {
    const section = cell.closest<HTMLElement>("section.component");
    const box = cell.getBoundingClientRect();
    const left = parseFloat(cell.style.left), top = section ? parseFloat(section.style.top) : parseFloat(cell.style.top);
    const moving = own(cell) || (!!section && own(section));
    return { id: cell.dataset.gridCell!, moving, dx: (box.left - origin.left) / scale - left, dy: (box.top - origin.top) / scale - top };
  });
  const tiles = [...grid.querySelectorAll<HTMLElement>(".graph [data-tile-key]")].map((tile) => {
    const canvas = tile.closest<HTMLElement>(".graph")!, frame = canvas.getBoundingClientRect(), box = tile.getBoundingClientRect();
    return { key: tile.dataset.tileKey!, moving: own(tile), dx: (box.left - frame.left) / scale - parseFloat(tile.style.left), dy: (box.top - frame.top) / scale - parseFloat(tile.style.top) };
  });
  return { cells, tiles };
}
type Mounted = ReturnType<typeof mounted>;

/** Cells and tiles mounted now that were not in `before`. */
const mountedSince = (before: Mounted, now: Mounted) => ({
  cells: now.cells.filter((cell) => !before.cells.some((other) => other.id === cell.id)),
  tiles: now.tiles.filter((tile) => !before.tiles.some((other) => other.key === tile.key)),
});

/** A newly mounted record shows its target pose (in its section) and moves on no effect of its own. */
function expectAtTarget(records: readonly { moving: boolean; dx: number; dy: number }[], label: string): void {
  for (const record of records) {
    expect(record.moving, `${label}: ${JSON.stringify(record)} has an effect`).toBe(false);
    expect(Math.abs(record.dx), `${label}: ${JSON.stringify(record)}`).toBeLessThanOrEqual(.5);
    expect(Math.abs(record.dy), `${label}: ${JSON.stringify(record)}`).toBeLessThanOrEqual(.5);
  }
}

/** Epochs that started motion so far. */
const effectsCreated = async (page: Page) => (await motionState(page)).started;
/** Each running epoch and the time it displays. */
const clockTimes = async (page: Page) => (await motionState(page)).running.map(({ epoch, at }) => [epoch, at]);

test("scrolling the grid while rows move mounts cells at their target, with no effect, publication or motion start", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openView(page, 180, "?many=80", false);
  await expect(page.getByRole("grid", { name: "Folder", exact: true })).toHaveAttribute("aria-colcount", "1");
  await holdMotion(page);
  try {
    // Opening the first stack moves every row below it.
    await stack(page, "village").locator("[data-stack-toggle]").click();
    await awaitMotionRunning(page);
    await seek(page, 40);
    const events = (await sceneEvents(page)).length, effects = await effectsCreated(page), clock = await clockTimes(page);
    expect(effects).toBeGreaterThan(0);
    const before = await page.evaluate(mounted);
    // Far past the window and the participants' margin, in steps, while the motion is held mid-flight.
    const frames = await sampleFrames(page, mounted, 600, async () => {
      for (const top of [900, 1800, 2700, 3600, 4500]) {
        await view(page).evaluate((element, top) => { element.scrollTop = top; }, top);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    });
    const after = await page.evaluate(mounted);
    const fresh = mountedSince(before, after);
    expect(fresh.cells.length, "scrolling mounted new cells").toBeGreaterThan(5);
    expectAtTarget(fresh.cells, "after scrolling");
    // In every frame, a cell mounted by the scroll is where the scene puts it.
    for (const [index, frame] of frames.entries()) expectAtTarget(mountedSince(before, frame).cells, `frame ${index}`);
    expect((await sceneEvents(page)).slice(events).filter((event) => event.kind !== "action-begin"), "a mount publishes and starts nothing").toEqual([]);
    expect(await effectsCreated(page), "a mount starts no motion").toBe(effects);
    expect(await clockTimes(page), "the clock is not restarted").toEqual(clock);

    // The model agrees with what a mount displays: interrupting now continues those cells from where they are shown.
    const shownAt = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")]
      .map((cell) => { const box = cell.getBoundingClientRect(); return [cell.dataset.gridCell!, [box.left, box.top]]; })));
    const displayed = await shownAt();
    // A host selection of a stack in view opens it: no scroll anchor, so nothing compensates a jump.
    await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect();
      const visible = [...document.querySelectorAll<HTMLElement>("section[data-component]")]
        .find((section) => { const box = section.getBoundingClientRect(); return box.top >= view.top && box.top + 100 <= view.bottom; });
      (window as any).trace.selectPath(`/pictures/${visible!.getAttribute("aria-label")}.png`);
    });
    await awaitMotionStarted(page);
    const replaced = await shownAt();
    let compared = 0;
    for (const cell of fresh.cells) {
      const [x, y] = displayed[cell.id], now = replaced[cell.id];
      if (!now) continue;
      expect(Math.abs(now[0] - x), `${cell.id} jumped sideways`).toBeLessThanOrEqual(.5);
      expect(Math.abs(now[1] - y), `${cell.id} jumped`).toBeLessThanOrEqual(.5);
      compared++;
    }
    expect(compared).toBeGreaterThan(5);
  } finally { await releaseMotion(page); }
  await settle(page);
  await expect(page.locator("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("scrolling a windowed band while it moves mounts tiles at their place in their section, with no effect", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openView(page, 420, "?fanChildren=200", false);
  await stack(page, "fan").locator("[data-stack-toggle]").click();
  await settle(page);
  // The band is windowed: far fewer tiles are mounted than it holds.
  const total = 200;
  expect(await stack(page, "fan").locator(".graph [data-tile-key]").count()).toBeLessThan(total / 2);
  await view(page).evaluate((element) => { element.scrollTop = 0; });
  await settle(page);
  await clearSceneEvents(page);
  await holdMotion(page);
  try {
    // Opening a stack above the band moves the band's section down.
    await stack(page, "village").locator("[data-stack-toggle]").click();
    await awaitMotionRunning(page);
    await seek(page, 60);
    const events = (await sceneEvents(page)).length, effects = await effectsCreated(page), clock = await clockTimes(page);
    const before = await page.evaluate(mounted);
    const fanTop = await stack(page, "fan").evaluate((section) => parseFloat(section.style.top));
    const frames = await sampleFrames(page, mounted, 600, async () => {
      for (const step of [1, 2, 3, 4, 5, 6]) {
        await view(page).evaluate((element, top) => { element.scrollTop = top; }, fanTop + step * 700);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    });
    const after = await page.evaluate(mounted);
    const fresh = mountedSince(before, after);
    expect(fresh.tiles.length, "scrolling mounted new band tiles").toBeGreaterThan(5);
    expectAtTarget(fresh.tiles, "after scrolling");
    for (const [index, frame] of frames.entries()) expectAtTarget(mountedSince(before, frame).tiles, `frame ${index}`);
    expect((await sceneEvents(page)).slice(events).filter((event) => event.kind !== "action-begin")).toEqual([]);
    expect(await effectsCreated(page)).toBe(effects);
    expect(await clockTimes(page)).toEqual(clock);
  } finally { await releaseMotion(page); }
  await settle(page);
  await expect(page.locator("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("records moving at a commit stay mounted until they settle, wherever the view scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openView(page, 180, "?many=80", false);
  await holdMotion(page);
  let moving: string[] = [];
  try {
    await stack(page, "village").locator("[data-stack-toggle]").click();
    await awaitMotionRunning(page);
    moving = (await page.evaluate(mounted)).cells.filter((cell) => cell.moving).map((cell) => cell.id);
    expect(moving.length).toBeGreaterThan(0);
    await view(page).evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const still = (await page.evaluate(mounted)).cells.map((cell) => cell.id);
    for (const id of moving) expect(still, `${id} was unmounted mid-motion`).toContain(id);
  } finally { await releaseMotion(page); }
  await settle(page);
  // Settled, they are no longer pinned: the window holds only what is near the viewport again.
  await view(page).evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await settle(page);
  const left = (await page.evaluate(mounted)).cells.map((cell) => cell.id);
  expect(moving.some((id) => !left.includes(id))).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});

test("arrow keys reach band tiles that are not mounted, mounting and focusing them in view", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openView(page, 420, "?fanChildren=200", false);
  await stack(page, "fan").locator("[data-stack-toggle]").click();
  await settle(page);
  const first = page.locator(`[data-node-key="${await key(page, "fan")}"]`).first();
  await first.click();
  await settle(page);
  const initially = new Set(await page.locator(".graph [data-tile-key]").evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("data-tile-key"))));
  let reached: string | null = null;
  for (let press = 0; press < 40 && (reached === null || initially.has(reached)); press++) {
    await page.keyboard.press("ArrowDown");
    await settle(page);
    reached = await page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null);
    expect(reached, `press ${press} kept focus on a tile`).not.toBeNull();
  }
  expect(initially.has(reached!), "navigation reached a tile that was not mounted").toBe(false);
  const focused = page.locator(`[data-node-key="${reached}"]`);
  await expect(focused).toBeFocused();
  await expect(focused).toBeInViewport();
  // It is the selection, as a click on it would make it.
  await expect(page.locator(`.tile[data-tile-key="${reached}"]`)).toHaveAttribute("aria-selected", "true");
  expect(await uncaught(page)).toEqual([]);
});

// Review 099e72f: a large band's window was measured only through an effect/ResizeObserver feedback
// loop, so it could stay at the pose a motion started from; at settle its moving tiles unpinned and
// the band showed empty in view until the next scroll.
/** The wr-0 band's canvas: how much of it is in view, and how many of its mounted tiles are. Self-contained: it runs in the page. */
function bandInView() {
  const section = [...document.querySelectorAll<HTMLElement>("section[data-component]")].find((element) => element.getAttribute("aria-label") === "wr-0");
  const canvas = section?.querySelector<HTMLElement>(".graph");
  if (!canvas) return { visible: 0, tiles: 0 };
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect(), box = canvas.getBoundingClientRect();
  const tiles = [...canvas.querySelectorAll<HTMLElement>("[data-tile-key]")].filter((tile) => {
    const rect = tile.getBoundingClientRect();
    return rect.bottom > view.top && rect.top < view.bottom;
  }).length;
  return { visible: Math.round(Math.min(view.bottom, box.bottom) - Math.max(view.top, box.top)), tiles };
}

/** wr-0's large band below the fan's: closing the fan carries it up into view. Both browsers lay it out alike at this width. */
async function bandBelowFan(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 700 });
  await openView(page, 400, "?fanChildren=200&wideRoots=70", false);
  await stack(page, "wr-0").locator("[data-stack-toggle]").click();
  await settle(page);
  await stack(page, "fan").locator("[data-stack-toggle]").evaluate((element: HTMLElement) => element.click());
  await settle(page);
  await view(page).evaluate((element) => { element.scrollTop = 0; });
  await settle(page);
  expect((await page.evaluate(bandInView)).visible, "wr-0 starts below the view").toBeLessThan(0);
}

/** wr-0's canvas top and its mounted tiles, relative to the canvas, with the view's span. Self-contained: it runs in the page. */
function bandTiles() {
  const section = [...document.querySelectorAll<HTMLElement>("section[data-component]")].find((element) => element.getAttribute("aria-label") === "wr-0");
  const canvas = section?.querySelector<HTMLElement>(".graph");
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect();
  if (!canvas) return { top: NaN, viewTop: view.top, viewBottom: view.bottom, tiles: {} as Record<string, [number, number]> };
  const box = canvas.getBoundingClientRect();
  const tiles = Object.fromEntries([...canvas.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => {
    const rect = tile.getBoundingClientRect();
    return [tile.dataset.tileKey!, [rect.top - box.top, rect.bottom - box.top] as [number, number]];
  }));
  return { top: box.top, viewTop: view.top, viewBottom: view.bottom, tiles };
}

// Deterministic: the motion is held and sought to chosen times. At each, every tile of the band
// that the settled scene mounts and that is in view where the band is displayed then is mounted.
test("a large band carried into view has every in-view tile mounted at each time of its motion, and after it settles", async ({ page }) => {
  await bandBelowFan(page);
  await holdMotion(page);
  const shown: { time: number; band: ReturnType<typeof bandTiles> }[] = [];
  try {
    await stack(page, "fan").locator("[data-stack-toggle]").click();
    await awaitMotionStarted(page);
    for (const time of [0, 20, 40, 60, 80, 100, 120, 140, 159]) {
      await seek(page, time);
      shown.push({ time, band: await page.evaluate(bandTiles) });
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  const after = await page.evaluate(bandInView);
  expect(after.visible).toBeGreaterThan(300);
  expect(after.tiles).toBeGreaterThan(0);
  const settled = await page.evaluate(bandTiles);
  expect(Object.keys(settled.tiles).length).toBeGreaterThan(0);
  expect(shown.some(({ band }) => band.top < band.viewBottom - 300), "the band came into view while sought").toBe(true);
  for (const { time, band } of shown) {
    if (!Number.isFinite(band.top)) continue;
    const inView = Object.entries(settled.tiles).filter(([, [top, bottom]]) => band.top + bottom > band.viewTop && band.top + top < band.viewBottom).map(([key]) => key);
    expect(inView.filter((key) => !(key in band.tiles)), `in-view tiles not mounted at ${time} ms`).toEqual([]);
  }
});

test("a large band carried into view by a motion held at its start mounts its tiles once released", async ({ page }) => {
  await bandBelowFan(page);
  await holdMotion(page);
  try {
    await stack(page, "fan").locator("[data-stack-toggle]").click();
    await awaitMotionStarted(page);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally { await releaseMotion(page); }
  await settle(page);
  // No scroll since: the window follows the motion and its settlement, not scroll events.
  const after = await page.evaluate(bandInView);
  expect(after.visible).toBeGreaterThan(300);
  expect(after.tiles, "band tiles mounted in view after settle").toBeGreaterThan(0);
  await view(page).evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await settle(page);
  expect((await page.evaluate(bandInView)).tiles).toBe(after.tiles);
});

// Review 8d257bf: every outside measurement (scroll, publication, motion start) started another
// frame loop while the presentation moved, so ten scrolls measured eleven times per frame.
test("scrolling while the presentation moves keeps one measuring frame loop", async ({ page }) => {
  await bandBelowFan(page);
  await page.evaluate(() => {
    const w = window as any, raf = window.requestAnimationFrame.bind(window);
    w.__measures = 0;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => raf((time) => { if (callback.name.startsWith("measure")) w.__measures++; callback(time); });
  });
  const perFrame = () => page.evaluate(async () => {
    const w = window as any;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = w.__measures;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return w.__measures - before;
  });
  await holdMotion(page);
  try {
    await stack(page, "fan").locator("[data-stack-toggle]").evaluate((element: HTMLElement) => element.click());
    await awaitMotionStarted(page);
    expect(await perFrame(), "a measuring loop runs while moving").toBe(1);
    for (let index = 0; index < 10; index++) {
      await view(page).evaluate((element, index) => { element.scrollTop = 10 + index * 3; }, index);
      await page.waitForTimeout(30);
    }
    expect(await perFrame(), "still one after ten scrolls").toBe(1);
  } finally { await releaseMotion(page); }
  await settle(page);
  expect(await perFrame(), "none once settled").toBe(0);
});

// Review 8d257bf: a resize was measured on the next frame, so a pane growing taller by more than
// the window margin painted a frame with cells mounted only to the old window.
test("a pane growing much taller mounts the cells it shows on the first frame", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 300 });
  await openView(page, 900, "?many=400", false);
  const probe = () => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect();
    const grid = document.querySelector<HTMLElement>('[role="grid"]')!.getBoundingClientRect();
    const bottoms = [...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => cell.getBoundingClientRect().bottom);
    return { view: Math.round(view.bottom), grid: Math.round(grid.bottom), mounted: Math.round(Math.max(...bottoms)) };
  };
  const frames = await samplePaintedFrames(page, probe, 600, () => page.setViewportSize({ width: 900, height: 3000 }));
  expect(frames.some((frame) => frame.view > 2000), "the pane grew while sampled").toBe(true);
  expect(frames.filter((frame) => frame.grid > frame.view && frame.mounted < frame.view - 150), "frames with unmounted cells in view").toEqual([]);
});
