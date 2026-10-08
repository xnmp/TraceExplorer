import { expect, type Page } from "@playwright/test";
import { openView, key, settle, uncaught } from "./support";

/**
 * Per-frame motion sampling: what the user sees on every frame after an
 * input, not how it is animated.
 */

/**
 * Screen position (vertically in the view's content, and as shown), and the tile's laid-out place: its position and width in
 * its graph, and how far down the view's content the graph starts (sections
 * above it may grow). Nothing horizontal outside the graph belongs to it, so
 * the graph shifting sideways (a scrollbar appearing, say) is not a new place.
 */
export type Sample = [x: number, y: number, place: string, screenY: number];
export type Frame = { t: number; tiles: Record<string, Sample> };

export const node = async (page: Page, name: string) => `[data-node-key="${await key(page, name)}"]`;

/** Clicks `selector` and records every tile's position (screen, with the view's scrolling undone) on each frame for `ms`. */
export function sampleClick(page: Page, selector: string, ms = 600): Promise<Frame[]> {
  return page.evaluate(async ({ selector, ms }) => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    const zoom = view.getBoundingClientRect().width / view.offsetWidth;
    // Layout offsets: unaffected by zoom, scrolling and transforms.
    const down = (element: HTMLElement | null) => { let top = 0; for (let at = element; at; at = at.offsetParent as HTMLElement | null) top += at.offsetTop; return element ? top : null; };
    const sample = (t: number): Frame => ({
      t,
      tiles: Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => {
        const box = element.getBoundingClientRect();
        const graph = element.closest<HTMLElement>(".graph");
        const place = `${element.style.left} ${element.style.top} ${graph?.style.width} ${down(graph)}`;
        // Vertical positions are in the view's content, so the view scrolling (to hold the clicked tile) is not motion.
        return [element.dataset.tileKey!, [box.x, box.y + view.scrollTop * zoom, place, box.y] as Sample];
      })),
    });
    const start = performance.now();
    const frames = [sample(0)];
    document.querySelector<HTMLElement>(selector)!.click();
    // Sampled after each frame has rendered (every frame callback has run), so it is what was painted.
    const channel = new MessageChannel();
    await new Promise<void>((resolve) => {
      channel.port1.onmessage = () => {
        frames.push(sample(performance.now() - start));
        if (performance.now() - start < ms) requestAnimationFrame(() => channel.port2.postMessage(null)); else resolve();
      };
      requestAnimationFrame(() => channel.port2.postMessage(null));
    });
    channel.port1.close();
    return frames;
  }, { selector, ms });
}

/**
 * Tiles shown before and after: one whose laid-out place did not change never
 * moves on screen (not even 1px on any frame, nor at the end); one that moves
 * heads straight for its target, never leaving the span between start and end
 * nor turning back.
 */
export function motionFaults(frames: Frame[]): string[] {
  const first = frames[0].tiles, last = frames.at(-1)!.tiles;
  const faults: string[] = [];
  for (const k of Object.keys(last).filter((k) => k in first)) {
    for (const axis of [0, 1] as const) {
      const from = first[k][axis], to = last[k][axis];
      const kept = first[k][2] === last[k][2];
      let previous = from;
      for (const frame of frames) {
        const at = frame.tiles[k]?.[axis];
        if (at === undefined) continue;
        if (kept || Math.abs(to - from) < 0.5) {
          if (Math.abs(at - from) >= 1) faults.push(`${k} should stay put but is ${(at - from).toFixed(1)}px off at ${frame.t.toFixed(0)}ms`);
        } else if (at < Math.min(from, to) - 0.5 || at > Math.max(from, to) + 0.5) {
          faults.push(`${k} overshoots to ${at.toFixed(1)} (from ${from.toFixed(1)} to ${to.toFixed(1)}) at ${frame.t.toFixed(0)}ms`);
        } else if (Math.abs(at - to) > Math.abs(previous - to) + 0.5) {
          faults.push(`${k} turns back at ${frame.t.toFixed(0)}ms`);
        }
        previous = at;
      }
    }
  }
  return [...new Set(faults)];
}

/** No tile came, went or changed its laid-out place. */
export const unchanged = (frames: Frame[]) => {
  const first = frames[0].tiles, last = frames.at(-1)!.tiles;
  return Object.keys(first).length === Object.keys(last).length
    && Object.keys(last).every((k) => k in first && first[k][2] === last[k][2]);
};

/**
 * Clicks through the screenshot-shaped component (a root, two edits, two
 * edits under the second) and checks every frame of every click against
 * `motionFaults`. The view is first fitted to the content, so growing graphs
 * make it scroll mid-motion. Returns whether any click left the view
 * scrolling with a scrollbar that takes space.
 */
export async function clickThroughGym(page: Page, query: string, width = 720): Promise<{ scrolled: boolean }> {
  await openView(page, width, `?gym=1&scrollbars=host${query}`);
  await page.locator(await node(page, "gym")).click();
  await settle(page);
  const fit = await page.evaluate(() => {
    const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
    return Math.ceil((view.scrollHeight - view.clientHeight) * view.getBoundingClientRect().height / view.clientHeight) + 20;
  });
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: viewport.height + fit });
  await settle(page);

  const steps = ["cerulean", "saffron", "saffron-a", "saffron", "saffron", "cerulean", "village", "gym"];
  let still = 0, scrolled = false;
  for (const step of steps) {
    const frames = await sampleClick(page, await node(page, step));
    scrolled ||= await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      return view.scrollHeight > view.clientHeight && view.offsetWidth > view.clientWidth;
    });
    expect(frames.length, step).toBeGreaterThan(3);
    expect(motionFaults(frames), `clicking ${step}`).toEqual([]);
    if (unchanged(frames)) still++;
    await settle(page);
  }
  // The sequence includes clicks that leave every tile where it is.
  expect(still).toBeGreaterThan(0);
  expect(await uncaught(page)).toEqual([]);
  return { scrolled };
}
