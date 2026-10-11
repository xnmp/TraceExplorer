import { test, expect, type Page } from "@playwright/test";
import { key, openView, settle, uncaught, ensureExpanded } from "./support";
import { holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";
import { clickThroughGym, motionFaults, node, sampleClick } from "./motion-support";

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

test("a clicked tile stays on screen while an earlier section shrinks and its own graph stays still", async ({ page }) => {
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
  await holdScriptedAnimations(page);
  const result = await page.evaluate(async ({ clicked, last }) => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
    const graphB = tile().closest("section")!.querySelector<HTMLElement>(".graph")!;
    const graphA = view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(last)}"]`)!.closest("section")!.querySelector<HTMLElement>(".graph")!;
    const height = graphA.getBoundingClientRect().height;
    const held = (window as any).__heldAnimations as Animation[];
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const sample = () => { const box = tile().getBoundingClientRect(); return { x: box.x, y: box.y }; };
    const positions = [sample()];
    view.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(clicked)}"]`)!.click();
    await frame();
    // The two small inline layouts have now committed. Machine speed cannot
    // advance their held animation timelines while we sample the anchor.
    const resize = held.find((animation) => (animation.effect as KeyframeEffect | null)?.target === graphA
      && (animation.effect as KeyframeEffect).getKeyframes().some((keyframe) => "height" in keyframe));
    if (!resize) throw new Error("the earlier graph did not animate its height");
    const bMotions = held.filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && (target === graphB || graphB.contains(target));
    }).length;
    const animations = held.filter((animation) => animation.playState !== "idle");
    const duration = Math.max(...animations.map((animation) => Number(animation.effect!.getTiming().duration)));
    for (let step = 0; step <= 10; step++) {
      for (const animation of animations) animation.currentTime = duration * step / 10;
      await frame();
      positions.push(sample());
    }
    const shrink = height - graphA.getBoundingClientRect().height;
    for (const animation of animations) { animation.playbackRate = 1; animation.finish(); }
    await Promise.allSettled(animations.map((animation) => animation.finished));
    await frame();
    positions.push(sample());
    return { positions, shrink, bMotions, scrollTop: view.scrollTop };
  }, { clicked, last });
  await releaseScriptedAnimations(page);
  await settle(page);
  expect(result.bMotions, "B's geometry stays unchanged").toBe(0);
  expect(result.shrink).toBe(115);
  expect(result.scrollTop).toBeCloseTo(before.scrollTop - 115, 0);
  for (const position of result.positions) {
    expect(Math.abs(position.x - before.x), "clicked tile's screen x throughout the relayout").toBeLessThan(1);
    expect(Math.abs(position.y - before.y), "clicked tile's screen y throughout the relayout").toBeLessThan(1);
  }
  await expect(page.locator(`[data-tile-key="${last}"]`)).toHaveCount(0);
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
    return { y: tile.getBoundingClientRect().top, scrollTop: view.scrollTop };
  }, clicked);
  await settle(page);
  expect(before.scrollTop).toBeGreaterThan(115);
  return { clicked, earlier, before };
}

