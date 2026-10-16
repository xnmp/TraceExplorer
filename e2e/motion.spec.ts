import { test, expect, type Page } from "@playwright/test";
import { key, openView, settle, state, uncaught, ensureExpanded } from "./support";
import { awaitMotionStarted, holdMotion, motionState, releaseMotion } from "./animation-control";
import { clickThroughGym, motionFaults, node, sampleClick, settledScrollTop } from "./motion-support";

/**
 * Per-frame contracts for motion, sampled on every animation frame after an
 * input: what the user sees, not how it is animated (see motion-support.ts).
 */

test.describe("tiles stay in place", () => {
  test.use({ viewport: { width: 1100, height: 900 } });

  // The host zooms the whole document (its zoom level, as CSS `zoom` on the root).
  for (const zoom of [1, 1.3]) {
    test(`at ${zoom * 100}% zoom, no click moves a tile that keeps its place, and moved tiles travel straight to their target`, async ({ page }) => {
      await clickThroughGym(page, zoom === 1 ? "" : `&zoom=${zoom}`);
    });
  }
});

/** Put two named covers in consecutive grid rows, with ample rows below for anchoring. */
async function openAnchorView(page: Page, extra = "") {
  await openView(page, 120, `?anchorChains=1&many=8${extra}`, false);
  await page.evaluate(() => {
    const trace = (window as any).trace;
    const rank = (path: string) => path === "/pictures/anchor-a.png" ? 0 : path === "/pictures/anchor-b.png" ? 1 : 2;
    trace.navigate("/pictures", trace.listing().sort((a: { path: string }, b: { path: string }) => rank(a.path) - rank(b.path)));
  });
  await settle(page);
  for (const name of ["anchor-a", "anchor-b"]) await ensureExpanded(page.locator(`section[aria-label="${name}"]`));
}

// Selection never changes another section (explicit expansion): a click in B leaves A as it was,
// and B's cover (already open) holds still on every frame. (Before, focus moved away from A and
// A's neighborhood shrank.)
test("a click in a later section leaves an earlier one as it was, and the clicked tile stays still on screen", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openAnchorView(page);
  await page.locator(await node(page, "anchor-a-middle")).click();
  await settle(page);
  const last = await key(page, "anchor-a-last");
  await expect(page.locator(`[data-tile-key="${last}"]`)).toBeVisible();
  const clicked = await key(page, "anchor-b");
  const before = await page.evaluate((clicked) => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    const tile = view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
    // Leave room to compensate A's shrink, with B comfortably visible and
    // ample content below it so scroll clamping cannot mask the result.
    view.scrollTop += tile.getBoundingClientRect().top - view.getBoundingClientRect().top - 160;
    const box = tile.getBoundingClientRect();
    return { x: box.x, y: box.y, scrollTop: view.scrollTop };
  }, clicked);
  expect(before.scrollTop).toBeGreaterThan(115);
  await holdMotion(page);
  const result = await page.evaluate(async ({ clicked, last }) => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
    const graphB = tile().closest("section")!.querySelector<HTMLElement>(".graph")!;
    const graphA = view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(last)}"]`)!.closest("section")!.querySelector<HTMLElement>(".graph")!;
    const height = graphA.getBoundingClientRect().height;
    const motion = (window as any).trace.motion;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const sample = () => { const box = tile().getBoundingClientRect(); return { x: box.x, y: box.y }; };
    const positions = [sample()];
    view.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(clicked)}"]`)!.click();
    await frame();
    // Machine speed cannot advance a held motion clock while we sample the anchor.
    if (motion.owns(graphA)) throw new Error("the click moved the earlier section");
    const bMotions = [graphB, ...graphB.querySelectorAll("*")].filter((element) => motion.owns(element)).length;
    const duration = Math.max(0, ...motion.state().running.map((epoch: { duration: number }) => epoch.duration));
    for (let step = 0; step <= 10; step++) {
      motion.seek(duration * step / 10);
      await frame();
      positions.push(sample());
    }
    const shrink = height - graphA.getBoundingClientRect().height;
    motion.finish();
    await frame();
    positions.push(sample());
    return { positions, shrink, bMotions, scrollTop: view.scrollTop };
  }, { clicked, last });
  await releaseMotion(page);
  await settle(page);
  expect(result.bMotions, "B's geometry stays unchanged").toBe(0);
  expect(result.shrink, "A keeps its height").toBe(0);
  expect(result.scrollTop, "nothing to compensate").toBeCloseTo(before.scrollTop, 0);
  for (const position of result.positions) {
    expect(Math.abs(position.x - before.x), "clicked tile's screen x throughout the relayout").toBeLessThan(1);
    expect(Math.abs(position.y - before.y), "clicked tile's screen y throughout the relayout").toBeLessThan(1);
  }
  await expect(page.locator(`[data-tile-key="${last}"]`)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

/** Position B away from both scroll limits, after A's focused neighborhood has expanded. */
async function prepareCrossSectionAnchor(page: Page, name: string, extra = "") {
  await page.setViewportSize({ width: 800, height: 600 });
  await openAnchorView(page, extra);
  await page.locator(await node(page, "anchor-a-middle")).click();
  await settle(page);
  const clicked = await key(page, name), earlier = await key(page, "anchor-a");
  const before = await page.evaluate((clicked) => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    const tile = view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
    view.scrollTop += tile.getBoundingClientRect().top - view.getBoundingClientRect().top - 160;
    return { y: tile.getBoundingClientRect().top, scrollTop: view.scrollTop, earlierHeight: view.querySelector(`[data-tile-key="${CSS.escape((window as any).trace.backend.key("anchor-a-last"))}"]`)!.closest("section")!.querySelector(".graph")!.getBoundingClientRect().height };
  }, clicked);
  await settle(page);
  expect(before.scrollTop).toBeGreaterThan(115);
  return { clicked, earlier, before };
}

