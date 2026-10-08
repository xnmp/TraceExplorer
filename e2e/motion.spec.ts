import { test, expect, type Page } from "@playwright/test";
import { key, openView, settle, uncaught } from "./support";
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

test.describe("sections expand and collapse quickly", () => {
  /** Toggles a section and records the following section's displayed top each frame. */
  const sampleToggle = (page: Page, index: number, ms = 500) => page.evaluate(async ({ index, ms }) => {
    const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[index];
    const next = section.nextElementSibling as HTMLElement;
    const frames: Array<{ t: number; top: number }> = [];
    const start = performance.now();
    frames.push({ t: 0, top: next.getBoundingClientRect().top });
    section.querySelector<HTMLElement>("button.heading")!.click();
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

  /** When the displayed top first comes within 1px of where it ends. */
  const arrival = (frames: Array<{ t: number; top: number }>) => {
    const end = frames.at(-1)!.top;
    return frames.find((frame) => Math.abs(frame.top - end) < 1)!.t;
  };
  const monotonic = (frames: Array<{ t: number; top: number }>) => {
    const from = frames[0].top, to = frames.at(-1)!.top;
    return frames.every((frame, i) => frame.top >= Math.min(from, to) - 0.5 && frame.top <= Math.max(from, to) + 0.5
      && (i === 0 || Math.abs(frame.top - to) <= Math.abs(frames[i - 1].top - to) + 0.5));
  };

  test("what follows a section slides straight to its new place within a fifth of a second or so", async ({ page }) => {
    await openView(page);
    const sections = page.locator("section.component[data-component]");
    const forest = sections.nth(1);
    for (const expanded of ["false", "true", "false", "true"]) {
      const frames = await sampleToggle(page, 1);
      await expect(forest.locator("button.heading")).toHaveAttribute("aria-expanded", expanded);
      // A collapsed section's content is gone once it has been hidden.
      await expect(forest.locator(".content")).toHaveCount(expanded === "true" ? 1 : 0);
      const travelled = Math.abs(frames.at(-1)!.top - frames[0].top);
      expect(travelled, "the section's content height").toBeGreaterThan(40);
      expect(monotonic(frames), JSON.stringify(frames.map((frame) => Math.round(frame.top)))).toBe(true);
      // About 160 ms; the bound leaves headroom for busy runners.
      expect(arrival(frames)).toBeLessThan(400);
      // It slides rather than jumping: some frame shows it on the way.
      const [from, to] = [frames[0].top, frames.at(-1)!.top];
      expect(frames.some((frame) => Math.min(Math.abs(frame.top - from), Math.abs(frame.top - to)) > 1)).toBe(true);
      await settle(page);
    }
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("toggling again mid-way reverses from where the section is displayed", async ({ page }) => {
    await openView(page);
    const forest = page.locator("section.component[data-component]").nth(1);
    const result = await page.evaluate(async () => {
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1];
      const next = section.nextElementSibling as HTMLElement;
      const heading = section.querySelector<HTMLElement>("button.heading")!;
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const open = next.getBoundingClientRect().top;
      heading.click();
      let top = open;
      for (let i = 0; i < 30 && !(open - top > 15); i++) { await frame(); top = next.getBoundingClientRect().top; }
      const before = next.getBoundingClientRect().top;
      heading.click();
      const after = next.getBoundingClientRect().top;
      for (let i = 0; i < 40; i++) await frame();
      return { open, before, after, end: next.getBoundingClientRect().top };
    });
    expect(result.open - result.before).toBeGreaterThan(15);
    // No jump when reversing, and it ends fully open again.
    expect(Math.abs(result.after - result.before)).toBeLessThan(2);
    expect(Math.abs(result.end - result.open)).toBeLessThan(1);
    await expect(forest.locator("button.heading")).toHaveAttribute("aria-expanded", "true");
    await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
    expect(await uncaught(page)).toEqual([]);
  });

  test("collapsing again mid-way through opening reverses smoothly and ends with the content gone", async ({ page }) => {
    await openView(page);
    const forest = page.locator("section.component[data-component]").nth(1);
    await forest.locator("button.heading").click();
    await settle(page);
    await expect(forest.locator(".content")).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[1];
      const next = section.nextElementSibling as HTMLElement;
      const heading = section.querySelector<HTMLElement>("button.heading")!;
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const closed = next.getBoundingClientRect().top;
      heading.click();
      let top = closed;
      for (let i = 0; i < 30 && !(top - closed > 15); i++) { await frame(); top = next.getBoundingClientRect().top; }
      const before = next.getBoundingClientRect().top;
      heading.click();
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
    await expect(forest.locator("button.heading")).toHaveAttribute("aria-expanded", "false");
    await expect(forest.locator(".content")).toHaveCount(0);
    expect(await uncaught(page)).toEqual([]);
  });

  test("collapsing a section at the bottom of a scrolled view slides into place without a jump at the end", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await openView(page, undefined, "?many=4");
    // Open the last section and scroll to the very bottom, so collapsing it shortens the view past the scroll position.
    const sections = page.locator("section.component[data-component]");
    const last = (await sections.count()) - 1;
    await sections.nth(last).locator("button.heading").click();
    await settle(page);
    await page.evaluate(() => { const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!; view.scrollTop = view.scrollHeight; });
    await settle(page);
    const frames = await page.evaluate(async (index) => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const section = document.querySelectorAll<HTMLElement>("section.component[data-component]")[index];
      const watched = [section.previousElementSibling as HTMLElement, section, section.nextElementSibling as HTMLElement];
      const sample = () => watched.map((element) => element.getBoundingClientRect().top);
      const frames = [sample()];
      section.querySelector<HTMLElement>("button.heading")!.click();
      for (let i = 0; i < 40; i++) { await new Promise((resolve) => requestAnimationFrame(resolve)); frames.push(sample()); }
      return { frames, overflow: view.scrollHeight - view.clientHeight - view.scrollTop };
    }, last);
    expect(frames.overflow).toBeLessThan(1);
    // Every watched element (the one before, the section, the one after) moves straight to where it ends.
    for (let element = 0; element < 3; element++) {
      const path = frames.frames.map((frame) => frame[element]);
      const end = path.at(-1)!;
      for (let i = 1; i < path.length; i++) expect(Math.abs(path[i] - end), `element ${element}: ${path.map(Math.round)}`).toBeLessThanOrEqual(Math.abs(path[i - 1] - end) + 0.5);
    }
    await expect(sections.nth(last).locator(".content")).toHaveCount(0);
  });

  test("a section opened because it holds the focus stays open when a tile elsewhere is chosen", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 1200 });
    await openView(page, undefined, "?gym=1");
    // The fourth section starts collapsed and opens when its image is selected from outside the graph.
    const sections = page.locator("section.component[data-component]");
    const fan = sections.nth(3);
    await expect(fan.locator("button.heading")).toHaveAttribute("aria-expanded", "false");
    await page.evaluate(() => (window as any).trace.selectPath((window as any).trace.backend.path("fan")));
    await expect(fan.locator("button.heading")).toHaveAttribute("aria-expanded", "true");
    await settle(page);
    const frames = await sampleClick(page, await node(page, "cerulean"));
    expect(motionFaults(frames)).toEqual([]);
    await expect(fan.locator("button.heading")).toHaveAttribute("aria-expanded", "true");
  });

  test("with reduced motion a section opens and closes at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openView(page);
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

  test("in a left-to-right component a revealed tile slides in from the left, level with where it lands", async ({ page }) => {
    await openView(page, 900, "?deeper=1");
    const dawn = await key(page, "mist-dawn");
    const frames = await sampleClick(page, await node(page, "forest-mist"));
    const seen = frames.filter((frame) => frame.tiles[dawn]).map((frame) => frame.tiles[dawn]);
    expect(seen.length).toBeGreaterThan(2);
    const [first, last] = [seen[0], seen[seen.length - 1]];
    expect(last[0] - first[0]).toBeGreaterThan(3);
    for (const sample of seen) expect(Math.abs(sample[1] - last[1])).toBeLessThanOrEqual(1);
    await settle(page);
    expect(await uncaught(page)).toEqual([]);
  });
});