test("a worker-sized clicked neighborhood is anchored while the section above shrinks synchronously", async ({ page }) => {
  const { clicked, earlier, before } = await prepareCrossSectionAnchor(page, "anchor-b-child", "&anchorWorker=1");
  await holdScriptedAnimations(page);
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
    await page.waitForFunction((earlier) => {
      const w = window as any;
      const graph = document.querySelector(`[data-tile-key="${CSS.escape(earlier)}"]`)!.closest("section")!.querySelector(".graph");
      return w.__anchorLayouts.length > 0 && w.__heldAnimations.some((animation: Animation) =>
        (animation.effect as KeyframeEffect | null)?.target === graph
        && (animation.effect as KeyframeEffect).getKeyframes().some((frame) => "height" in frame));
    }, earlier);
    const pending = await page.evaluate(async ({ clicked, earlier }) => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = () => view.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      const graph = view.querySelector(`[data-tile-key="${CSS.escape(earlier)}"]`)!.closest("section")!.querySelector<HTMLElement>(".graph")!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const height = graph.getBoundingClientRect().height;
      const animations = ((window as any).__heldAnimations as Animation[]).filter((animation) => animation.playState === "running");
      const positions = [tile().getBoundingClientRect().top];
      for (let step = 0; step <= 10; step++) {
        for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) * step / 10;
        await frame();
        positions.push(tile().getBoundingClientRect().top);
      }
      for (const animation of animations) { animation.playbackRate = 1; animation.finish(); }
      await frame();
      positions.push(tile().getBoundingClientRect().top);
      return { positions, shrink: height - graph.getBoundingClientRect().height, pending: (window as any).trace.layoutsPending() };
    }, { clicked, earlier });
    expect(pending.pending, "B's real worker request is still held").toBeGreaterThan(0);
    expect(pending.shrink).toBe(115);
    for (const y of pending.positions) expect(Math.abs(y - before.y), "held before B commits").toBeLessThan(1);

    await page.evaluate(() => {
      const w = window as any;
      Worker.prototype.postMessage = w.__anchorPostMessage;
      for (const release of w.__anchorLayouts.splice(0)) release();
    });
    await page.waitForFunction(() => (window as any).trace.layoutsPending() === 0);
    // B's 75 newly revealed descendants prove this was the worker-sized scene.
    const leaf = await key(page, "anchor-b-leaf-74");
    await expect(page.locator(`[data-tile-key="${leaf}"]`)).toHaveCount(1);
    const positions = await page.evaluate(async (clicked) => {
      const tile = () => document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(clicked)}"]`)!;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await frame();
      const animations = ((window as any).__heldAnimations as Animation[]).filter((animation) => animation.playState === "running");
      const positions = [tile().getBoundingClientRect().top];
      for (let step = 0; step <= 10; step++) {
        for (const animation of animations) animation.currentTime = Number(animation.effect!.getTiming().duration) * step / 10;
        await frame();
        positions.push(tile().getBoundingClientRect().top);
      }
      for (const animation of animations) { animation.playbackRate = 1; animation.finish(); }
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
    await releaseScriptedAnimations(page);
  }
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});