// The first click on B's child opens its 75 descendants: a worker-sized layout. Nothing of it
// commits until the worker answers, and the section above never changes (explicit expansion).
test("a worker-sized expansion commits once its layout arrives, anchored throughout, leaving the section above as it was", async ({ page }) => {
  const { clicked, earlier, before } = await prepareCrossSectionAnchor(page, "anchor-b-child", "&anchorWorker=1");
  await holdMotion(page);
  try {
    await page.evaluate((clicked) => {
      const w = window as any;
      w.__anchorPostMessage = Worker.prototype.postMessage;
      w.__anchorLayouts = [];
      Worker.prototype.postMessage = function (this: Worker, message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        w.__anchorLayouts.push(() => w.__anchorPostMessage.call(this, message, transferOrOptions));
      };
      document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(clicked)}"]`)!.click();
    }, clicked);
    // One action: while B's worker layout is held, nothing of it commits.
    await page.waitForFunction(() => (window as any).__anchorLayouts.length > 0);
    const pending = await page.evaluate(async ({ clicked, earlier, earlierHeight }) => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      const graph = view.querySelector(`[data-tile-key="${CSS.escape(earlier)}"]`)!.closest("section")!.querySelector<HTMLElement>(".graph")!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const height = earlierHeight;
      const motion = (window as any).trace.motion;
      const duration = Math.max(0, ...motion.state().running.map((epoch: { duration: number }) => epoch.duration));
      const positions = [tile().getBoundingClientRect().top];
      for (let step = 0; step <= 10; step++) {
        motion.seek(duration * step / 10);
        await frame();
        positions.push(tile().getBoundingClientRect().top);
      }
      motion.finish();
      await frame();
      positions.push(tile().getBoundingClientRect().top);
      return { positions, shrink: height - graph.getBoundingClientRect().height, pending: (window as any).trace.layoutsPending() };
    }, { clicked, earlier, earlierHeight: before.earlierHeight });
    expect(pending.pending, "B's real worker request is still held").toBeGreaterThan(0);
    expect(pending.shrink, "A keeps its geometry").toBe(0);
    await expect(page.locator(`[data-tile-key="${await key(page, "anchor-a-last")}"]`)).toHaveCount(1);
    for (const y of pending.positions) expect(Math.abs(y - before.y), "held before the scene commits").toBeLessThan(1);

    await page.evaluate(() => {
      const w = window as any;
      Worker.prototype.postMessage = w.__anchorPostMessage;
      for (const release of w.__anchorLayouts.splice(0)) release();
    });
    await page.waitForFunction(() => (window as any).trace.layoutsPending() === 0);
    // B's 75 newly opened descendants prove this was the worker-sized scene; A is as it was.
    const leaf = await key(page, "anchor-b-leaf-74");
    await expect(page.locator(`[data-tile-key="${leaf}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-tile-key="${await key(page, "anchor-a-last")}"]`)).toHaveCount(1);
    const positions = await page.evaluate(async (clicked) => {
      const tile = () => document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await frame();
      const motion = (window as any).trace.motion;
      const duration = Math.max(0, ...motion.state().running.map((epoch: { duration: number }) => epoch.duration));
      const positions = [tile().getBoundingClientRect().top];
      for (let step = 0; step <= 10; step++) {
        motion.seek(duration * step / 10);
        await frame();
        positions.push(tile().getBoundingClientRect().top);
      }
      motion.finish();
      await frame();
      positions.push(tile().getBoundingClientRect().top);
      return positions;
    }, clicked);
    for (const y of positions) expect(Math.abs(y - before.y), "held through B's commit and motion").toBeLessThan(1);
  } finally {
    await page.evaluate(() => {
      const w = window as any;
      if (w.__anchorPostMessage) Worker.prototype.postMessage = w.__anchorPostMessage;
      for (const release of w.__anchorLayouts ?? []) release();
    });
    await releaseMotion(page);
  }
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});

