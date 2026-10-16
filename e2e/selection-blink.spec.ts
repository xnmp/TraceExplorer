import { checkRouteOcclusionFrames } from "./helpers/route-occlusion";
import { test, expect } from '@playwright/test';
import { card, key, openView, rendered, settle, uncaught } from './support';
import { holdMotion, awaitMotionStarted, releaseMotion, motionState } from './animation-control';

checkRouteOcclusionFrames();

/**
 * Sample after all frame callbacks, beginning with the click's first presented frame. With both
 * branches open, selection only restyles (explicit expansion): no tile or connector moves, appears
 * or retires on any frame, and the selection styling changes in one frame, with no transition.
 * (Before, a selection revealed its own neighborhood and hid the other branch.)
 */
test('alternating selection between open branches moves nothing and draws no retiring copy', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await openView(page, 454, '?selectionBlink=1&scrollbars=host', false);
  await page.locator('[data-stack-toggle]').click();
  await settle(page);
  // First clicks open each branch.
  for (const name of ['Saffron', 'Cerulean']) { await (await card(page, name)).click(); await settle(page); }
  const orientation = await page.locator('[data-grid-band] .graph').getAttribute('data-orientation');
  expect(orientation).toMatch(/^(right|down)$/);
  const names = ['stack', 'Cerulean', 'Saffron', "Pikachu's Ball", 'Blastoise', 'Ash'];
  const keys = Object.fromEntries(await Promise.all(names.map(async name => [name, await key(page, name)])));
  const edges = [['stack', 'Cerulean'], ['stack', 'Saffron'], ['Cerulean', "Pikachu's Ball"], ['Saffron', 'Blastoise'], ['Saffron', 'Ash']];
  for (const name of ['Saffron', 'Cerulean', 'Saffron', 'Cerulean']) {
    await page.evaluate(({ keys, edges, name }) => {
      const w = window as any;
      const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
      const sample = () => { w.__checkOcclusion?.(); return ({
        tiles: Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, box(document.querySelector(`[data-tile-key="${k}"]`))])),
        connectors: Object.fromEntries(edges.map(([from, to]) => [`${from}>${to}`, [...document.querySelectorAll(`path[data-from="node:${keys[from]}"][data-to="node:${keys[to]}"], path[data-motion-from="node:${keys[from]}"][data-motion-to="node:${keys[to]}"]`)].map(box)])),
        ghosts: document.querySelectorAll('[data-motion-ghost], [data-ghost-tile-key]').length,
        running: w.trace.motion.state().running.length,
        styling: document.querySelector(`[data-node-key="${keys[name]}"]`)!.getAnimations({ subtree: true }).some(a => 'transitionProperty' in a && a.playState === 'running'),
      }); };
      w.__selectionFrames = [sample()];
      document.addEventListener('click', () => {
        const start = performance.now(), channel = new MessageChannel();
        const next = () => {
          w.__selectionFrames.push(sample());
          if (performance.now() - start < 350) requestAnimationFrame(() => channel.port2.postMessage(null));
          else { channel.port1.close(); channel.port2.close(); w.__selectionDone = true; }
        };
        channel.port1.onmessage = next;
        w.__selectionDone = false;
        requestAnimationFrame(() => channel.port2.postMessage(null));
      }, { once: true, capture: true });
    }, { keys, edges, name });
    await (await card(page, name)).click();
    await page.waitForFunction(() => (window as any).__selectionDone);
    const frames = await page.evaluate(() => (window as any).__selectionFrames);
    await info.attach(`${name} frames`, { body: JSON.stringify(frames), contentType: 'application/json' });
    expect(frames.length).toBeGreaterThan(3);
    const [before] = frames;
    for (const n of names) expect(before.tiles[n], `${n} shown`).not.toBeNull();
    for (const [index, frame] of frames.entries()) {
      expect(frame.ghosts, `${name} frame ${index}: no retiring copies`).toBe(0);
      expect(frame.running, `${name} frame ${index}: no scene motion`).toBe(0);
      expect(frame.styling, 'no selection CSS transition').toBe(false);
      expect(frame.tiles, `${name} frame ${index}: every tile where it was`).toEqual(before.tiles);
      expect(frame.connectors, `${name} frame ${index}: every connector where it was, one each`).toEqual(before.connectors);
    }
    await settle(page);
    expect(await rendered(page, 'tone', 'focus'), `${name} is the focus`).toHaveLength(1);
    expect(await page.locator('[data-grid-band] .graph').getAttribute('data-orientation'), `${name}: orientation kept`).toBe(orientation);
  }
  expect((await uncaught(page)).filter(e => e !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([]);
});

