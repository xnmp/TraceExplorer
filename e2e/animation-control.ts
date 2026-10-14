import type { Page } from "@playwright/test";

/**
 * Deterministic motion through the Trace motion driver's test hooks (`sceneMotionTesting` in
 * `scene-motion.ts`, exposed by the view harness as `trace.motion`). The driver shows every
 * epoch from one main-thread frame loop; instead of sampling elapsed wall-clock time (which a
 * starved machine stretches arbitrarily), tests hold its clock, so each epoch starts at its first
 * pose and stays there, and seek it by hand. Tests then assert on what is shown at chosen epoch
 * times. A held epoch is still running: it never completes until released (or finished).
 *
 * In the page: `trace.motion.hold()`, `.seek(ms)` (synchronous: the next read shows it),
 * `.release()`, `.finish()`, `.setRate(r)` and `.state()` →
 * `{ running: [{ epoch, at, duration, held }], started }`. CSS transitions are not scene motion;
 * hold those with `getAnimations()` (see the Preview transition spec).
 */
export async function holdMotion(page: Page, { rate = 1 }: { rate?: number } = {}): Promise<void> {
  await page.evaluate((rate) => {
    const motion = (window as any).trace.motion;
    motion.setRate(rate);
    motion.hold();
  }, rate);
}

/** Stops holding: held epochs run on from where they are seeked, later ones run normally, at the normal rate. */
export async function releaseMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const motion = (window as any).trace?.motion;
    if (!motion) return;
    motion.release();
    motion.setRate(1);
  });
}

/** Shows epoch time `at` in every held epoch, then waits two frames so it is painted. */
export async function seekMotion(page: Page, at: number): Promise<void> {
  await page.evaluate(async (at) => {
    (window as any).trace.motion.seek(at);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, at);
}

/** The driver's running epochs, and how many epochs have started motion in this page. */
export const motionState = (page: Page): Promise<{ running: { epoch: number; at: number; duration: number; held: boolean }[]; started: number }> =>
  page.evaluate(() => (window as any).trace.motion.state());

/**
 * Waits until the view has finished starting motion for what it just did. Layout, geometry reports
 * and grid motion run in later turns than the input that caused them, so a test that seeks "the
 * running epoch" straight away misses one started after. Counted per animation frame, never by time.
 */
export async function awaitMotionStarted(page: Page, stableFrames = 4): Promise<void> {
  await page.evaluate(async (needed) => {
    const w = window as any, frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let count = -1, stable = 0;
    while (stable < needed) {
      await frame();
      const now = (w.trace.motion.state().started as number) + (w.trace.layoutsPending() as number);
      stable = now === count ? stable + 1 : 0;
      count = now;
    }
  }, stableFrames);
}
