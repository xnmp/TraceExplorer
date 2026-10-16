import { test, expect } from '@playwright/test';
import { card, caret, key, openView, settle, uncaught } from './support';
import { samplePaintedFrames, sceneBusy } from './helpers/scene-events';

/** All route instances (live and motion), with their displayed geometry and effective opacity. */
function frame() {
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
  const routes: Record<string, { geometry: number[]; opacity: number; path: string; from: string; to: string }[]> = {};
  for (const path of grid.querySelectorAll<SVGPathElement>('path[data-route], path[data-motion-route]')) {
    const id = path.dataset.route ?? path.dataset.motionRoute!;
    const matrix = path.getScreenCTM()!;
    const endpoints = [0, path.getTotalLength()].flatMap(length => {
      const p = path.getPointAtLength(length), shown = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      return [shown.x - origin.x, shown.y - origin.y];
    });
    (routes[id] ??= []).push({ geometry: [...box(path), ...endpoints], opacity: opacity(path) / (path.classList.contains('unrelated') ? .4 : 1), path: path.getAttribute('d')!,
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
  const frames = await samplePaintedFrames(page, frame, 600, () => caret(page, 'Ash').then(caret => caret.click()), sceneBusy);
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
