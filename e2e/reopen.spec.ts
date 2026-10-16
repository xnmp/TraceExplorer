import { test, expect } from '@playwright/test';
import { openView, settle, key } from './support';
import { holdMotion, seekMotion, awaitMotionStarted, releaseMotion } from './animation-control';
import { checkRouteOcclusionFrames } from './helpers/route-occlusion';

checkRouteOcclusionFrames();

function frame() {
  (window as any).__checkOcclusion?.();
  const opacity = (element: Element) => {
    let alpha = 1;
    for (let e: Element | null = element; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
    return alpha;
  };
  return {
    routes: [...document.querySelectorAll<SVGPathElement>('path[data-route], path[data-motion-route]')]
      .map(p => ({ id: p.dataset.route ?? p.dataset.motionRoute!, alpha: opacity(p) })),
    tiles: [...document.querySelectorAll<HTMLElement>('[data-tile-key], [data-ghost-tile-key]')]
      .map(p => ({ id: p.dataset.tileKey ?? p.dataset.ghostTileKey!, alpha: opacity(p) })),
  };
}

test('reopening after a 1 ms close preserves every still-visible route throughout the reversal', async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 640, '?selectionBlink=1', false);
  const id = await key(page, 'stack'), child = await key(page, 'Cerulean');
  const toggle = () => page.locator(`[data-stack-key="${id}"] [data-stack-toggle]`).evaluate((e: HTMLElement) => e.click());
  await toggle(); await settle(page);
  const before = await page.evaluate(frame), route = `node:${id}>node:${child}`;
  expect(before.routes.some(r => r.id === route)).toBe(true);
  await holdMotion(page);
  try {
    await toggle(); await awaitMotionStarted(page); await seekMotion(page, 1);
    await toggle(); await awaitMotionStarted(page);
    const frames = [];
    for (const at of [0, 8, 16, 33, 66, 100, 159, 160]) {
      await seekMotion(page, at); frames.push({ at, ...await page.evaluate(frame) });
    }
    await info.attach('reopen frames', { body: JSON.stringify({ before, frames }), contentType: 'application/json' });
    for (const f of frames) {
      // Every connector still painted at reversal must retain a visible copy, not only the
      // originally reported Cerulean connector. The child remains fully opaque too.
      for (const r of before.routes) expect(Math.max(0, ...f.routes.filter(p => p.id === r.id).map(p => p.alpha)), `${r.id} at ${f.at}ms`).toBe(1);
      expect(Math.max(0, ...f.tiles.filter(t => t.id === child).map(t => t.alpha)), `child at ${f.at}ms`).toBe(1);
    }
  } finally { await releaseMotion(page); }
  await settle(page);
});
