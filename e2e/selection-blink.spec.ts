import { test, expect } from '@playwright/test';
import { card, key, openView, settle, uncaught } from './support';
import { holdScriptedAnimations, awaitAnimationsCreated, releaseScriptedAnimations } from './animation-control';

/** Sample after all frame callbacks, beginning with the click's first presented frame. */
test('selection reveals tiles and connectors instantly without disturbing retained cards', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 720 });
  await openView(page, 454, '?selectionBlink=1&scrollbars=host', false);
  await page.locator('[data-stack-toggle]').click();
  await settle(page);
  await (await card(page, 'Saffron')).click();
  await settle(page);
  expect(await page.locator('.graph').getAttribute('data-orientation')).toBe('right');
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
  }
  expect((await uncaught(page)).filter(e => e !== 'ResizeObserver loop completed with undelivered notifications.')).toEqual([]);
});

for (const interrupt of [false, true]) test(`reflow entrances keep tile and connector opacity together (${interrupt ? 'interrupted while hidden' : 'initial'})`, async ({ page }) => {
  await openView(page, 454, '?selectionBlink=1', false);
  const parent = await key(page, 'stack'), child = await key(page, 'Cerulean');
  await holdScriptedAnimations(page);
  try {
    await page.locator('[data-stack-toggle]').click();
    await awaitAnimationsCreated(page);
    if (interrupt) {
      await page.evaluate(async () => {
        for (const a of (window as any).__heldAnimations as Animation[]) if (a.playState === 'running') a.currentTime = 40;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        (window as any).trace.setWidth(500);
      });
      await awaitAnimationsCreated(page);
    }
    const samples = await page.evaluate(async ({ parent, child }) => {
      const frames = [];
      const opacity = (el: Element) => { let value = 1; for (let at: Element | null = el; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
      const held = (window as any).__heldAnimations as Animation[];
      await Promise.all(held.filter(a => a.playState === 'running').map(a => a.ready));
      // Effects from this pass resolve together without explicit startTime.
      const clocks = held.filter(a => a.playState === 'running').map(a => a.startTime);
      for (const time of [0, 40, 80, 100, 120, 159]) {
        for (const a of held) if (a.playState === 'running') a.currentTime = time;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const tile = document.querySelector(`[data-tile-key="${child}"]`)!;
        const routes = [...document.querySelectorAll(`path[data-from="node:${parent}"][data-to="node:${child}"], path[data-motion-from="node:${parent}"][data-motion-to="node:${child}"]`)];
        frames.push({ tile: opacity(tile), connector: Math.max(0, ...routes.map(opacity)) });
      }
      return { frames, clocks };
    }, { parent, child });
    expect(samples.clocks.length).toBeGreaterThan(0);
    expect(new Set(samples.clocks).size).toBe(1);
    for (const frame of samples.frames) expect(frame.connector).toBeCloseTo(frame.tile, 2);
    expect(samples.frames.at(-1)!.tile).toBeGreaterThan(.9);
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
});