test("continuous relayouts in another section keep the tile anchored and yield to user scrolling", async ({ page }) => {
  const { clicked, before } = await prepareCrossSectionAnchor(page, "anchor-b");
  await holdMotion(page);
  try {
    const positions = await page.evaluate(async (clicked) => {
      const w = window as any, view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const positions: number[] = [];
      view.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(clicked)}"]`)!.click();
      await frame();
      for (let update = 0; update < 8; update++) {
        // Seek to 100 ms of a 160 ms relayout, then interrupt it with another
        // backend update. This guarantees overlapping motion on any machine.
        (window as any).trace.motion.seek(100);
        await frame();
        positions.push(tile().getBoundingClientRect().top);
        const added = w.trace.backend.startGeneration("anchor-a", `continuous-${update}`);
        let committed = false;
        for (let attempts = 0; attempts < 2000; attempts++) {
          await frame();
          positions.push(tile().getBoundingClientRect().top);
          if (view.querySelector(`[data-tile-key="${CSS.escape(added)}"]`)) { committed = true; break; }
        }
        if (!committed) throw new Error("backend update did not reveal its generated tile");
      }
      return positions;
    }, clicked);
    for (const y of positions) expect(Math.abs(y - before.y), "held through every interrupted relayout").toBeLessThan(1);
    const scroller = page.getByTestId("trace-view");
    const box = (await scroller.boundingBox())!;
    const beforeScroll = await scroller.evaluate((view) => view.scrollTop);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 150);
    await expect.poll(() => scroller.evaluate((view) => view.scrollTop)).toBeGreaterThan(beforeScroll + 100);
    const scrolled = await settledScrollTop(page);
    const after = await page.evaluate(async () => {
      const w = window as any, view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const added = w.trace.backend.startGeneration("anchor-a", "after-user-scroll");
      for (let attempt = 0; attempt < 2000; attempt++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (view.querySelector(`[data-tile-key="${CSS.escape(added)}"]`)) break;
        if (attempt === 1999) throw new Error("post-scroll update did not commit");
      }
      const positions: number[] = [];
      for (let step = 0; step <= 10; step++) {
        (window as any).trace.motion.seek(160 * step / 10);
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        positions.push(view.scrollTop);
      }
      return positions;
    });
    for (const top of after) expect(top, "later relayouts do not fight the user's scroll").toBeCloseTo(scrolled, 0);
  } finally {
    await releaseMotion(page);
  }
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});

