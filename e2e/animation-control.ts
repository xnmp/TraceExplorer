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
export async function holdScriptedAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__heldAnimations) return;
    const original = Element.prototype.animate;
    w.__originalAnimate = original;
    w.__heldAnimations = [] as Animation[];
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = original.apply(this, args);
      animation.playbackRate = 0;
      w.__heldAnimations.push(animation);
      return animation;
    };
  });
}

/** Stops holding: animations created from now on run normally, and held ones resume from where they are seeked. */
export async function releaseScriptedAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (!w.__heldAnimations) return;
    Element.prototype.animate = w.__originalAnimate;
    for (const animation of w.__heldAnimations as Animation[]) if (animation.playState !== "idle") animation.playbackRate = 1;
    w.__heldAnimations = undefined;
  });
}