test("continuous relayouts in another section keep the tile anchored and yield to user scrolling", async ({ page }) => {
  const { clicked, before } = await prepareCrossSectionAnchor(page, "anchor-b");
  await holdScriptedAnimations(page);
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
        for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 100;
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
    const scrolled = await scroller.evaluate(async (view) => {
      // mouse.wheel dispatches input before compositor scrolling is complete.
      let previous = view.scrollTop, stable = 0;
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const top = view.scrollTop;
        stable = Math.abs(top - previous) < 0.25 ? stable + 1 : 0;
        if (stable >= 4) return top;
        previous = top;
      }
      throw new Error("wheel scrolling did not finish");
    });
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
        for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 160 * step / 10;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        positions.push(view.scrollTop);
      }
      return positions;
    });
    for (const top of after) expect(top, "later relayouts do not fight the user's scroll").toBeCloseTo(scrolled, 0);
  } finally {
    await releaseScriptedAnimations(page);
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

  /**
   * Toggles a section with its animations held, then seeks them together
   * through `steps + 1` evenly spaced times, recording the following
   * section's displayed top at each, with the longest declared duration.
   * Seeking replaces sampling elapsed time, so machine load cannot change it.
   */
  const seekToggle = async (page: Page, index: number, steps = 10) => {
    await holdScriptedAnimations(page);
    const result = await page.evaluate(async ({ index, steps }) => {
      const held = (window as any).__heldAnimations as Animation[];
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[index];
      const next = section.nextElementSibling as HTMLElement;
      const before = next.getBoundingClientRect().top;
      section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
      // The slide is the transform animation on what follows.
      const slides = () => held.filter((animation) => (animation.effect as KeyframeEffect | null)?.target === next && (animation.effect as KeyframeEffect).getKeyframes().some((keyframe) => "transform" in keyframe));
      for (let i = 0; i < 2000 && slides().length === 0; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
      if (slides().length === 0) throw new Error("what follows the section was not animated");
      const duration = Math.max(...held.map((animation) => Number(animation.effect!.getTiming().duration)));
      const easings = slides().map((animation) => animation.effect!.getTiming().easing);
      const tops: number[] = [];
      for (let i = 0; i <= steps; i++) {
        for (const animation of held) animation.currentTime = (duration * i) / steps;
        tops.push(next.getBoundingClientRect().top);
      }
      return { before, duration, easings, tops };
    }, { index, steps });
    await releaseScriptedAnimations(page);
    return result;
  };

  const monotonic = (tops: number[]) => {
    const from = tops[0], to = tops.at(-1)!;
    return tops.every((top, i) => top >= Math.min(from, to) - 0.5 && top <= Math.max(from, to) + 0.5
      && (i === 0 || Math.abs(top - to) <= Math.abs(tops[i - 1] - to) + 0.5));
  };

  test("what follows a section slides straight to its new place within a fifth of a second or so", async ({ page }) => {
    await openView(page, 120);
    const sections = page.locator("section.component[data-component]");
    const forest = sections.nth(1);
    for (const expanded of ["false", "true", "false", "true"]) {
      const { before, duration, easings, tops } = await seekToggle(page, 1);
      await settle(page);
      await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", expanded);
      // A collapsed section's content is gone once it has been hidden.
      await expect(forest.locator(".content")).toHaveCount(expanded === "true" ? 1 : 0);
      const [from, to] = [tops[0], tops.at(-1)!];
      // It starts from where it was displayed, and ends at its new place.
      expect(from).toBeCloseTo(before, 0);
      expect(Math.abs(to - from), "the section's content height").toBeGreaterThan(40);
      expect(monotonic(tops), JSON.stringify(tops.map(Math.round))).toBe(true);
      // The declared duration is about 160 ms, and arrival is at the end of it.
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThanOrEqual(200);
      // It slides rather than jumping: some time on the way shows it in between.
      expect(tops.some((top) => Math.min(Math.abs(top - from), Math.abs(top - to)) > 1)).toBe(true);
      // Eased out (fast start): it is past the midpoint well before half-time.
      expect(easings.every((easing) => easing !== "linear" && easing !== "ease-in")).toBe(true);
      expect(Math.abs(tops[Math.floor(tops.length / 2)] - to)).toBeLessThan(Math.abs(to - from) / 2);
    }
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("toggling again mid-way reverses from where the section is displayed", async ({ page }) => {
    await openView(page, 120);
    const forest = page.locator("section.component[data-component]").nth(1);
    const result = await page.evaluate(async () => {
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1];
      const next = section.nextElementSibling as HTMLElement;
      const heading = () => section.querySelector<HTMLElement>("[data-stack-toggle]")!;
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const open = next.getBoundingClientRect().top;
      heading().click();
      let top = open;
      for (let i = 0; i < 30 && !(open - top > 15); i++) { await frame(); top = next.getBoundingClientRect().top; }
      const before = next.getBoundingClientRect().top;
      heading().click();
      const after = next.getBoundingClientRect().top;
      for (let i = 0; i < 40; i++) await frame();
      return { open, before, after, end: next.getBoundingClientRect().top };
    });
    expect(result.open - result.before).toBeGreaterThan(15);
    // No jump when reversing, and it ends fully open again.
    expect(Math.abs(result.after - result.before)).toBeLessThan(2);
    expect(Math.abs(result.end - result.open)).toBeLessThan(1);
    await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("collapsing again mid-way through opening reverses smoothly and ends with the content gone", async ({ page }) => {
    await openView(page, 120);
    const forest = page.locator("section.component[data-component]").nth(1);
    await forest.locator("[data-stack-toggle]").click();
    await settle(page);
    await expect(forest.locator(".content")).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1];
      const next = section.nextElementSibling as HTMLElement;
      const heading = () => section.querySelector<HTMLElement>("[data-stack-toggle]")!;
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const closed = next.getBoundingClientRect().top;
      heading().click();
      let top = closed;
      for (let i = 0; i < 30 && !(top - closed > 15); i++) { await frame(); top = next.getBoundingClientRect().top; }
      const before = next.getBoundingClientRect().top;
      heading().click();
      const after = next.getBoundingClientRect().top;
      const tops: number[] = [];
      for (let i = 0; i < 40; i++) { await frame(); tops.push(next.getBoundingClientRect().top); }
      return { closed, before, after, tops };
    });
    expect(result.before - result.closed).toBeGreaterThan(15);
    expect(Math.abs(result.after - result.before)).toBeLessThan(2);
    // Straight back up, without going past the closed position or bouncing.
    let previous = result.after;
    for (const top of result.tops) {
      expect(top).toBeLessThanOrEqual(previous + 0.5);
      expect(top).toBeGreaterThanOrEqual(result.closed - 0.5);
      previous = top;
    }
    expect(Math.abs(result.tops.at(-1)! - result.closed)).toBeLessThan(1);
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
      const watched = [section.previousElementSibling as HTMLElement, section, section.nextElementSibling as HTMLElement];
      const sample = () => watched.map((element) => element.getBoundingClientRect().top);
      const frames = [sample()];
      section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
      for (let i = 0; i < 40; i++) { await new Promise((resolve) => requestAnimationFrame(resolve)); frames.push(sample()); }
      return { frames, overflow: view.scrollHeight - view.clientHeight - view.scrollTop };
    });
    expect(frames.overflow).toBeLessThan(1);
    // Every watched element (the one before, the section, the one after) moves straight to where it ends.
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
    for (let i = 0; i < 2; i++) {
      const frames = await sampleToggle(page, 1, 120);
      expect(Math.abs(frames[1].top - frames.at(-1)!.top)).toBeLessThan(1);
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    }
  });
});

