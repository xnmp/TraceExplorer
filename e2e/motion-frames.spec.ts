/**
 * Painted frames around camera motion and its interruption, at frame rate with no held clock
 * (docs/scene-transactions.md, "Motion driver (rAF)", review fixes b7673b1 H1). Scrolled to the
 * bottom, closing a stack clamps scrolling: the camera eases while the held anchor compensates
 * scrolling. Every frame must write its poses first and scroll after, in the same frame callback;
 * a scroll that lags the camera by a frame makes the grid turn back (it did after a restart
 * re-queued the driver's frame behind the anchor's).
 *
 * Frames are read at the last moment before they paint: in a ResizeObserver callback that a frame
 * callback triggers, after every frame callback.
 */
import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught } from "./support";
import { awaitMotionStarted, holdMotion, releaseMotion, seekMotion } from "./animation-control";

type Item = [x: number, y: number, opacity: number, height?: number];
interface Frame { running: number; items: Record<string, Item>; grid: [number, number] }

/** Starts recording every painted frame: visible tiles, cells, retirees and connectors (screen position, effective opacity), and the grid's origin. */
const record = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
  const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
  /** The part of a retiring tile its exit group's clip shows (a closing band slides up under its cover). */
  const unclipped = (element: Element, box: DOMRect) => {
    const exit = element.closest<HTMLElement>("[data-grid-exit]"), polygon = exit && /^polygon\(([^)]*)\)/.exec(getComputedStyle(exit).clipPath);
    if (!exit || !polygon || !(box.height > 0)) return 1;
    const ys = polygon[1].split(",").map((point) => parseFloat(point.trim().split(/\s+/)[1])), origin = exit.getBoundingClientRect().top;
    return Math.max(0, Math.min(box.bottom, origin + Math.max(...ys)) - Math.max(box.top, origin + Math.min(...ys))) / box.height;
  };
  const shown = () => {
    const frame = view.getBoundingClientRect();
    const items: Record<string, [number, number, number, number]> = {};
    const counts = new Map<string, number>();
    for (const element of view.querySelectorAll<HTMLElement | SVGElement>("[data-tile-key], [data-grid-cell], [data-ghost-tile-key], path[data-route], path[data-motion-route]")) {
      const box = element.getBoundingClientRect();
      if (box.bottom < frame.top || box.top > frame.bottom) continue;
      const d = (element as HTMLElement).dataset;
      const base = d.tileKey ? `tile:${d.tileKey}` : d.ghostTileKey ? `ghost:${d.ghostTileKey}` : d.gridCell ? `cell:${d.gridCell}` : `route:${d.route ?? d.motionRoute}`;
      const n = counts.get(base) ?? 0; counts.set(base, n + 1);
      const key = base.startsWith("route:") ? base : n ? `${base}#${n}` : base;
      // A retiring tile: how much of it shows, its opacity and the part its clip shows.
      const o = opacity(element) * (d.ghostTileKey ? unclipped(element, box) : 1);
      // A connector: its most opaque instance (the live path, or its motion copy).
      if (items[key] && key.startsWith("route:")) { if (o > items[key][2]) items[key] = [box.x, box.y, o, box.height]; continue; }
      items[key] = [box.x, box.y, o, box.height];
    }
    const grid = view.querySelector<HTMLElement>('[role="grid"]')!.getBoundingClientRect();
    return { items, grid: [grid.x, grid.y] as [number, number] };
  };
  const painted: unknown[] = [], starts: number[] = [];
  w.__frames = { painted, starts };
  const hooks = w.trace.scene.hooks, start = hooks.motionStart;
  hooks.motionStart = (event: unknown) => { starts.push(painted.length); start(event); };
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
  document.body.append(probe);
  let frame = 0, sampled = -1;
  const observer = new ResizeObserver(() => {
    if (sampled === frame) return;
    sampled = frame;
    painted.push({ running: w.trace.motion.state().running.length, ...shown() });
  });
  observer.observe(probe);
  const next = () => {
    if (w.__stopFrames) { observer.disconnect(); probe.remove(); hooks.motionStart = start; return; }
    frame++;
    probe.style.width = `${1 + (frame % 2)}px`;
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
});
const recorded = async (page: Page): Promise<{ painted: Frame[]; starts: number[] }> => {
  await page.evaluate(() => new Promise((resolve) => { let n = 0; const step = () => ++n >= 8 ? resolve(null) : requestAnimationFrame(step); requestAnimationFrame(step); }));
  await page.evaluate(() => { (window as any).__stopFrames = true; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => (window as any).__frames);
};
/** Clicks `selector` in a task of its own once `frames` more frames have painted. */
const clickAfter = (page: Page, selector: string, frames: number) => page.evaluate(async ({ selector, frames }) => {
  const painted = (window as any).__frames.painted as unknown[];
  const from = painted.length;
  await new Promise<void>((resolve) => { const check = () => painted.length - from >= frames ? resolve() : requestAnimationFrame(check); check(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelector<HTMLElement>(selector)!.click();
}, { selector, frames });
const toggle = (name: string) => `section[aria-label="stack-${name}"] [data-stack-toggle]`;

/**
 * Position tolerance: the held anchor compensates the camera in whole scroll pixels (WebKit's
 * scroll offsets are integers, and the anchor holds within 1 px), so a frame may sit up to a pixel
 * off a fractional camera's path. A scroll that lags the camera by a frame is off by several.
 */
const PX = 1;

/**
 * What a run of painted frames does wrong: a position (per axis) that leaves the span between its
 * first and last value or turns back from its last value; an opacity that turns back; a retiree
 * that disappears while visible (unless its record takes over where it is: a reopening); a
 * connector shown at both ends on one path that dips below .4 (a rerouted connector crossfades
 * between its exact old and new paths: a path is never interpolated).
 */
function faults(painted: Frame[], from = 0, to = painted.length): string[] {
  const frames = painted.slice(from, to), out: string[] = [];
  const series = (values: { i: number; v: Item }[], name: string) => {
    if (values.length < 2) return;
    const first = values[0].v, last = values.at(-1)!.v;
    if (!name.startsWith("route:")) for (const axis of [0, 1]) {
      const a = first[axis], b = last[axis];
      let previous = a;
      for (const { i, v } of values) {
        const at = v[axis];
        if (Math.abs(b - a) < PX) { if (Math.abs(at - a) > PX) out.push(`${name} moves ${(at - a).toFixed(1)} on ${axis} at ${i}`); }
        else if (at < Math.min(a, b) - PX || at > Math.max(a, b) + PX) out.push(`${name} leaves ${a.toFixed(1)}→${b.toFixed(1)} (${at.toFixed(1)}) on ${axis} at ${i}`);
        else if (Math.abs(at - b) > Math.abs(previous - b) + PX) out.push(`${name} turns back ${previous.toFixed(1)}→${at.toFixed(1)} (end ${b.toFixed(1)}) on ${axis} at ${i}`);
        previous = at;
      }
    }
    let previous = first[2];
    for (const { i, v } of values) {
      if (name.startsWith("route:")) {
        const rerouted = Math.abs((first[3] ?? 0) - (last[3] ?? 0)) > PX;
        if (!rerouted && first[2] > .9 && last[2] > .9 && v[2] < .4) out.push(`${name} dips to ${v[2].toFixed(2)} at ${i}`);
        continue;
      }
      if (Math.abs(v[2] - last[2]) > Math.abs(previous - last[2]) + .02) out.push(`${name} opacity turns back ${previous.toFixed(2)}→${v[2].toFixed(2)} at ${i}`);
      previous = v[2];
    }
    // A retiree may hand over to its record coming back (a reopening takes over its displayed pose).
    const after = painted[values.at(-1)!.i + 1]?.items[name.replace(/^ghost:/, "tile:")];
    const takenOver = !!after && Math.abs(after[0] - last[0]) <= PX && Math.abs(after[1] - last[1]) <= PX;
    if (name.startsWith("ghost:") && values.at(-1)!.i < to - 1 && last[2] > .02 && !takenOver) out.push(`${name} pops out at opacity ${last[2].toFixed(2)} after ${values.at(-1)!.i}`);
  };
  for (const name of new Set(frames.flatMap((f) => Object.keys(f.items)))) series(frames.flatMap((f, k) => f.items[name] ? [{ i: from + k, v: f.items[name] }] : []), name);
  series(frames.map((f, k) => ({ i: from + k, v: [f.grid[0], f.grid[1], 1] as Item })), "grid");
  return [...new Set(out)];
}
/** Faults of each motion on its own: from the last frame painted before it started to the last before the next one. */
const motionFaults = ({ painted, starts }: { painted: Frame[]; starts: number[] }) =>
  starts.flatMap((s, i) => faults(painted, Math.max(0, s - 1), starts[i + 1] ?? painted.length).map((f) => `motion ${i}: ${f}`));

async function scrolledToBottom(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 420 });
  await openView(page, 420, "?bandMotion=1", false);
  await page.locator(toggle("b")).click(); await settle(page);
  await page.locator(toggle("a")).click(); await settle(page);
  await page.getByTestId("trace-view").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await settle(page);
}

test("closing a stack that clamps scrolling: the camera eases, and grid and tiles move straight on every painted frame", async ({ page }) => {
  await scrolledToBottom(page);
  await record(page);
  await clickAfter(page, toggle("a"), 2);
  await settle(page);
  const frames = await recorded(page);
  expect(frames.starts.length, "motion started").toBeGreaterThan(0);
  expect(new Set(frames.painted.map((f) => Math.round(f.grid[1]))).size, "the grid moved").toBeGreaterThan(2);
  expect(faults(frames.painted)).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});

for (const [name, steps] of [
  ["closing, reopening 3 frames later, then opening another 3 frames later", [["a", 3], ["a", 3], ["b", 3]]],
  ["closing, then reopening 3 frames later", [["a", 1], ["a", 3]]],
] as const) test(`an interrupted camera never turns back: ${name}`, async ({ page }) => {
  await scrolledToBottom(page);
  await record(page);
  for (const [stack, frames] of steps) await clickAfter(page, toggle(stack), frames);
  await settle(page);
  const frames = await recorded(page);
  expect(frames.starts.length, "every click restarted motion").toBeGreaterThanOrEqual(2);
  expect(motionFaults(frames), JSON.stringify(frames.painted.map((f) => Math.round(f.grid[1] * 10) / 10))).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});

/**
 * What of a closing band is shown: each retiring tile's painted height (its box within its exit
 * group's clip, 0 once faded out) and the tile's full height. Self-contained: it runs in the page.
 */
const closingBand = () => {
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
  const frame = view.getBoundingClientRect();
  const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
  return [...view.querySelectorAll<HTMLElement>("[data-grid-exit] [data-ghost-tile-key]")].map((tile) => {
    const box = tile.getBoundingClientRect();
    let top = Math.max(box.top, frame.top), bottom = Math.min(box.bottom, frame.bottom);
    const exit = tile.closest<HTMLElement>("[data-grid-exit]")!, polygon = /^polygon\(([^)]*)\)/.exec(getComputedStyle(exit).clipPath);
    if (polygon) {
      const ys = polygon[1].split(",").map((point) => parseFloat(point.trim().split(/\s+/)[1]));
      const origin = exit.getBoundingClientRect().top;
      top = Math.max(top, origin + Math.min(...ys)); bottom = Math.min(bottom, origin + Math.max(...ys));
    }
    return { key: tile.dataset.ghostTileKey!, shown: opacity(tile) > .01 ? Math.max(0, bottom - top) : 0, height: box.height };
  });
};

for (const pace of ["seeked", "painted"] as const) test(`closing a stack scrolled to the bottom collapses its band visibly, not at once (${pace})`, async ({ page }, info) => {
  await scrolledToBottom(page);
  const visible = await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>("[data-grid-band] [data-tile-key]")]
      .filter((tile) => { const box = tile.getBoundingClientRect(); return box.bottom > view.top && box.top < view.bottom; }).length;
  });
  expect(visible, "band tiles on screen before closing").toBeGreaterThan(0);
  type Shown = ReturnType<typeof closingBand>;
  const frames: Shown[] = [];
  if (pace === "seeked") {
    // The held clock: what each epoch time paints, exactly.
    await holdMotion(page);
    try {
      await page.locator(toggle("a")).click();
      await awaitMotionStarted(page);
      for (const at of [0, 8, 16, 33, 50, 66, 100, 160]) {
        await seekMotion(page, at);
        frames.push(await page.evaluate(closingBand));
      }
    } finally { await releaseMotion(page); }
  } else {
    // At frame rate: every painted frame from the click on.
    await page.evaluate((source) => {
      const w = window as any, read = new Function(`return (${source})`)() as () => unknown;
      w.__band = []; w.__bandDone = false;
      const step = () => { w.__band.push(read()); if (w.__band.length < 40) requestAnimationFrame(step); else w.__bandDone = true; };
      requestAnimationFrame(step);
    }, closingBand.toString());
    await page.locator(toggle("a")).click();
    await page.waitForFunction(() => (window as any).__bandDone === true, undefined, { polling: "raf" });
    frames.push(...await page.evaluate(() => (window as any).__band as Shown[]));
  }
  await settle(page);
  await info.attach("closing band", { body: JSON.stringify(frames), contentType: "application/json" });
  const total = (shown: Shown) => shown.reduce((sum, tile) => sum + tile.shown, 0);
  const partly = (shown: Shown) => shown.some((tile) => tile.shown > .5 && tile.shown < tile.height - .5);
  const collapsing = frames.filter((shown) => total(shown) > .5);
  if (pace === "seeked") {
    expect(total(frames[0]), "the first frame shows the band whole").toBeGreaterThan(0);
    expect(partly(frames[0]), "nothing is cut on the first frame").toBe(false);
    // Its tiles partly collapsed from 16 to 66 ms (connectors above them go first), the shown part
    // shrinking; gone at the end.
    const times = [0, 8, 16, 33, 50, 66, 100, 160];
    for (const at of [16, 33, 50, 66]) {
      const index = times.indexOf(at);
      expect(partly(frames[index]), `${at} ms: a tile partly collapsed`).toBe(true);
      expect(total(frames[index]), `${at} ms: less shown than before`).toBeLessThan(total(frames[index - 1]));
    }
    expect(total(frames.at(-1)!), "nothing left at the end").toBe(0);
  } else {
    // The first painted frames of the motion show the band collapsing (it used to vanish ~2 ms in).
    expect(collapsing.length, "painted frames showing the closing band").toBeGreaterThanOrEqual(2);
    expect(collapsing.filter(partly).length, "painted frames showing a tile partly collapsed").toBeGreaterThanOrEqual(1);
  }
  for (let i = 1; i < collapsing.length; i++) expect(total(collapsing[i]), `frame ${i}: the shown part only shrinks`).toBeLessThanOrEqual(total(collapsing[i - 1]) + .5);
  await expect(page.locator("[data-grid-exit]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});
