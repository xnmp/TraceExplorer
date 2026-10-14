/**
 * The motion driver's own contract at frame rate, with no held clock (docs/scene-transactions.md,
 * "Motion driver (rAF)"): an interruption continues from exactly the pose the last frame painted,
 * and every frame of a motion shows each tile further along its way to its target, never back
 * toward where it started (WebKitGTK 2.54.1 snapped compositor animations back to their start pose
 * as they ended, WebKit bug 321993).
 *
 * Frames are read at the last moment before they paint: in a ResizeObserver callback that a frame
 * callback triggers (as `samplePaintedFrames` does), after every frame callback, the driver's included.
 */
import { test, expect, type Page } from "@playwright/test";
import { openView, settle, uncaught } from "./support";

type Shown = Record<string, [x: number, y: number]>;
interface Recorded { painted: { t: number; shown: Shown }[]; restarts: { reference: number; shown: Shown }[] }

/**
 * Starts recording, in the page: every painted frame's visible tiles and cells (screen position,
 * keyed), and, at each motion start, the pose its first frame will show (read synchronously right
 * after the driver wrote it) with the index of the last frame painted before its publication.
 */
const record = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
  const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
  const shown = (): Record<string, [number, number]> => {
    const frame = view.getBoundingClientRect();
    const elements = [...view.querySelectorAll<HTMLElement>("[data-tile-key], [data-grid-cell]")];
    const boxes = elements.map((element) => element.getBoundingClientRect());
    return Object.fromEntries(elements.flatMap((element, i) => {
      const box = boxes[i];
      if (box.bottom < frame.top || box.top > frame.bottom || opacity(element) <= .01) return [];
      return [[element.dataset.tileKey ? `tile:${element.dataset.tileKey}` : `cell:${element.dataset.gridCell}`, [box.x, box.y]]];
    }));
  };
  const painted: { t: number; shown: Shown }[] = [], restarts: { reference: number; shown: Shown }[] = [];
  w.__recorded = { painted, restarts } satisfies Recorded;
  let published = 0;
  const hooks = w.trace.scene.hooks, publication = hooks.geometryPublication, start = hooks.motionStart;
  hooks.geometryPublication = (event: unknown) => { published = painted.length; publication(event); };
  hooks.motionStart = (event: unknown) => { restarts.push({ reference: published - 1, shown: shown() }); start(event); };
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
  document.body.append(probe);
  let frame = 0, sampled = -1;
  const observer = new ResizeObserver(() => {
    if (sampled === frame) return;
    sampled = frame;
    painted.push({ t: performance.now(), shown: shown() });
  });
  observer.observe(probe);
  const next = () => {
    if (w.__stopRecording) { observer.disconnect(); probe.remove(); hooks.geometryPublication = publication; hooks.motionStart = start; return; }
    frame++;
    probe.style.width = `${1 + (frame % 2)}px`;
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
});