test.describe("anchoring under the host's zoom", () => {
  test.use({ viewport: { width: 1200, height: 700 } });

  test("at 130% zoom the clicked tile stays where it was on screen while its graph relayouts", async ({ page }) => {
    // Narrow enough that the village runs top to bottom (the view only scrolls, and anchors, vertically).
    await openView(page, 480, "?many=8&zoom=1.3");
    // Selecting merge after warm changes which of its relatives are shown, so merge moves within its graph.
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
    expect(Math.abs(after.inGraph - before.inGraph)).toBeGreaterThan(10);
    // Held at the same height on screen on every frame, not only once motion ends. (It may move
    // sideways within its graph: the view only scrolls vertically.)
    const shown = frames.filter((frame) => frame.tiles[key]);
    expect(shown.length).toBeGreaterThan(3);
    expect(Math.max(...shown.map((frame) => Math.abs(frame.tiles[key][3] - shown[0].tiles[key][3])))).toBeLessThanOrEqual(2);
    expect(Math.abs(after.screen - before.screen)).toBeLessThanOrEqual(2);
  });
});

test.describe("new tiles arrive from their parents' side", () => {
  test.use({ viewport: { width: 900, height: 900 } });

  test("inside a downward band a revealed tile emerges above its destination", async ({ page }) => {
    await openView(page, 900, "?deeper=1");
    const dawn = await key(page, "mist-dawn");
    const frames = await sampleClick(page, await node(page, "forest-mist"));
    const seen = frames.filter((frame) => frame.tiles[dawn]).map((frame) => frame.tiles[dawn]);
    expect(seen.length).toBeGreaterThan(2);
    const [first, last] = [seen[0], seen[seen.length - 1]];
    expect(last[1] - first[1]).toBeGreaterThan(3);
    for (const sample of seen) expect(Math.abs(sample[0] - last[0])).toBeLessThanOrEqual(1);
    await settle(page);
    expect(await uncaught(page)).toEqual([]);
  });
});
