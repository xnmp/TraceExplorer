import { checkRouteOcclusionFrames } from "./helpers/route-occlusion";
import { test, expect } from '@playwright/test';
import { card, caret, key, openView, settle, uncaught } from './support';
import { samplePaintedFrames, sceneBusy } from './helpers/scene-events';
import { awaitMotionStarted, holdMotion, releaseMotion, seekMotion } from './animation-control';

checkRouteOcclusionFrames();

/** All route instances (live and motion), with their displayed geometry and effective opacity. */
function frame() {
  (window as any).__checkOcclusion?.();
  const grid = document.querySelector<HTMLElement>('[role="grid"]')!;
  const origin = grid.getBoundingClientRect();
  const opacity = (element: Element) => {
    let value = 1;
    for (let at: Element | null = element; at && at !== grid; at = at.parentElement) {
      const style = getComputedStyle(at);
      value *= style.visibility === 'hidden' || style.display === 'none' ? 0 : Number(style.opacity);
    }
    return value;
  };
  const box = (element: Element) => {
    const b = element.getBoundingClientRect();
    return [b.x - origin.x, b.y - origin.y, b.width, b.height];
  };
  // Remove only the settled selection tone (.unrelated); retain every motion opacity multiplier.
  const tiles = Object.fromEntries([...grid.querySelectorAll<HTMLElement>('[data-tile-key]')]
    .map(tile => [tile.dataset.tileKey!, { geometry: box(tile), opacity: opacity(tile.querySelector('.card') ?? tile) / (tile.classList.contains('unrelated') ? .78 : 1) }]));
  const routes: Record<string, { geometry: number[]; opacity: number; path: string; from: string; to: string; points: { x: number; y: number }[]; clipTop: number }[]> = {};
  for (const path of grid.querySelectorAll<SVGPathElement>('path[data-route], path[data-motion-route]')) {
    const id = path.dataset.route ?? path.dataset.motionRoute!;
    const matrix = path.getScreenCTM()!;
    const endpoints = [0, path.getTotalLength()].flatMap(length => {
      const p = path.getPointAtLength(length), shown = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return [shown.x - origin.x, shown.y - origin.y];
    });
    let clipTop = -Infinity;
    for (let at = path.parentElement; at; at = at.parentElement) {
      const clip = /^polygon\(([^)]*)\)/.exec(getComputedStyle(at).clipPath);
      if (clip) clipTop = Math.max(clipTop, at.getBoundingClientRect().top - origin.top
        + Math.min(...clip[1].split(',').map(p => parseFloat(p.trim().split(/\s+/)[1]))));
    }
    const points = Array.from({ length: 301 }, (_, i) => {
      const p = path.getPointAtLength(path.getTotalLength() * i / 300), q = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return { x: q.x - origin.x, y: q.y - origin.y };
    });
    (routes[id] ??= []).push({ points, clipTop, geometry: [...box(path), ...endpoints], opacity: opacity(path) / (path.classList.contains('unrelated') ? .4 : 1), path: path.getAttribute('d')!,
      from: path.dataset.from ?? path.dataset.motionFrom!, to: path.dataset.to ?? path.dataset.motionTo! });
  }
  return { tiles, routes, running: (window as any).trace.motion.state().running.length };
}