const recorded = async (page: Page): Promise<Recorded> => {
  await page.evaluate(() => { (window as any).__stopRecording = true; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => (window as any).__recorded as Recorded);
};

/** Clicks `selector` in a task of its own once `frames` frames have painted since the last motion started (or now). */
const clickAfter = (page: Page, selector: string, frames: number) => page.evaluate(async ({ selector, frames }) => {
  const w = window as any, recording = w.__recorded as Recorded;
  const from = recording.painted.length;
  await new Promise<void>((resolve) => { const check = () => recording.painted.length - from >= frames ? resolve() : requestAnimationFrame(check); check(); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.querySelector<HTMLElement>(selector)!.click();
}, { selector, frames });

const toggle = (name: string) => `section[aria-label="stack-${name}"] [data-stack-toggle]`;

test("an interruption restarts from the pose the last frame painted", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 420, "?bandMotion=1", false);
  await record(page);
  // Open, then close and reopen a few frames into each motion, while it moves fastest.
  await clickAfter(page, toggle("b"), 2);
  await clickAfter(page, toggle("b"), 3);
  await clickAfter(page, toggle("b"), 3);
  await clickAfter(page, toggle("a"), 2);
  await settle(page);
  const { painted, restarts } = await recorded(page);
  expect(restarts.length, "motions started").toBeGreaterThanOrEqual(4);
  let compared = 0, moving = 0;
  for (const [index, { reference, shown }] of restarts.entries()) {
    expect(reference, `restart ${index} follows a painted frame`).toBeGreaterThanOrEqual(0);
    const last = painted[reference].shown;
    if (index > 0 && Object.keys(last).some((k) => painted[0].shown[k] && Math.abs(last[k][1] - painted[0].shown[k][1]) > 2)) moving++;
    // The first frame painted after the motion started shows its first pose.
    const next = painted[reference + 1]?.shown ?? {};
    for (const [k, [x, y]] of Object.entries(shown)) {
      if (next[k]) {
        expect(Math.abs(next[k][0] - x), `restart ${index}: ${k} x in its first frame (${x} → ${next[k][0]})`).toBeLessThanOrEqual(.5);
        expect(Math.abs(next[k][1] - y), `restart ${index}: ${k} y in its first frame (${y} → ${next[k][1]})`).toBeLessThanOrEqual(.5);
      }
      if (!last[k]) continue;
      expect(Math.abs(x - last[k][0]), `restart ${index}: ${k} x (${last[k][0]} → ${x})`).toBeLessThanOrEqual(.5);
      expect(Math.abs(y - last[k][1]), `restart ${index}: ${k} y (${last[k][1]} → ${y})`).toBeLessThanOrEqual(.5);
      compared++;
    }
  }
  expect(moving, "interruptions while something moved").toBeGreaterThan(0);
  expect(compared).toBeGreaterThan(10);
  expect(await uncaught(page)).toEqual([]);
});

/**
 * Elements shown in the first and last frame: each frame shows one between where it started and
 * where it ends, never further from its end than the frame before (within half a pixel); one that
 * keeps its place never moves.
 */
function straightFaults(painted: { shown: Shown }[]): string[] {
  const first = painted[0].shown, last = painted.at(-1)!.shown, faults: string[] = [];
  for (const k of Object.keys(last).filter((k) => k in first)) for (const axis of [0, 1] as const) {
    const from = first[k][axis], to = last[k][axis];
    let previous = from;
    for (const [index, { shown }] of painted.entries()) {
      const at = shown[k]?.[axis];
      if (at === undefined) continue;
      if (Math.abs(to - from) < .5) { if (Math.abs(at - from) >= 1) faults.push(`${k} moves ${(at - from).toFixed(1)}px on axis ${axis} at frame ${index}`); }
      else if (at < Math.min(from, to) - .5 || at > Math.max(from, to) + .5) faults.push(`${k} leaves its path on axis ${axis} (${from.toFixed(1)} → ${to.toFixed(1)}: ${at.toFixed(1)}) at frame ${index}`);
      else if (Math.abs(at - to) > Math.abs(previous - to) + .5) faults.push(`${k} turns back toward its start on axis ${axis} (${previous.toFixed(1)} → ${at.toFixed(1)}, ending ${to.toFixed(1)}) at frame ${index}`);
      previous = at;
    }
  }
  return [...new Set(faults)];
}

for (const action of ["opening", "closing"] as const) test(`${action} a stack moves every tile straight to its target on every painted frame`, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 420, "?bandMotion=1", false);
  if (action === "closing") { await page.locator(toggle("b")).click(); await settle(page); }
  await record(page);
  await clickAfter(page, toggle("b"), 2);
  await settle(page);
  // A few more frames after it settles: nothing may jump back once the motion has ended.
  await page.evaluate(() => new Promise((resolve) => { let n = 0; const step = () => ++n >= 6 ? resolve(null) : requestAnimationFrame(step); requestAnimationFrame(step); }));
  const { painted, restarts } = await recorded(page);
  expect(restarts, "one motion").toHaveLength(1);
  const first = painted[0].shown, last = painted.at(-1)!.shown;
  const travelled = Object.keys(last).filter((k) => k in first && Math.abs(last[k][1] - first[k][1]) > 20);
  expect(travelled.length, "tiles that travelled").toBeGreaterThan(0);
  // Painted in between: the motion was shown, not snapped.
  const between = painted.filter(({ shown }) => travelled.some((k) => shown[k] && Math.abs(shown[k][1] - first[k][1]) > 2 && Math.abs(shown[k][1] - last[k][1]) > 2));
  expect(between.length, "frames painted mid-motion").toBeGreaterThan(0);
  expect(straightFaults(painted)).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});