test.describe("bands expand and collapse quickly", () => {
  /** Toggles a section and records the following section's displayed top each frame. */
  const sampleToggle = (page: Page, index: number, ms = 500) => page.evaluate(async ({ index, ms }) => {
    const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[index];
    const next = section.nextElementSibling as HTMLElement;
    const frames: Array<{ t: number; top: number }> = [];
    const start = performance.now();
    frames.push({ t: 0, top: next.getBoundingClientRect().top });
    section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
    await new Promise<void>((resolve) => {
      const step = () => {
        const t = performance.now() - start;
        frames.push({ t, top: next.getBoundingClientRect().top });
        if (t < ms) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    return frames;
  }, { index, ms });

  test("following rows travel with each band from their displayed position", async ({ page }) => {
    await openView(page, 120);
    const forest = page.locator("section.component[data-component]").nth(1);
    for (const expanded of ["false", "true", "false", "true"]) {
      await holdMotion(page);
      const result = await page.evaluate(async () => {
        const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1];
        const next = section.nextElementSibling as HTMLElement;
        const row = Number(next.querySelector('[data-grid-cell]')!.getAttribute("aria-rowindex")) - 1;
        const before = next.getBoundingClientRect().top, samples = [];
        section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
        for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
        for (const time of [0, 40, 80, 120, 160]) {
          (window as any).trace.motion.seek(time);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const top = next.getBoundingClientRect().top;
          const bottoms = [...document.querySelectorAll<HTMLElement>("[data-grid-row-band]")]
            .filter((band) => Number(band.dataset.gridRowBand) < row).map((band) => band.getBoundingClientRect().bottom);
          samples.push({ top, bottom: Math.max(-Infinity, ...bottoms) });
        }
        return { before, samples };
      });
      await releaseMotion(page); await settle(page);
      await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", expanded);
      await expect(forest.locator(".content")).toHaveCount(expanded === "true" ? 1 : 0);
      expect(Math.abs(result.samples.at(-1)!.top - result.before)).toBeGreaterThan(40);
      expect(result.samples[0].top).toBeCloseTo(result.before, 0);
      let previous = result.before;
      const direction = Math.sign(result.samples.at(-1)!.top - result.before);
      for (const sample of result.samples) {
        expect((sample.top - previous) * direction).toBeGreaterThanOrEqual(-.5);
        previous = sample.top;
        expect(sample.top).toBeGreaterThanOrEqual(sample.bottom - .5);
      }
    }
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  /** Seeks both halves of a reversal and samples after the replacement DOM commit. */
  async function reverseMidway(page: Page) {
    const top = () => page.evaluate(() => document.querySelectorAll<HTMLElement>("section.component[data-component]")[1].nextElementSibling!.getBoundingClientRect().top);
    const toggle = () => page.evaluate(() => document.querySelectorAll<HTMLElement>("section.component[data-component]")[1].querySelector<HTMLElement>("[data-stack-toggle]")!.click());
    const start = await top();
    await holdMotion(page);
    try {
      await toggle(); await awaitMotionStarted(page);
      await page.evaluate(async () => {
        (window as any).trace.motion.seek(40);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const before = await top();
      await toggle(); await awaitMotionStarted(page);
      const resumed = await top();
      const tops = await page.evaluate(async () => {
        const next = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1].nextElementSibling!;
        const tops = [];
        for (const time of [0, 20, 40, 80, 120, 160]) {
          (window as any).trace.motion.seek(time);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          tops.push(next.getBoundingClientRect().top);
        }
        return tops;
      });
      return { start, before, resumed, tops };
    } finally { await releaseMotion(page); await settle(page); }
  }

  test("toggling again mid-way reverses from where the section is displayed", async ({ page }) => {
    await openView(page, 120);
    const forest = page.locator("section.component[data-component]").nth(1);
    const result = await reverseMidway(page);
    expect(result.start - result.before).toBeGreaterThan(15);
    expect(Math.abs(result.resumed - result.before)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.tops.at(-1)! - result.start)).toBeLessThanOrEqual(1);
    await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("collapsing again mid-way through opening reverses smoothly and ends with the content gone", async ({ page }) => {
    await openView(page, 120);
    const forest = page.locator("section.component[data-component]").nth(1);
    await forest.locator("[data-stack-toggle]").click(); await settle(page);
    const result = await reverseMidway(page);
    expect(result.before - result.start).toBeGreaterThan(15);
    expect(Math.abs(result.resumed - result.before)).toBeLessThanOrEqual(1);
    let previous = result.resumed;
    for (const top of result.tops) {
      expect(top).toBeLessThanOrEqual(previous + 1);
      expect(top).toBeGreaterThanOrEqual(result.start - 1);
      previous = top;
    }
    expect(Math.abs(result.tops.at(-1)! - result.start)).toBeLessThanOrEqual(1);
    await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
    await expect(forest.locator(".content")).toHaveCount(0);
    expect(await uncaught(page)).toEqual([]);
  });

  test("collapsing a section at the bottom of a scrolled view slides into place without a jump at the end", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await openView(page, 120, "?many=4");
    // Open the last section and scroll to the very bottom, so collapsing it shortens the view past the scroll position.
    await page.evaluate(() => (window as any).trace.selectPath("/pictures/m0.png"));
    const section = page.locator('section.component[aria-label="m0"]');
    await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
    await section.locator("[data-node-key]").first().scrollIntoViewIfNeeded();
    await settle(page);
    await page.evaluate(() => { const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!; view.scrollTop = view.scrollHeight; });
    await settle(page);
    const frames = await page.evaluate(async () => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const section = document.querySelector<HTMLElement>('section.component[aria-label="m0"]')!;
      const watched = [view.querySelector<HTMLElement>('[role="grid"]')!, section, section.nextElementSibling as HTMLElement];
      const sample = () => watched.map((element) => element.getBoundingClientRect().top);
      const frames = [sample()];
      section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
      for (let i = 0; i < 40; i++) { await new Promise((resolve) => requestAnimationFrame(resolve)); frames.push(sample()); }
      return { frames, overflow: view.scrollHeight - view.clientHeight - view.scrollTop };
    });
    expect(frames.overflow).toBeLessThan(1);
    // The grid camera, section and following cell move straight to where they end.
    for (let element = 0; element < 3; element++) {
      const path = frames.frames.map((frame) => frame[element]);
      const end = path.at(-1)!;
      for (let i = 1; i < path.length; i++) expect(Math.abs(path[i] - end), `element ${element}: ${path.map(Math.round)}`).toBeLessThanOrEqual(Math.abs(path[i - 1] - end) + 0.5);
    }
    await expect(section.locator(".content")).toHaveCount(0);
  });

  test("a section opened because it holds the focus stays open when a tile elsewhere is chosen", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 1200 });
    await openView(page, undefined, "?gym=1");
    // The fourth section starts collapsed and opens when its image is selected from outside the graph.
    const sections = page.locator("section.component[data-component]");
    const fan = sections.nth(3);
    await expect(fan.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (window as any).trace.selectPath((window as any).trace.backend.path("fan")));
    await expect(fan.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
    await settle(page);
    const frames = await sampleClick(page, await node(page, "cerulean"));
    expect(motionFaults(frames)).toEqual([]);
    await expect(fan.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  });

  test("with reduced motion a section opens and closes at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openView(page, 120);
    const { started } = await motionState(page);
    for (let i = 0; i < 2; i++) {
      const frames = await sampleToggle(page, 1, 120);
      expect(Math.abs(frames[1].top - frames.at(-1)!.top)).toBeLessThan(1);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      expect((await motionState(page)).started, "motion started").toBe(started);
    }
  });
});

test.describe("anchoring under the host's zoom", () => {
  test.use({ viewport: { width: 1200, height: 700 } });

  test("at 130% zoom the clicked tile stays where it was on screen while its graph relayouts", async ({ page }) => {
    // Narrow enough that the village runs top to bottom (the view only scrolls, and anchors, vertically).
    await openView(page, 480, "?many=8&zoom=1.3");
    // Selecting merge after warm reveals relatives while retaining its attachment,
    // including both current-folder roots in this merged lineage.
    await page.locator(await node(page, "warm")).click();
    await settle(page);
    await page.evaluate(() => { document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop += 200; });
    await settle(page);
    const target = await node(page, "merge");
    const offset = () => page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!.closest<HTMLElement>("[data-tile-key]")!;
      return { screen: element.getBoundingClientRect().top, inGraph: parseFloat(element.style.top) };
    }, target);
    const before = await offset();
    const key = await page.evaluate((selector) => document.querySelector<HTMLElement>(selector)!.dataset.nodeKey!, target);
    const frames = await sampleClick(page, target);
    await settle(page);
    const after = await offset();
    expect(Math.abs(after.inGraph - before.inGraph)).toBeLessThanOrEqual(1);
    // Held at the same height on screen on every frame, not only once motion ends. (It may move
    // sideways within its graph: the view only scrolls vertically.)
    const shown = frames.filter((frame) => frame.tiles[key]);
    expect(shown.length).toBeGreaterThan(3);
    expect(Math.max(...shown.map((frame) => Math.abs(frame.tiles[key][3] - shown[0].tiles[key][3])))).toBeLessThanOrEqual(2);
    expect(Math.abs(after.screen - before.screen)).toBeLessThanOrEqual(2);
  });
});