for (const height of [480, 1500]) test(`growing a band keeps every persistent tile and route opaque and moving continuously (viewport ${height})`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height });
  await openView(page, 380, '?bandMove=1&fileTile=1&tileSize=small', false);
  const toggle = async (name: string) => page.locator(`[data-stack-key="${await key(page, name)}"] [data-stack-toggle]`);
  for (const name of ['stack-a', 'stack-c']) { await (await toggle(name)).click(); await settle(page); }
  await (await caret(page, 'Saffron')).click(); await settle(page);
  // Select without expanding first, so the expansion uses Ash as its anchor in both engines.
  await (await card(page, 'Ash')).click({ modifiers: ['Control'] }); await settle(page);
  const before = await page.evaluate(frame);
  const covers = await Promise.all(['stack-a', 'stack-b', 'stack-c'].map(name => key(page, name)));
  expect(new Set(covers.map(key => before.tiles[key].geometry[1])).size, 'all three covers share the top row').toBe(1);
  const pikachu = await key(page, 'Visible Pikachu'), ash = await key(page, 'Ash');
  expect(before.tiles[pikachu].geometry[1]).toBeGreaterThan(before.tiles[ash].geometry[1]);
  expect(Math.max(...Object.values(before.routes).flat().map(route => route.geometry[3])), 'long connector to the lower band').toBeGreaterThan(200);
  // The held clock paints each epoch time exactly, so slow runners sample the same frames.
  const frames: ReturnType<typeof frame>[] = [];
  await holdMotion(page);
  try {
    await (await caret(page, 'Ash')).click();
    await awaitMotionStarted(page);
    for (const at of [0, 8, 16, 33, 50, 66, 83, 100, 133, 160]) {
      await seekMotion(page, at);
      frames.push(await page.evaluate(frame));
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  const after = await page.evaluate(frame);
  await info.attach('band move frames', { body: JSON.stringify({ before, frames, after }), contentType: 'application/json' });
  expect(after.tiles[await key(page, 'Charizard')]).toBeDefined();
  expect(after.tiles[pikachu].geometry[1] - before.tiles[pikachu].geometry[1], 'lower band moves down').toBeGreaterThan(40);
  expect(frames.filter(f => f.running).length, 'sample intermediate motion frames').toBeGreaterThan(2);
  const faults: string[] = [];
  for (const kind of ['tiles', 'routes'] as const) {
    for (const id of Object.keys(before[kind]).filter(id => id in after[kind])) {
      const shown = (f: ReturnType<typeof frame>) => kind === 'tiles' ? f.tiles[id]
        : f.routes[id]?.reduce((best, route) => route.opacity > best.opacity ? route : best);
      const first = shown(before)!, last = shown(after)!;
      let previous = first.geometry;
      const positions: number[][] = [];
      for (const [index, f] of frames.entries()) {
        const item = shown(f);
        if (!item || item.opacity < .999) { faults.push(`${kind} ${id} frame ${index}: opacity ${item?.opacity ?? 'missing'}`); continue; }
        positions.push(item.geometry);
        for (let axis = 0; axis < item.geometry.length; axis++) {
          const a = first.geometry[axis], b = last.geometry[axis], value = item.geometry[axis];
          if (value < Math.min(a, b) - 1 || value > Math.max(a, b) + 1 || Math.abs(value - b) > Math.abs(previous[axis] - b) + 1)
            faults.push(`${kind} ${id} frame ${index}: discontinuous geometry on axis ${axis}`);
        }
        if (kind === 'routes') {
          const route = f.routes[id].reduce((a, b) => a.opacity > b.opacity ? a : b);
          for (const [endpoint, offset] of [[route.from, 4], [route.to, 6]] as const) {
            if (!endpoint.startsWith('node:')) continue;
            const key = endpoint.slice(5), oldTile = before.tiles[key], tile = f.tiles[key];
            if (!oldTile || !tile) continue;
            for (const axis of [0, 1]) {
              const expected = tile.geometry[axis] + first.geometry[offset + axis] - oldTile.geometry[axis];
              if (Math.abs(item.geometry[offset + axis] - expected) > 1)
                faults.push(`routes ${id} frame ${index}: port detached from ${key}`);
            }
          }
        }
        previous = item.geometry;
      }
      // Moving geometry must have intermediate positions, not jump directly to its target.
      for (let axis = 0; axis < first.geometry.length; axis++) if (Math.abs(first.geometry[axis] - last.geometry[axis]) > 40)
        expect(positions.some(p => Math.abs(p[axis] - first.geometry[axis]) > 1 && Math.abs(p[axis] - last.geometry[axis]) > 1), `${kind} ${id} axis ${axis} glides`).toBe(true);
    }
  }
  expect(faults).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});