for (const interrupt of [false, true]) test(`reflow entrances keep tile and connector opacity together (${interrupt ? 'a resize while hidden snaps them' : 'initial'})`, async ({ page }) => {
  await openView(page, 454, '?selectionBlink=1', false);
  const parent = await key(page, 'stack'), child = await key(page, 'Cerulean');
  await holdMotion(page);
  try {
    await page.locator('[data-stack-toggle]').click();
    await awaitMotionStarted(page);
    if (interrupt) {
      // A resize snaps (it is not a change the user made in the view): the entrance ends at once,
      // tile and connector together fully shown on the next frame, with no motion left.
      const shown = await page.evaluate(async ({ parent, child }) => {
        (window as any).trace.motion.seek(40);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        (window as any).trace.setWidth(500);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const opacity = (el: Element) => { let value = 1; for (let at: Element | null = el; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
        const routes = [...document.querySelectorAll(`path[data-from="node:${parent}"][data-to="node:${child}"], path[data-motion-from="node:${parent}"][data-motion-to="node:${child}"]`)];
        return { tile: opacity(document.querySelector(`[data-tile-key="${child}"]`)!), connector: Math.max(0, ...routes.map(opacity)),
          running: (window as any).trace.motion.state().running.length + document.getAnimations().filter(a => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation) && a.playState === 'running').length };
      }, { parent, child });
      expect(shown).toEqual({ tile: 1, connector: 1, running: 0 });
      return;
    }
    const samples = await page.evaluate(async ({ parent, child }) => {
      const frames = [];
      const opacity = (el: Element) => { let value = 1; for (let at: Element | null = el; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
      const motion = (window as any).trace.motion;
      // All effects in this pass, including tile and HTML connector entrances, run on one epoch clock.
      const clocks = motion.state().running.map((epoch: { epoch: number }) => epoch.epoch);
      for (const time of [0, 40, 80, 100, 120, 159]) {
        motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tile = document.querySelector(`[data-tile-key="${child}"]`)!;
        const routes = [...document.querySelectorAll(`path[data-from="node:${parent}"][data-to="node:${child}"], path[data-motion-from="node:${parent}"][data-motion-to="node:${child}"]`)];
        (window as any).__checkOcclusion?.(); frames.push({ tile: opacity(tile), connector: Math.max(0, ...routes.map(opacity)) });
      }
      return { frames, clocks };
    }, { parent, child });
    expect(samples.clocks).toHaveLength(1);
    for (const frame of samples.frames) expect(frame.connector).toBeCloseTo(frame.tile, 2);
    expect(samples.frames.at(-1)!.tile).toBeGreaterThan(.9);
  } finally { await releaseMotion(page); }
  await settle(page);
});

for (const resize of [false, true]) test(`reflow clocks and source restoration on the running frame clock (${resize ? 'tile size, which snaps' : 'entrance'})`, async ({ page }) => {
  await openView(page, 454, '?selectionBlink=1&fileTile=1&tileSize=small', resize);
  const parent = await key(page, 'stack'), child = await key(page, 'Cerulean');
  // Extend the active interval under CPU load (the epoch clock runs 20 times slower than frame
  // time), retaining the driver's own frame loop. The clock is not held.
  await page.evaluate(() => (window as any).trace.motion.setRate(1 / 20));
  const startedBefore = (await motionState(page)).started;
  try {
    if (resize) {
      // A tile size change snaps: no effect is created, and the live connector shows at once.
      await page.evaluate(() => (window as any).trace.setTileSize('large'));
      await settle(page);
      expect((await motionState(page)).started).toBe(startedBefore);
      await expect(page.locator(`path[data-from="node:${parent}"][data-to="node:${child}"]`)).toHaveCount(1);
      expect(await page.locator(`path[data-from="node:${parent}"][data-to="node:${child}"]`).evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      await expect(page.locator('[data-motion-route-layer], [data-motion-ghost]')).toHaveCount(0);
      return;
    }
    await page.locator('[data-stack-toggle]').click();
    await awaitMotionStarted(page);
    // One epoch clock drives every effect of the entrance.
    const { running } = await motionState(page);
    expect(running).toHaveLength(1);
    expect(running[0].held).toBe(false);
    const source = page.locator(`path[data-from="node:${parent}"][data-to="node:${child}"]`);
    await expect(source).toHaveCount(1);
    expect(await source.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(0);
    await page.evaluate(async () => {
      (window as any).trace.motion.finish();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Completion hands the visible connector back to the live SVG.
    expect(await source.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
    await expect(page.locator('[data-motion-route-layer], [data-motion-ghost]')).toHaveCount(0);
  } finally { await releaseMotion(page); }
  await settle(page);
});