test.describe("anchoring under the host's zoom, content above changing", () => {
  // A click changes nothing outside the clicked tile's own children, so the scroll compensation
  // under zoom is exercised by new data growing a section above it (a generation landing in A).
  test("at 130% zoom the clicked tile stays where it was on screen while an earlier section grows", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await openAnchorView(page, "&zoom=1.3");
    const clicked = await key(page, "anchor-b");
    const before = await page.evaluate((clicked) => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      view.scrollTop += (tile.getBoundingClientRect().top - view.getBoundingClientRect().top - 160) / 1.3;
      return { scrollTop: view.scrollTop };
    }, clicked);
    expect(before.scrollTop).toBeGreaterThan(115);
    await settle(page);
    const frames = await page.evaluate(async (clicked) => {
      const w = window as any, view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!.getBoundingClientRect();
      const frames: Array<{ x: number; y: number }> = [{ x: tile().x, y: tile().y }];
      view.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(clicked)}"]`)!.click();
      const added = w.trace.backend.startGeneration("anchor-a", "zoomed-growth");
      for (let index = 0; index < 2000; index++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        frames.push({ x: tile().x, y: tile().y });
        if (view.querySelector(`[data-tile-key="${CSS.escape(added)}"]`) && index > 30) break;
      }
      return frames;
    }, clicked);
    await settle(page);
    const scrollTop = await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop);
    // The earlier section's growth moved the clicked tile down in the document; the view compensated.
    expect(scrollTop - before.scrollTop, "the view scrolled to compensate").toBeGreaterThan(30);
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) {
      expect(Math.abs(frame.y - frames[0].y), "clicked tile's screen y on every frame").toBeLessThanOrEqual(2);
      expect(Math.abs(frame.x - frames[0].x), "clicked tile's screen x on every frame").toBeLessThanOrEqual(2);
    }
    expect(await uncaught(page)).toEqual([]);
  });
});