test('a shared-row close preserves its outgoing source connector on the first frame', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, '?bandMotion=bridge', false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`).evaluate((e: HTMLElement) => e.click());
  for (const name of ['a', 'b']) { await toggle(name); await settle(page); }
  const source = `node:${await key(page, 'stack-a')}`;
  const before = await page.evaluate(frame);
  const outgoing = Object.entries(before.routes).filter(([, routes]) => routes.some(r => r.from === source));
  expect(outgoing.length).toBeGreaterThan(0);
  await holdMotion(page);
  try {
    await toggle('a'); await awaitMotionStarted(page); await seekMotion(page, 0);
    const first = await page.evaluate(frame);
    for (const [id, old] of outgoing) {
      const shown = first.routes[id].find(r => r.opacity > .99)!;
      expect(shown).toBeDefined();
      expect(shown.geometry[5], id).toBeGreaterThanOrEqual(shown.clipTop - .01);
      expect(shown.geometry.slice(4)).toEqual(old.find(r => r.opacity > .99)!.geometry.slice(4));
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});

test('reordering packed bands replaces one complete clear scene without blinking', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 330, '?bandMotion=bridge', false);
  for (const name of ['a', 'b']) {
    await page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`).evaluate((e: HTMLElement) => e.click());
    await settle(page);
  }
  const before = await page.evaluate(frame);
  const frames = await samplePaintedFrames(page, frame, 400, () => page.evaluate(() => (window as any).trace.resort()), sceneBusy);
  await settle(page);
  const after = await page.evaluate(frame);
  expect(Object.values(after.tiles).map(t => t.geometry)).not.toEqual(Object.values(before.tiles).map(t => t.geometry));
  for (const f of [...frames, after]) {
    expect(f.running).toBe(0); // Listing changes are atomic under geometryMotion's input policy.
    const matches = (scene: ReturnType<typeof frame>) => Object.entries(before.tiles).every(([key]) =>
      f.tiles[key]?.geometry.every((n, axis) => Math.abs(n - scene.tiles[key].geometry[axis]) < .02));
    const target = matches(before) ? before : after;
    expect(matches(target), 'each painted frame shows a complete packing').toBe(true);
    for (const id of Object.keys(before.routes)) {
      const route = f.routes[id]?.find(r => r.opacity > .999);
      expect(route, id).toBeDefined();
      for (const [key, tile] of Object.entries(f.tiles)) {
        if (`node:${key}` === route!.from || `node:${key}` === route!.to || tile.opacity < .99) continue;
        const [x, y, width, height] = tile.geometry;
        expect(route!.points.filter(p => p.x > x + 3 && p.x < x + width - 3 && p.y > y + 3 && p.y < y + height - 3), `${id} through ${key}`).toEqual([]);
      }
      const expected = target.routes[id].find(r => r.opacity > .999)!;
      route!.geometry.forEach((n, axis) => expect(n).toBeCloseTo(expected.geometry[axis], 1));
    }
    for (const [key, tile] of Object.entries(before.tiles)) expect(f.tiles[key]?.opacity, key).toBe(tile.opacity);
  }
  expect(await uncaught(page)).toEqual([]);
});


for (const theme of ['light', 'dark']) test(`opaque cards occlude routes across bands and stack cells (${theme})`, async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1800 });
  await openView(page, 390, `?bandMotion=bridge&theme=${theme}`, false);
  for (const name of ['a', 'b']) {
    await page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`).evaluate((e: HTMLElement) => e.click());
    await settle(page);
  }
  const result = await page.evaluate(() => {
    const w = window as any, plane = document.querySelector<HTMLElement>('[data-paint-plane=routes]')!;
    const path = document.querySelector<SVGPathElement>('[data-route-band] path[data-route]')!;
    const original = path.getAttribute('d')!;
    const targets = [document.querySelector<HTMLElement>('[data-grid-cell].stack [data-tile-key]')!,
      document.querySelector<HTMLElement>('[data-grid-band] [data-tile-key]')!,
      document.querySelector<HTMLElement>('[data-grid-cell]:not(.stack)')!];
    const checks = targets.map(target => {
      const b = target.getBoundingClientRect(), inverse = path.getScreenCTM()!.inverse();
      const a = new DOMPoint(b.left + 2, b.top + b.height / 2).matrixTransform(inverse);
      const z = new DOMPoint(b.right - 2, b.top + b.height / 2).matrixTransform(inverse);
      path.setAttribute('d', `M${a.x} ${a.y} L${z.x} ${z.y}`);
      const before = w.__occlusionOverlaps;
      w.__checkOcclusion();
      const faults = [...w.__occlusionFaults], overlaps = w.__occlusionOverlaps - before;
      // Prove this is a paint-order assertion: elevating the route plane must fail it.
      plane.style.zIndex = '2'; w.__checkOcclusion();
      const reversed = w.__occlusionFaults.some((f: any) => f.fault === 'route above tile');
      plane.style.zIndex = ''; w.__occlusionFaults = [];
      const background = target.style.backgroundColor;
      target.style.backgroundColor = 'transparent'; w.__checkOcclusion();
      const translucent = w.__occlusionFaults.some((f: any) => f.fault === 'translucent tile surface');
      target.style.backgroundColor = background; w.__occlusionFaults = [];
      path.setAttribute('d', original);
      return { faults, overlaps, reversed, translucent };
    });
    return checks;
  });
  for (const check of result) {
    expect(check.faults).toEqual([]);
    expect(check.overlaps, 'sampled actual route/tile intersections').toBeGreaterThan(0);
    expect(check.reversed, 'probe rejects routes painted above tiles').toBe(true);
    expect(check.translucent, 'probe rejects transparent tile backdrops').toBe(true);
  }
});
