import { expect, type Page } from "@playwright/test";

export type SceneEventKind = "action-begin" | "geometry-publication" | "motion-start" | "failure" | "settled";
export interface SceneEventRecord {
  kind: SceneEventKind; transaction: number; scope: string; geometryVersion: number; requestKeys: string[]; message?: string; time: number;
}

/** Recorded scene events, oldest first, optionally only of the given kinds. */
export async function sceneEvents(page: Page, ...kinds: SceneEventKind[]): Promise<SceneEventRecord[]> {
  const all = await page.evaluate(() => (window as any).trace.scene.events() as SceneEventRecord[]);
  return kinds.length ? all.filter((event) => kinds.includes(event.kind)) : all;
}

export const clearSceneEvents = (page: Page): Promise<void> => page.evaluate(() => (window as any).trace.scene.clear());

/** What a transaction published: grouped by transaction id. */
export function byTransaction(events: SceneEventRecord[]): Map<number, SceneEventRecord[]> {
  const grouped = new Map<number, SceneEventRecord[]>();
  for (const event of events) grouped.set(event.transaction, [...(grouped.get(event.transaction) ?? []), event]);
  return grouped;
}

/**
 * The per-action contract: a geometry-changing action publishes geometry exactly
 * once and starts motion at most once; a restyle / no-op action (`geometry: false`) publishes none.
 */
export function expectActionContract(events: SceneEventRecord[], transaction: number, { geometry = true }: { geometry?: boolean } = {}): void {
  const own = events.filter((event) => event.transaction === transaction);
  const count = (kind: SceneEventKind) => own.filter((event) => event.kind === kind).length;
  expect(count("geometry-publication"), `geometry publications of transaction ${transaction}`).toBe(geometry ? 1 : 0);
  expect(count("motion-start"), `motion starts of transaction ${transaction}`).toBeLessThanOrEqual(geometry ? 1 : 0);
}

/**
 * Runs `sample` once per presented frame for `duration` ms and returns the
 * results, following selection-blink.spec.ts: the sample runs after all
 * animation-frame callbacks (a message posted from a frame callback), so it
 * sees what that frame would paint. `sample` is serialised into the page and
 * must be self-contained. `during` runs in the test after sampling starts.
 */
export async function sampleFrames<T>(page: Page, sample: () => T, duration: number, during?: () => Promise<void>): Promise<T[]> {
  await page.evaluate(({ source, duration }) => {
    const w = window as any, read = new Function(`return (${source})`)() as () => unknown;
    w.__frames = []; w.__framesDone = false;
    const start = performance.now(), channel = new MessageChannel();
    channel.port1.onmessage = () => {
      w.__frames.push(read());
      if (performance.now() - start < duration) requestAnimationFrame(() => channel.port2.postMessage(null));
      else { channel.port1.close(); channel.port2.close(); w.__framesDone = true; }
    };
    requestAnimationFrame(() => channel.port2.postMessage(null));
  }, { source: sample.toString(), duration });
  await during?.();
  await page.waitForFunction(() => (window as any).__framesDone === true, undefined, { polling: "raf" });
  return page.evaluate(() => (window as any).__frames as unknown[]) as Promise<T[]>;
}

/**
 * Like `sampleFrames`, but each sample runs at the last moment before its frame paints: in a
 * ResizeObserver callback, fired every frame by a probe that a frame callback resizes. The
 * page's own observers (the view's measured width) were created before it, so they and the
 * microtasks they started have run by then; the sample sees what that frame paints, never a state
 * between two tasks that no frame shows. Use it when the test drives changes (a width) that the
 * page reacts to in its own ResizeObserver.
 */
export async function samplePaintedFrames<T>(page: Page, sample: () => T, duration: number, during?: () => Promise<void>): Promise<T[]> {
  await page.evaluate(({ source, duration }) => {
    const w = window as any, read = new Function(`return (${source})`)() as () => unknown;
    w.__frames = []; w.__framesDone = false;
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
    document.body.append(probe);
    let frame = 0, sampled = -1;
    const start = performance.now();
    const observer = new ResizeObserver(() => {
      if (sampled === frame) return;
      sampled = frame;
      w.__frames.push(read());
    });
    observer.observe(probe);
    const next = () => {
      if (performance.now() - start >= duration) { observer.disconnect(); probe.remove(); w.__framesDone = true; return; }
      frame++;
      probe.style.width = `${1 + (frame % 2)}px`;
      requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }, { source: sample.toString(), duration });
  await during?.();
  await page.waitForFunction(() => (window as any).__framesDone === true, undefined, { polling: "raf" });
  return page.evaluate(() => (window as any).__frames as unknown[]) as Promise<T[]>;
}
