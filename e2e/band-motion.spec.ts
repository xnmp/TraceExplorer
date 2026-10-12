import { test, expect, type Page } from '@playwright/test';
import { openView, settle, key, uncaught } from './support';

/** Screen-space rectangles, including every ancestor clip, sampled after the frame callbacks. */
async function sampleBand(page: Page, selector: string, ms = 700, actions: Array<{ at: number; selector: string }> = [], speed = 1) {
  return page.evaluate(async ({ selector, ms, actions, speed }) => {
    const start = performance.now();
    const animate = Element.prototype.animate;
    const held: Array<{ animation: Animation; epoch?: number }> = [];
    Element.prototype.animate = function(frames, options) {
      const timing = typeof options === 'number' ? options * speed : { ...options, duration: Number(options?.duration ?? 0) * speed };
      const animation = animate.call(this, frames, timing);
      if (speed > 1) { animation.playbackRate = 0; held.push({ animation }); }
      return animation;
    };
    const rect = (element: Element) => {
      const b = element.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const snapshot = (t: number) => {
      const elements = [...document.querySelectorAll<HTMLElement>('[data-grid-band] [data-tile-key], [data-grid-exit] .tile')];
      // Read boxes together before the more expensive clipping-ancestor walk.
      const boxes = new Map(elements.map(element => [element, rect(element)]));
      const tiles = elements.map(element => {
        const full = boxes.get(element)!, visible = { ...full }, clips: string[] = [];
        let opacity = 1;
        const intersect = (b: typeof full, x = true, y = true) => {
          const right = Math.min(visible.x + visible.width, b.x + b.width), bottom = Math.min(visible.y + visible.height, b.y + b.height);
          if (x) { visible.x = Math.max(visible.x, b.x); visible.width = Math.max(0, right - visible.x); }
          if (y) { visible.y = Math.max(visible.y, b.y); visible.height = Math.max(0, bottom - visible.y); }
        };
        for (let at: Element | null = element; at; at = at.parentElement) {
          const style = getComputedStyle(at);
          opacity *= Number(style.opacity);
          if (at !== element) {
            const x = /hidden|clip|auto|scroll/.test(style.overflowX), y = /hidden|clip|auto|scroll/.test(style.overflowY);
            if (x || y) { intersect(rect(at), x, y); clips.push(`${at.className}:overflow`); }
          }
          if (style.clipPath !== 'none') {
            const box = rect(at), inset = /^inset\(([^)]*)\)/.exec(style.clipPath);
            if (inset) {
              const lengths = inset[1].split(/\s+round\s+/)[0].split(/\s+/);
              const values = [lengths[0], lengths[1] ?? lengths[0], lengths[2] ?? lengths[0], lengths[3] ?? lengths[1] ?? lengths[0]];
              const [top, right, bottom, left] = values.map((v, i) => parseFloat(v) * (v.endsWith('%') ? (i % 2 ? box.width : box.height) / 100 : 1));
              intersect({ x: box.x + left, y: box.y + top, width: box.width - left - right, height: box.height - top - bottom });
            } else if (style.clipPath.startsWith('url(')) {
              const id = style.clipPath.match(/#([^"')]+)/)?.[1];
              const clip = id ? document.getElementById(id) : null;
              if (!clip) throw new Error(`Unresolved SVG clip: ${style.clipPath}`);
              for (const shape of clip.children) intersect(rect(shape));
            } else throw new Error(`Unsupported clip: ${style.clipPath}`);
            clips.push(`${at.className}:${style.clipPath}`);
          }
        }
        return { key: element.dataset.tileKey ?? 'exit', full, visible, opacity, clips };
      });
      return { t, tiles, rows: [...document.querySelectorAll<HTMLElement>('[data-grid-cell]')].filter(e => Number(e.getAttribute('aria-rowindex')) > 1).map(rect),
        routes: [...document.querySelectorAll<SVGPathElement>('[data-grid-band] path[data-route]')].map(e => {
          const point = e.getPointAtLength(e.getTotalLength()), matrix = e.getScreenCTM()!;
          const end = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          return { id: e.dataset.route, to: e.dataset.to?.slice(5), end: { x: end.x, y: end.y }, rect: rect(e), path: getComputedStyle(e).getPropertyValue('d').replace(/^none$/, '') || e.getAttribute('d') };
        }),
        ghosts: document.querySelectorAll('[data-motion-ghost]').length,
        moving: document.getAnimations().some(a => (a.pending || a.playState === 'running') && a.effect?.getTiming().iterations !== Infinity) };
    };
    const frames = [snapshot(0)];
    let nextAction = 0;
    document.querySelector<HTMLElement>(selector)!.click();
    const channel = new MessageChannel();
    try {
      await new Promise<void>((resolve, reject) => {
        const sample = () => {
          try {
            frames.push(snapshot(performance.now() - start));
            if (nextAction < actions.length && performance.now() - start >= actions[nextAction].at) document.querySelector<HTMLElement>(actions[nextAction++].selector)!.click();
          }
          catch (e) { reject(e); return; }
          if (performance.now() - start < ms) channel.port2.postMessage(null); else resolve();
        };
        channel.port1.onmessage = () => {
          // The slow QA pass seeks a held clock before the next frame, so
          // native tiles and JS SVG attributes are frozen during measurement.
          // Normal speed continues to sample uninterrupted native animation.
          const now = Number(document.timeline.currentTime);
          for (const entry of held) {
            const { animation } = entry;
            if (animation.playState === 'idle' || animation.playState === 'finished') continue;
            entry.epoch ??= Number(animation.startTime ?? now);
            const duration = Number(animation.effect!.getTiming().duration);
            animation.currentTime = Math.min(duration, now - entry.epoch);
            if (now - entry.epoch >= duration) { animation.playbackRate = 1; animation.finish(); }
          }
          requestAnimationFrame(sample);
        };
        channel.port2.postMessage(null);
      });
    } finally {
      channel.port1.close(); channel.port2.close(); Element.prototype.animate = animate;
      for (const { animation } of held) if (animation.playState !== 'idle') animation.playbackRate = 1;
    }
    return { frames };
  }, { selector, ms, actions, speed });
}

for (const mode of ['motion', 'reduced', 'slow']) test(`wrapped persistent groups move whole without replay (${mode})`, async ({ page }, testInfo) => {
  const reduced = mode === 'reduced', speed = mode === 'slow' ? 10 : 1;
  const sampleTime = 160 * speed + 600;
  await page.setViewportSize({ width: 1000, height: 1300 });
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await openView(page, 420, '?bandMotion=1', false);
  const initial = await sampleBand(page, 'section[aria-label="stack-b"] [data-stack-toggle]', sampleTime, [], speed);
  expectClearRows(initial.frames);
  if (reduced) expect(initial.frames.every(frame => !frame.moving)).toBe(true);
  await settle(page);
  const bKeys = await Promise.all([key(page, 'stack-b-1'), key(page, 'stack-b-2')]);
  for (const action of ['[data-stack-toggle]', '[aria-label="Close stack"]']) {
    const result = await sampleBand(page, `section[aria-label="stack-a"] ${action}`, sampleTime, [], speed);
    await testInfo.attach(`frames-${action.includes('Close') ? 'close' : 'open'}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    const { frames } = result;
    const last = frames.at(-1)!;
    if (reduced) expect(frames.every(frame => !frame.moving)).toBe(true);
    for (const id of bKeys) {
      const first = frames[0].tiles.find(t => t.key === id)!, final = last.tiles.find(t => t.key === id)!;
      if (!reduced) expect(Math.abs(final.full.y - first.full.y)).toBeGreaterThan(100);
      let previous = first.full.y;
      const sign = Math.sign(final.full.y - first.full.y);
      for (const [index, frame] of frames.entries()) {
        const tile = frame.tiles.find(t => t.key === id)!;
        expect(tile, `missing ${id} at ${frame.t}`).toBeDefined();
        expect(tile.visible.width, JSON.stringify({ t: frame.t, tile })).toBeGreaterThanOrEqual(tile.full.width - 1);
        expect(tile.visible.height, JSON.stringify({ t: frame.t, tile })).toBeGreaterThanOrEqual(tile.full.height - 1);
        expect((tile.full.y - previous) * sign, `reversal at ${frame.t}`).toBeGreaterThanOrEqual(-1);
        const incoming = frame.routes.filter(r => r.to === id);
        expect(incoming.length, `missing stem at ${frame.t}`).toBeGreaterThan(0);
        for (const route of incoming) {
          const finalRoute = last.routes.find(r => r.id === route.id)!;
          const gap = final.full.y - finalRoute.end.y;
          if (mode === 'motion' && frame.moving) {
            // Native compositor boxes and SVG attributes cannot be read atomically.
            // At full speed require the stem to stay in the adjacent-frame travel
            // envelope. At 10% speed and after settling require pixel alignment.
            const neighbors = frames.slice(Math.max(0, index - 1), index + 2).map(f => f.tiles.find(t => t.key === id)!.full.y - gap);
            expect(route.end.y, `stem ahead of travel at ${frame.t}`).toBeGreaterThanOrEqual(Math.min(...neighbors) - 1);
            expect(route.end.y, `stem behind travel at ${frame.t}`).toBeLessThanOrEqual(Math.max(...neighbors) + 1);
          } else expect(Math.abs(route.end.y - (tile.full.y - gap)), `detached stem at ${frame.t}`).toBeLessThanOrEqual(1);
          expect(Math.abs(route.end.x - (tile.full.x + tile.full.width / 2)), `detached stem at ${frame.t}`).toBeLessThanOrEqual(1);
        }
        previous = tile.full.y;
      }
    }
    expectClearRows(frames);
    const firstIdle = frames.findIndex((f, i) => i > 0 && !f.moving && f.tiles.length === last.tiles.length);
    expect(firstIdle).toBeGreaterThan(0);
    for (const frame of frames) {
      if (frame.t > frames[firstIdle].t + 50) {
        expect(frame.moving, `replayed at ${frame.t}`).toBe(false);
        expect(frame.ghosts).toBe(0);
        for (const tile of frame.tiles) {
          const final = last.tiles.find(t => t.key === tile.key)!;
          expect(tile.full.y).toBeCloseTo(final.full.y, 0);
          expect(tile.full.x).toBeCloseTo(final.full.x, 0);
          expect(tile.opacity).toBeCloseTo(final.opacity, 2);
        }
        expect(frame.rows).toEqual(last.rows);
        expect(frame.routes).toEqual(last.routes);
      }
    }
  }
  expect(await uncaught(page)).toEqual([]);
});

function expectClearRows(frames: Awaited<ReturnType<typeof sampleBand>>["frames"]): void {
  for (const frame of frames) for (const tile of frame.tiles.filter(t => t.opacity > .01)) for (const row of frame.rows) {
    const overlapX = Math.min(row.x + row.width, tile.visible.x + tile.visible.width) - Math.max(row.x, tile.visible.x);
    const overlapY = Math.min(row.y + row.height, tile.visible.y + tile.visible.height) - Math.max(row.y, tile.visible.y);
    expect(overlapX <= 1 || overlapY <= 1, `row overlap at ${frame.t}: ${JSON.stringify({ tile, row })}`).toBe(true);
  }
}

for (const reopen of [false, true]) test(`initial entrance can close${reopen ? " and reopen" : ""} while rows are moving`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 420, '?bandMotion=1', false);
  const section = 'section[aria-label="stack-b"]';
  const actions = [{ at: 60, selector: `${section} [aria-label="Close stack"]` }, ...(reopen ? [{ at: 100, selector: `${section} [data-stack-toggle]` }] : [])];
  const result = await sampleBand(page, `${section} [data-stack-toggle]`, 850, actions);
  await testInfo.attach('interrupted-frames', { body: JSON.stringify(result), contentType: 'application/json' });
  expectClearRows(result.frames);
  expect(result.frames.at(-1)!.tiles.length).toBe(reopen ? 2 : 0);
  expect(result.frames.at(-1)!.moving).toBe(false);
  expect(await page.locator('[data-grid-exit]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});