test.describe("reveals from outside the view", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  // The host selecting a node hidden under a collapsed parent opens the path to it: an expansion,
  // so it travels into place (from its parent's side) and ends exactly at its destination.
  test("a node the host selects is revealed and travels to its accepted destination", async ({ page }) => {
    await openView(page, 900, "?deeper=1");
    const dawn = await key(page, "mist-dawn");
    await expect(page.locator(`[data-tile-key="${dawn}"]`)).toHaveCount(0);
    await holdMotion(page);
    try {
      await page.evaluate(() => (window as any).trace.selectPath("/pictures/mist-dawn.png"));
      await expect(page.locator(`[data-tile-key="${dawn}"]`)).toHaveCount(1);
      await awaitMotionStarted(page);
      const seen = await page.evaluate(async (dawn) => {
        const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
        const positions = [];
        for (const time of [0, 40, 80, 120, 160]) {
          (window as any).trace.motion.seek(time);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const box = document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(dawn)}"]`)!.getBoundingClientRect();
          positions.push([box.x, box.y + view.scrollTop]);
        }
        return positions;
      }, dawn);
      const last = seen.at(-1)!;
      // Monotone toward its destination, from no further than the entrance offset.
      for (let i = 1; i < seen.length; i++) expect(Math.hypot(seen[i][0] - last[0], seen[i][1] - last[1])).toBeLessThanOrEqual(Math.hypot(seen[i - 1][0] - last[0], seen[i - 1][1] - last[1]) + .5);
      expect(Math.hypot(seen[0][0] - last[0], seen[0][1] - last[1])).toBeLessThanOrEqual(11);
    } finally { await releaseMotion(page); }
    await settle(page);
    expect((await state(page)).selected).toEqual(["/pictures/mist-dawn.png"]);
    expect(await uncaught(page)).toEqual([]);
  });
});

