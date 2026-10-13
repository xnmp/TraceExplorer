import type { Page } from "@playwright/test";

/**
 * Deterministic motion: instead of sampling elapsed wall-clock time (which a
 * starved machine stretches arbitrarily), hold every animation the view
 * starts at time zero and seek it by hand. Tests then assert on what is shown
 * at chosen animation times, and on the durations and easings declared.
 *
 * `Element.animate` is wrapped so each animation is frozen (playback rate 0)
 * as it is created, before any frame can advance it. It is frozen rather than
 * paused because the view treats only a *running* animation as in progress
 * (an interrupted fade continues from its displayed opacity). CSS transitions are not created that way;
 * hold those with `getAnimations()` (see the Preview transition spec).
 */
export async function holdScriptedAnimations(page: Page, delayApplication = false, durationScale = 1): Promise<void> {
  await page.evaluate(({ delayApplication, durationScale }) => {
    const w = window as any;
    if (w.__heldAnimations) return;
    const original = Element.prototype.animate;
    w.__originalAnimate = original;
    w.__heldAnimations = [] as Animation[];
    w.__delayedEffects = [];
    w.__delayApplication = delayApplication;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const [frames, options] = args;
      const timing = typeof options === "number" ? options * durationScale
        : { ...options, duration: Number(options?.duration ?? 0) * durationScale };
      const animation = durationScale === 1 ? original.apply(this, args) : original.call(this, frames, timing);
      animation.playbackRate = 0;
      w.__heldAnimations.push(animation);
      if (w.__delayApplication) {
        const effect = animation.effect as KeyframeEffect;
        const frames = effect.getKeyframes();
        const ready = animation.ready;
        // Preserve the public keyframes/target for interruption capture, but
        // prevent the engine applying the effect. This models a late compositor
        // submission while the committed DOM is already eligible for paint.
        effect.setKeyframes([]);
        effect.getKeyframes = () => frames;
        let apply!: () => void;
        const delayedReady = new Promise<Animation>(resolve => { apply = () => {
          effect.setKeyframes(frames);
          ready.then(() => resolve(animation), () => resolve(animation));
        }; });
        Object.defineProperty(animation, "ready", { get: () => delayedReady });
        w.__delayedEffects.push(apply);
      }
      return animation;
    };
  }, { delayApplication, durationScale });
}

/** Stops holding: animations created from now on run normally, and held ones resume from where they are seeked. */
export async function releaseScriptedAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (!w.__heldAnimations) return;
    w.__delayApplication = false;
    for (const apply of w.__delayedEffects ?? []) apply();
    w.__delayedEffects = [];
    Element.prototype.animate = w.__originalAnimate;
    for (const animation of w.__heldAnimations as Animation[]) if (animation.playState !== "idle") animation.playbackRate = 1;
    w.__heldAnimations = undefined;
  });
}

/**
 * Waits until the view has finished creating animations for what it just did. Layout, geometry reports
 * and grid motion run in later turns than the input that caused them, so a test that seeks "all running
 * animations" straight away misses the ones created after. Counted per animation frame, never by time.
 */
export async function awaitAnimationsCreated(page: Page, stableFrames = 4): Promise<void> {
  await page.evaluate(async (needed) => {
    const w = window as any, frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let count = -1, stable = 0;
    while (stable < needed) {
      await frame();
      const now = (w.__heldAnimations as Animation[]).length + (w.trace.layoutsPending() as number);
      stable = now === count ? stable + 1 : 0;
      count = now;
    }
  }, stableFrames);
}

/** Submit the held effects; leave their native clock held for deterministic seeking. */
export async function applyHeldAnimationEffects(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any;
    w.__delayApplication = false;
    for (const apply of w.__delayedEffects) apply();
    w.__delayedEffects = [];
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
