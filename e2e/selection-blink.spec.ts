import { test, expect } from '@playwright/test';
import { card, key, openView, settle, uncaught } from './support';
import { holdMotion, awaitMotionStarted, releaseMotion, motionState } from './animation-control';

/** Sample after all frame callbacks, beginning with the click's first presented frame. */
test('selection reveals tiles and connectors instantly without disturbing retained cards', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await openView(page, 454, '?selectionBlink=1&scrollbars=host', false);
  await page.locator('[data-stack-toggle]').click();
  await settle(page);
  await (await card(page, 'Saffron')).click();
  await settle(page);
  // A reveal keeps the band's orientation; the swaps below must stay reveals.
  const orientation = await page.locator('.graph').getAttribute('data-orientation');
  expect(orientation).toMatch(/^(right|down)$/);
  const names = ['Cerulean', 'Saffron', "Pikachu's Ball", 'Blastoise', 'Ash'];
  const keys = Object.fromEntries(await Promise.all(names.map(async name => [name, await key(page, name)])));
  for (const name of ['Cerulean', 'Saffron', 'Cerulean', 'Saffron']) {
    await page.evaluate(({ keys, name }) => {
      const w = window as any;
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; };
      const retained = () => Object.fromEntries(['Cerulean', 'Saffron'].map(n => [n, box(document.querySelector(`[data-tile-key="${keys[n]}"]`)!)]));
      const opacity = (el: Element) => { let value = 1; for (let at: Element | null = el; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
      w.__revealFrames = [];
      w.__retainedBefore = retained();
      document.addEventListener('click', () => {
        const start = performance.now(), channel = new MessageChannel();
        const sample = () => {
          const tiles = Object.fromEntries(Object.entries(keys).map(([n, k]) => {
            const tile = document.querySelector(`[data-tile-key="${k}"]`);
            return [n, tile ? opacity(tile) : null];
          }));
          const children = name === 'Cerulean' ? ["Pikachu's Ball"] : ['Blastoise', 'Ash'];
          const cards = Object.fromEntries(children.map(child => {
            const tile = document.querySelector(`[data-tile-key="${keys[child]}"]`);
            return [child, tile ? opacity(tile.querySelector('.card') ?? tile) : null];
          }));
          const connectors = Object.fromEntries(children.map(child => [child, [...document.querySelectorAll(`path[data-from="node:${keys[name]}"][data-to="node:${keys[child]}"], path[data-motion-from="node:${keys[name]}"][data-motion-to="node:${keys[child]}"]`)].map(opacity)]));
          const selected = document.querySelector(`[data-node-key="${keys[name]}"]`)!;
          w.__revealFrames.push({ tiles, cards, connectors, retained: retained(), ghosts: document.querySelectorAll('[data-motion-ghost]').length,
            styling: selected.getAnimations({ subtree: true }).some(a => 'transitionProperty' in a && a.playState === 'running') });
          if (performance.now() - start < 350) requestAnimationFrame(() => channel.port2.postMessage(null));
          else { channel.port1.close(); channel.port2.close(); w.__revealDone = true; }
        };
        channel.port1.onmessage = sample;
        w.__revealDone = false;
        requestAnimationFrame(() => channel.port2.postMessage(null));
      }, { once: true, capture: true });
    }, { keys, name });
    await (await card(page, name)).click();
    await page.waitForFunction(() => (window as any).__revealDone);
    const { frames, before } = await page.evaluate(() => ({ frames: (window as any).__revealFrames, before: (window as any).__retainedBefore }));
    await info.attach(`${name} frames`, { body: JSON.stringify(frames), contentType: 'application/json' });
    const children = name === 'Cerulean' ? ["Pikachu's Ball"] : ['Blastoise', 'Ash'];
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[0].styling, 'selection CSS transitions remain running').toBe(true);
    for (const frame of frames) {
      expect(frame.ghosts, `${name}: no retiring copies`).toBe(0);
      for (const retained of ['Cerulean', 'Saffron']) {
        expect(frame.retained[retained].x).toBeCloseTo(before[retained].x, 1);
        expect(frame.retained[retained].y).toBeCloseTo(before[retained].y, 1);
      }
      for (const child of children) {
        expect(frame.tiles[child], `${name}: ${child} fully visible from first frame`).toBe(1);
        expect(frame.cards[child], `${child}: effective card opacity`).toBe(1);
        expect(frame.connectors[child], `${child}: one live opaque connector`).toEqual([1]);
      }
    }
    // Every live tile/connector that persists across consecutive frames is monotone.
    for (let i = 1; i < frames.length; i++) {
      for (const n of names) if (frames[i - 1].tiles[n] !== null && frames[i].tiles[n] !== null)
        expect(frames[i].tiles[n]).toBeGreaterThanOrEqual(frames[i - 1].tiles[n]);
      for (const child of children) expect(Math.max(...frames[i].connectors[child])).toBeGreaterThanOrEqual(Math.max(...frames[i - 1].connectors[child]));
    }
    await settle(page);
    expect(await page.locator('.graph').getAttribute('data-orientation'), `${name}: orientation kept`).toBe(orientation);
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
        frames.push({ tile: opacity(tile), connector: Math.max(0, ...routes.map(opacity)) });
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