for (const exitAt of [.01, 40]) test(`reopening after collapse reserves space before revealing children (${exitAt}ms)`, async ({ page }) => {
  await openView(page, 900, "", false);
  const village = page.locator('section[aria-label="village"]');
  await village.locator("[data-stack-toggle]").click(); await settle(page);
  const child = await key(page, "daylight");
  await holdMotion(page);
  try {
    await village.getByRole("button", { name: "Collapse stack" }).click();
    await awaitMotionStarted(page);
    const exitOpacity = await page.evaluate(async ({ child, exitAt }) => {
      (window as any).trace.motion.seek(exitAt);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tile = document.querySelector<HTMLElement>(`[data-grid-exit] [data-ghost-tile-key="${child}"]`)!;
      return Number(getComputedStyle(tile).opacity) * Number(getComputedStyle(tile.closest('[data-grid-exit]')!).opacity);
    }, { child, exitAt });
    // A closing band collapses like an accordion: shown whole at first, fading in its second half.
    if (exitAt < 1) expect(exitOpacity, 'shown whole as the collapse starts').toBeCloseTo(1, 2);
    else { expect(exitOpacity, 'fading with the end of the collapse').toBeGreaterThan(0); expect(exitOpacity).toBeLessThan(1); }
    await village.locator("[data-stack-toggle]").click();
    await awaitMotionStarted(page);
    const result = await page.evaluate(async (child) => {
      const tile = document.querySelector<HTMLElement>(`[data-grid-band] [data-tile-key="${child}"]`)!;
      const initialOpacity = Number(getComputedStyle(tile).opacity), samples = [];
      for (const time of [0, 40, 80, 120, 160]) {
        (window as any).trace.motion.seek(time);
        await new Promise(requestAnimationFrame);
        const band = document.querySelector<HTMLElement>('[data-grid-row-band="0"]')!.getBoundingClientRect();
        samples.push([...document.querySelectorAll<HTMLElement>('[data-grid-cell][aria-rowindex]')]
          .filter((cell) => Number(cell.getAttribute('aria-rowindex')) > 1).map((cell) => cell.getBoundingClientRect().top - band.bottom));
      }
      return { initialOpacity, finalOpacity: Number(getComputedStyle(tile).opacity), samples };
    }, child);
    expect(result.initialOpacity).toBeCloseTo(exitOpacity, 2);
    expect(result.finalOpacity).toBe(1);
    for (const sample of result.samples) for (const clearance of sample) expect(clearance).toBeGreaterThanOrEqual(-.5);
    expect(await uncaught(page)).toEqual([]);
  } finally { await releaseMotion(page); }
  await settle(page);
  await expect(page.locator(`[data-tile-key="${child}"]`)).toBeVisible();
});
