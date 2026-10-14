import { test, expect, type Page } from '@playwright/test';
import { holdMotion, releaseMotion, awaitMotionStarted } from './animation-control';
import { openView, settle, key, uncaught } from './support';

/** Screen-space rectangles, including every ancestor clip, sampled after the frame callbacks. */
async function sampleBand(page: Page, selector: string, ms = 700, actions: Array<{ at: number; selector: string }> = [], speed = 1) {
  return page.evaluate(async ({ selector, ms, actions, speed }) => {
    const start = performance.now();
    const motion = (window as any).trace.motion;
    // The slow pass runs the epoch clock `speed` times slower than frame time.
    motion.setRate(1 / speed);
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
            } else if (style.clipPath.startsWith('polygon(')) {
              const points = /^polygon\(([^)]*)\)/.exec(style.clipPath)![1].split(',').map(p => p.trim().split(/\s+/).map(parseFloat));
              const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]));
              intersect({ x: box.x + x, y: box.y + y, width: Math.max(...points.map(p => p[0])) - x, height: Math.max(...points.map(p => p[1])) - y });
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
          return { opacity: Number(getComputedStyle(e).opacity), id: e.dataset.route, to: e.dataset.to?.slice(5), end: { x: end.x, y: end.y }, rect: rect(e), path: getComputedStyle(e).getPropertyValue('d').replace(/^none$/, '') || e.getAttribute('d') };
        }),
        ghosts: document.querySelectorAll('[data-motion-ghost]').length,
        moving: motion.state().running.length > 0 || document.getAnimations().some(a => (a.pending || a.playState === 'running') && a.effect?.getTiming().iterations !== Infinity) };
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
        // Sampled after the frame's callbacks: the motion driver writes only there, so a sample is what the frame paints.
        channel.port1.onmessage = () => requestAnimationFrame(sample);
        channel.port2.postMessage(null);
      });
    } finally {
      channel.port1.close(); channel.port2.close(); motion.setRate(1);
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
  for (const action of ['[data-stack-toggle]', '[aria-label="Collapse stack"]']) {
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
        const incoming = frame.routes.filter(r => r.to === id && r.opacity > .2);
        if (!frame.moving) expect(incoming.length, `missing settled stem at ${frame.t}`).toBeGreaterThan(0);
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
  const actions = [{ at: 60, selector: `${section} [aria-label="Collapse stack"]` }, ...(reopen ? [{ at: 100, selector: `${section} [data-stack-toggle]` }] : [])];
  const result = await sampleBand(page, `${section} [data-stack-toggle]`, 850, actions);
  await testInfo.attach('interrupted-frames', { body: JSON.stringify(result), contentType: 'application/json' });
  expectClearRows(result.frames);
  expect(result.frames.at(-1)!.tiles.length).toBe(reopen ? 2 : 0);
  expect(result.frames.at(-1)!.moving).toBe(false);
  expect(await page.locator('[data-grid-exit]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});

/** Tiles and SVG geometry read in one task, between frames: what the last frame painted. */
async function routeFrame(page: Page) {
  return page.evaluate(() => {
    const opacity = (element: Element) => {
      let value = 1;
      for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity);
      return value;
    };
    const tileElements = [...document.querySelectorAll<HTMLElement>('[data-tile-key], [data-ghost-tile-key], [data-grid-cell] [data-entry-path], [data-grid-band] [data-motion-ghost].tile')];
    const tiles = tileElements.map(element => {
      const b = element.getBoundingClientRect();
      // Exit tiles are clipped together with their connectors. Test the visible rectangle.
      let bottom = b.bottom;
      for (let at: Element | null = element; at; at = at.parentElement) {
        const clip = /^inset\(([^)]*)\)/.exec(getComputedStyle(at).clipPath);
        if (clip) {
          const v = clip[1].split(/\s+/).map(parseFloat);
          bottom = Math.min(bottom, at.getBoundingClientRect().bottom - v[2 % v.length]);
        }
        const polygon = /^polygon\(([^)]*)\)/.exec(getComputedStyle(at).clipPath);
        if (polygon) {
          const points = polygon[1].split(',').map(p => p.trim().split(/\s+/).map(parseFloat));
          bottom = Math.min(bottom, at.getBoundingClientRect().top + Math.max(...points.map(p => p[1])));
        }
        if (/hidden|clip|auto|scroll/.test(getComputedStyle(at).overflowY)) bottom = Math.min(bottom, at.getBoundingClientRect().bottom);
      }
      return { key: element.dataset.tileKey ?? element.dataset.ghostTileKey ?? element.dataset.entryPath ?? 'departed tile', x: b.x, y: b.y, right: b.right, bottom, opacity: opacity(element), exit: element.closest<HTMLElement>('[data-grid-exit]')?.dataset.gridExit };
    });
    const routes = [...document.querySelectorAll<SVGPathElement>('[data-grid-band] path[data-route], [data-grid-exit] path[data-route], [data-grid-band] path[data-motion-ghost], [data-grid-exit] path[data-motion-ghost]')].map(path => {
      // Accelerated WebKit geometry advances even within one JS task. Read
      // opacity, CTM and each actual endpoint box adjacently, before probing
      // the SVG path; a scene-wide early tile snapshot is not atomic.
      const source = path.dataset.from ?? path.dataset.motionFrom, target = path.dataset.to ?? path.dataset.motionTo;
      const shown = opacity(path);
      const matrix = path.getScreenCTM()!, scale = Math.hypot(matrix.a, matrix.b);
      const endpointTiles = [source, target].flatMap(endpoint => {
        const i = tileElements.findIndex(e => (e.dataset.tileKey ?? e.dataset.ghostTileKey ?? e.dataset.entryPath) === endpoint?.slice(5));
        if (i < 0) return [];
        const b = tileElements[i].getBoundingClientRect();
        return [{ ...tiles[i], x: b.x, y: b.y, right: b.right, bottom: Math.min(b.bottom, tiles[i].bottom + b.y - tiles[i].y) }];
      });
      const endpointDots = [source, target].flatMap(endpoint => {
        if (!endpoint?.startsWith('junction:')) return [];
        const id = endpoint.slice(9), owner = path.closest('[data-grid-band], [data-grid-exit]')!;
        const dot = owner.querySelector<SVGCircleElement>(`[data-motion-junction="${CSS.escape(id)}"]`)
          ?? owner.querySelector<SVGCircleElement>(`[data-junction="${CSS.escape(id)}"]`);
        if (!dot) return [];
        const b = dot.getBoundingClientRect();
        return [{ id, x: b.x + b.width / 2, y: b.y + b.height / 2, opacity: 1 }];
      });
      const obstacles = tileElements.map((element, i) => {
        const b = element.getBoundingClientRect(), old = tiles[i];
        return { ...old, x: b.x, y: b.y, right: b.right, bottom: Math.min(b.bottom, old.bottom + b.y - old.y) };
      });
      const length = path.getTotalLength() * scale;
      const point = (distance: number) => {
        const p = path.getPointAtLength(distance / scale), s = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        return { x: s.x, y: s.y };
      };
      const clips: Array<{ x: number; y: number; right: number; bottom: number }> = [];
      const motionClips: typeof clips = [];
      for (let at: Element | null = path.parentElement; at; at = at.parentElement) {
        const style = getComputedStyle(at), box = at.getBoundingClientRect();
        const inset = /^inset\(([^)]*)\)/.exec(style.clipPath);
        if (inset) {
          const v = inset[1].split(/\s+/).map(parseFloat);
          const bounds = { x: box.x + v[3 % v.length], y: box.y + v[0], right: box.right - v[1 % v.length], bottom: box.bottom - v[2 % v.length] };
          clips.push(bounds); motionClips.push(bounds);
        }
        const polygon = /^polygon\(([^)]*)\)/.exec(style.clipPath);
        if (polygon) {
          const points = polygon[1].split(',').map(p => p.trim().split(/\s+/).map(parseFloat));
          const bounds = { x: box.x + Math.min(...points.map(p => p[0])), y: box.y + Math.min(...points.map(p => p[1])),
            right: box.x + Math.max(...points.map(p => p[0])), bottom: box.y + Math.max(...points.map(p => p[1])) };
          clips.push(bounds); motionClips.push(bounds);
        }
        const id = style.clipPath.match(/#([^"')]+)/)?.[1];
        if (id) {
          const rect = document.getElementById(id)?.querySelector('rect');
          if (!rect) throw new Error(`Unsupported SVG clip: ${style.clipPath}`);
          const matrix = (at as SVGGraphicsElement).getScreenCTM()!;
          const a = new DOMPoint(Number(rect.getAttribute('x')), Number(rect.getAttribute('y'))).matrixTransform(matrix);
          const b = new DOMPoint(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')), Number(rect.getAttribute('y')) + Number(rect.getAttribute('height'))).matrixTransform(matrix);
          clips.push({ x: a.x, y: a.y, right: b.x, bottom: b.y });
        }
        if (/hidden|clip|auto|scroll/.test(style.overflowX + style.overflowY)) clips.push({ x: box.x, y: box.y, right: box.right, bottom: box.bottom });
      }
      const visible = (p: { x: number; y: number }) => clips.every(c => p.x >= c.x && p.x <= c.right && p.y >= c.y && p.y <= c.bottom);
      const samples = Array.from({ length: Math.ceil(length / 2) + 1 }, (_, i) => point(Math.min(i * 2, length)));
      const d = (getComputedStyle(path).getPropertyValue('d') || path.getAttribute('d') || '').replace(/^path\(["']|["']\)$/g, '');
      // Mark exact cubic intervals, including a 4px window straddling their
      // boundaries. Numeric shape signatures exclude translation, so only
      // the settled layout's own corners may contain diagonal samples.
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      let prefix = '', before = 0, at = [0, 0], previousAxis: number | undefined;
      const bends: number[] = [];
      const curves = [...d.matchAll(/([MLC])\s*([^MLC]+)/g)].flatMap(match => {
        const values = match[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)!.map(Number);
        const dx = values[0] - at[0], dy = values[1] - at[1];
        const axis = match[1] === 'L' ? Math.abs(dy) < .001 && Math.abs(dx) > .001 ? 0 : Math.abs(dx) < .001 && Math.abs(dy) > .001 ? 1 : undefined : undefined;
        if (axis !== undefined && previousAxis !== undefined && axis !== previousAxis) bends.push(before);
        previousAxis = axis;
        prefix += match[0]; probe.setAttribute('d', prefix);
        const after = probe.getTotalLength() * scale;
        const curve = match[1] === 'C' ? [{ from: before, to: after,
          shape: values.map((v, i) => Math.round((v - at[i % 2]) * 10) / 10).join(',') }] : [];
        at = values.slice(-2); before = after;
        return curve;
      });
      const diagonals = samples.slice(2).flatMap((p, i) => {
        const a = samples[i];
        return visible(p) && Math.abs(p.x - a.x) > 1 && Math.abs(p.y - a.y) > 1 ? [{ at: i * 2, dx: p.x - a.x, dy: p.y - a.y, curves: curves.filter(c => i * 2 <= c.to && i * 2 + 4 >= c.from).map(c => c.shape), bend: bends.some(b => i * 2 <= b && i * 2 + 4 >= b) }] : [];
      });
      const hits = samples.filter(visible).flatMap(p => obstacles.filter(t => t.opacity > 0 && p.x > t.x + 1 && p.x < t.right - 1 && p.y > t.y + 1 && p.y < t.bottom - 1).map(t => t.key));
      const exit = path.closest('[data-grid-exit]');
      const exitTiles = exit ? tiles.filter(t => t.exit === (exit as HTMLElement).dataset.gridExit) : [];
      const from = point(0), end = point(length), near = point(Math.max(0, length - 1));
      const arrow = path.hasAttribute('marker-end') ? 8 * scale : 0;
      const tangent = Math.hypot(end.x - near.x, end.y - near.y) || 1;
      const tip = { x: end.x + arrow * (end.x - near.x) / tangent, y: end.y + arrow * (end.y - near.y) / tangent };
      return { id: path.dataset.route ?? path.dataset.motionRoute ?? 'ghost', d, curves, opacity: shown, hits, diagonals, endpointTiles, endpointDots,
        from, tip, source, target, painted: samples.some(visible),
        portsVisible: [from, tip].every(p => motionClips.every(c => p.x >= c.x && p.x <= c.right && p.y >= c.y && p.y <= c.bottom)),
        // Moved by the motion driver (the path or its motion layer), and any path it wrote inline (it never should: a path is never interpolated).
        driven: [path, path.closest("[data-motion-route-layer]")].some(element => !!element && (window as any).trace.motion.owns(element)),
        inlinePath: path.style.getPropertyValue('d'),
        orphan: !!exit && samples.some(visible) && exitTiles.every(t => t.opacity === 0 || t.bottom <= t.y) && opacity(path) > 0 };
    });
    const dots = [...document.querySelectorAll<SVGCircleElement>('[data-grid-band] [data-junction], [data-grid-exit] [data-junction], [data-grid-band] [data-motion-junction]')].map(dot => {
      const b = dot.getBoundingClientRect();
      return { id: dot.dataset.junction ?? dot.dataset.motionJunction!, x: b.x + b.width / 2, y: b.y + b.height / 2, opacity: opacity(dot) };
    });
    return { tiles, routes, dots };
  });
}

for (const fixture of ['1', 'bridge', 'native-large', 'junction', 'junction-collapse', 'trunks']) for (const scenario of ['close A', 'open A', 'B alone', 'close B alone', 'interrupt close A']) test(`connectors stay outside tiles and preserve orthogonal routes (${fixture}, ${scenario})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, fixture === 'native-large' ? 640 : 390, `?bandMotion=${fixture === 'native-large' ? 'bridge&fileTiles=1&tileSize=xlarge' : fixture}`, false);
  await expect(page.getByRole('grid', { name: 'Folder', exact: true })).toHaveAttribute('aria-colcount', '3');
  const toggle = (name: string) => `section[aria-label="stack-${name}"] [data-stack-toggle]`;
  if (scenario.includes('close A') || scenario === 'open A' || scenario === 'close B alone') { await page.locator(toggle('b')).click(); await settle(page); }
  if (fixture === 'junction-collapse' && scenario === 'open A') { await page.locator(`[data-node-key="${await key(page, 'stack-b-1')}"]`).click(); await settle(page); }
  if (fixture === 'junction' && scenario !== 'B alone') {
    await expect(page.locator('[data-grid-band] [data-junction]').first()).toBeVisible();
  }
  if (fixture === 'trunks' && scenario !== 'B alone') expect(await page.locator('[data-grid-band] path[data-route]').evaluateAll(paths => paths.some(p => p.getAttribute('data-from') === p.getAttribute('data-to')))).toBe(true);
  if (scenario.includes('close A')) { await page.locator(toggle('a')).click(); await settle(page); }
  const start = await routeFrame(page);
  if (scenario.includes('close A')) {
    const a = await key(page, 'stack-a-1'), b = await key(page, 'stack-b-1');
    expect(start.tiles.find(t => t.key === b)!.y).toBeGreaterThan(start.tiles.find(t => t.key === a)!.bottom);
    if (fixture.startsWith('bridge')) { const cover = await key(page, 'stack-b'); expect(start.routes.filter(r => r.id.startsWith(`node:${cover}`)).some(r => r.curves.filter(c => c.to - c.from > 1).length >= 3), JSON.stringify(start.routes)).toBe(true); }
  }
  await holdMotion(page);
  const frames: Array<{ time: number; scene: Awaited<ReturnType<typeof routeFrame>> }> = [];
  try {
    await page.locator(toggle(scenario.includes('B alone') ? 'b' : 'a')).evaluate((element: HTMLElement) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
    await awaitMotionStarted(page);
    let interrupted = false;
    for (const time of [...Array.from({ length: 10 }, (_, i) => i * 1000 / 60), 159, 160]) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, time);
      frames.push({ time, scene: await routeFrame(page) });
      if (scenario === 'interrupt close A' && time >= 33 && !interrupted) {
        interrupted = true;
        await page.locator(toggle('a')).evaluate((element: HTMLElement) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
        await awaitMotionStarted(page);
        for (const resumed of [0, ...Array.from({ length: 10 }, (_, i) => i * 1000 / 60), 159, 160]) {
          await page.evaluate(async time => {
            (window as any).trace.motion.seek(time);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, resumed);
          frames.push({ time: time + resumed, scene: await routeFrame(page) });
        }
        break;
      }
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  const end = await routeFrame(page);
  await testInfo.attach('route-frames', { body: JSON.stringify({ start, frames, end }), contentType: 'application/json' });
  const violations = frames.flatMap(({ time, scene }) => scene.routes.filter(r => r.opacity > 0).flatMap(route => {
    const allowedCurves = new Set([start, end].flatMap(f => f.routes.filter(r => r.id === route.id).flatMap(r => r.curves.map(c => c.shape))));
    // A 4px window across a sharp orthogonal join is diagonal even though
    // neither segment is. Exempt that join, and exact settled cubic shapes;
    // never exempt a straight diagonal just because it matches a curve tangent.
    const newDiagonals = route.diagonals.filter(d => !d.bend && !d.curves.some(c => allowedCurves.has(c)));
    return [route.hits.length ? `${time}ms ${route.id} cuts tiles ${[...new Set(route.hits)]}` : '',
      newDiagonals.length ? `${time}ms ${route.id} has ${newDiagonals.length} diagonal samples outside layout curves` : '',
      route.orphan ? `${time}ms orphan ${route.id}` : ''].filter(Boolean);
  }));
  expect(violations).toEqual([]);
  expect(end.routes.every(r => !r.orphan)).toBe(true);
  expect(await page.locator('[data-grid-exit], [data-motion-ghost]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});

test('a retiring group keeps its connector fade when another group closes', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, '?bandMotion=1', false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`);
  for (const name of ['a', 'b']) { await toggle(name).click(); await settle(page); }
  const a = await key(page, 'stack-a');
  await holdMotion(page);
  try {
    await toggle('a').evaluate((element: HTMLElement) => element.click());
    await awaitMotionStarted(page);
    await page.evaluate(async () => {
      (window as any).trace.motion.seek(.01);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const before = (await routeFrame(page)).routes.filter(r => r.id.startsWith(`node:${a}>`) && r.opacity > 0);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(r => r.opacity > 0 && r.opacity < 1)).toBe(true);
    await toggle('b').evaluate((element: HTMLElement) => element.click());
    await awaitMotionStarted(page);
    const after = (await routeFrame(page)).routes.filter(r => r.id.startsWith(`node:${a}>`) && r.opacity > 0);
    expect(after.map(r => ({ id: r.id, opacity: r.opacity, d: r.d }))).toEqual(before.map(r => ({ id: r.id, opacity: r.opacity, d: r.d })));
  } finally { await releaseMotion(page); }
  await settle(page);
  expect(await page.locator('[data-grid-exit], [data-motion-ghost]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});

const travelPositions = (page: Page, keys: string[]) => page.evaluate(keys => {
  const band = keys.map(key => document.querySelector<HTMLElement>(`[data-grid-band] [data-tile-key="${CSS.escape(key)}"]`)!);
  const rows = [...document.querySelectorAll<HTMLElement>('[data-grid-cell]')].filter(e => Number(e.getAttribute('aria-rowindex')) > 1);
  return [...band, ...rows].map(e => ({ id: e.dataset.tileKey ?? e.dataset.gridCell!, y: e.getBoundingClientRect().y }));
}, keys);

for (const interrupt of [false, true]) test(`inline FLIP holds the painted start until the clock advances${interrupt ? ' across interruption' : ''}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 420, '?bandMotion=1', false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`);
  for (const name of ['b', 'a']) { await toggle(name).click(); await settle(page); }
  const keys = await Promise.all([key(page, 'stack-b-1'), key(page, 'stack-b-2')]);
  const start = await travelPositions(page, keys);
  expect(start.length).toBeGreaterThan(2);
  await holdMotion(page);
  const samples: Awaited<ReturnType<typeof travelPositions>>[] = [start];
  try {
    await toggle('a').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    // Several actual render opportunities with the clock held at the epoch's start.
    // Screenshots force presentation too, rather than testing only inline CSS.
    for (let i = 0; i < 3; i++) {
      samples.push(await travelPositions(page, keys));
      await testInfo.attach(`awaiting-effect-${i}`, { body: await page.screenshot(), contentType: 'image/png' });
      expect(samples.at(-1)).toEqual(start);
    }
    if (interrupt) {
      await toggle('a').evaluate((e: HTMLElement) => e.click());
      await awaitMotionStarted(page);
      expect(await travelPositions(page, keys)).toEqual(start);
      await toggle('a').evaluate((e: HTMLElement) => e.click());
      await awaitMotionStarted(page);
      expect(await travelPositions(page, keys)).toEqual(start);
    }
    for (const time of [0, 8, 16, 32, 64, 100, 140, 160]) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, time);
      samples.push(await travelPositions(page, keys));
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  const end = await travelPositions(page, keys);
  await testInfo.attach('travel', { body: JSON.stringify({ samples, end }), contentType: 'application/json' });
  for (const first of start) {
    const final = end.find(p => p.id === first.id)!;
    expect(first.y - final.y).toBeGreaterThan(100);
    let previous = first.y;
    for (const frame of samples) {
      const y = frame.find(p => p.id === first.id)!.y;
      expect(y, `reversal for ${first.id}`).toBeLessThanOrEqual(previous + .5);
      expect(y).toBeGreaterThanOrEqual(final.y - .5);
      previous = y;
    }
  }
  expect(await page.locator('[data-grid-motion], [data-grid-row-band], [data-grid-band] [data-tile-key]').evaluateAll(elements => elements.every(e => !(e as HTMLElement).style.transform))).toBe(true);
  expect(await page.locator('[data-motion-route-layer]').count()).toBe(0);
  expect(await page.locator('[data-grid-band] .graph').evaluateAll(graphs => graphs.every(graph => {
    const svg = graph.querySelector('svg.edges')!;
    return parseFloat((graph as HTMLElement).style.height) === Number(svg.getAttribute('height'))
      && parseFloat((graph as HTMLElement).style.width) === Number(svg.getAttribute('width'));
  }))).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});

/** Match the settled attachment port, including arrow tips and junction endpoints. */
function expectAttached(scene: Awaited<ReturnType<typeof routeFrame>>, references: Awaited<ReturnType<typeof routeFrame>>[]) {
  let attached = 0;
  for (const route of scene.routes.filter(r => r.opacity > .2 && r.painted)) {
    expect(route.hits, `visible connector crosses a tile: ${route.id}`).toEqual([]);
    expect(route.orphan).toBe(false);
    expect(route.portsVisible, `${route.id} has a clipped endpoint`).toBe(true);
    expect(route.inlinePath, `route ${route.id} interpolates its path`).toBe('');
    for (const [side, endpoint] of [['from', route.source], ['tip', route.target]] as const) {
      if (!endpoint) continue;
      if (endpoint.startsWith('junction:')) {
        const dot = route.endpointDots.filter(d => d.id === endpoint.slice(9)).sort((a, b) => b.opacity - a.opacity)[0];
        if (dot) {
          expect(Math.hypot(route[side].x - dot.x, route[side].y - dot.y), `${route.id} ${side} junction attachment`).toBeLessThanOrEqual(2);
          attached++;
        }
        continue;
      }
      const tile = route.endpointTiles.find(t => t.key === endpoint.slice(5) && t.opacity > .2);
      if (!tile) continue;
      // A trunk's logical target is its source; its end is a branch joint,
      // not a tile port. Check its tile-side endpoint and all terminal tips.
      if (side === 'tip' && route.source === route.target) continue;
      const ports = references.flatMap(reference => {
        const r = reference.routes.find(r => r.id === route.id), t = reference.tiles.find(t => t.key === tile.key);
        return r && t ? [{ x: r[side].x - t.x, y: r[side].y - t.y }] : [];
      });
      expect(ports.length).toBeGreaterThan(0);
      const error = Math.min(...ports.map(p => Math.hypot(route[side].x - tile.x - p.x, route[side].y - tile.y - p.y)));
      expect(error, `${route.id} ${side} tile attachment`).toBeLessThanOrEqual(2);
      attached++;
    }
  }
  return attached;
}

for (const fixture of ['bridge', 'junction']) test(`the connector clock survives main-thread stalls (${fixture})`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, `?bandMotion=${fixture}`, false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`);
  for (const name of ['b', 'a']) { await toggle(name).click(); await settle(page); }
  const b = await key(page, 'stack-b-1');
  const start = await routeFrame(page);
  // First hold and seek the clock so every sample exercises an active
  // route/transform, including the opacity > .2 boundaries of the crossfade.
  const clockScale = 10;
  await holdMotion(page, { rate: 1 / clockScale });
  const frames: Awaited<ReturnType<typeof routeFrame>>[] = [];
  /** Epoch times displayed before and after each stall. */
  const stalled: Array<{ stall: number; before: number; after: number }> = [];
  try {
    await toggle('a').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    for (const time of [0, .01, .1, 16]) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, time);
      frames.push(await routeFrame(page));
    }
    // Resume the already presented early state without rewinding the clock. The slower clock keeps
    // all stalls inside active motion; the frame after each stall shows the time that passed.
    await page.evaluate(async () => {
      (window as any).trace.motion.release();
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    for (const stall of [25, 45, 85]) {
      stalled.push(await page.evaluate(async stall => {
        const motion = (window as any).trace.motion, before = motion.state().running[0].at as number;
        const until = performance.now() + stall;
        while (performance.now() < until) { /* simulate blocked application work */ }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { stall, before, after: motion.state().running[0].at as number };
      }, stall));
      frames.push(await routeFrame(page));
    }
    await page.evaluate(() => (window as any).trace.motion.hold());
    for (const time of [32, 64, 100, 140, 159.9]) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, time);
      frames.push(await routeFrame(page));
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  const end = await routeFrame(page);
  await testInfo.attach('stalled-frames', { body: JSON.stringify({ start, frames, end }), contentType: 'application/json' });
  const by = start.tiles.find(t => t.key === b)!.y, finalY = end.tiles.find(t => t.key === b)!.y;
  expect(by - finalY).toBeGreaterThan(100);
  expect(frames.some(f => { const y = f.tiles.find(t => t.key === b)!.y; return y > finalY + 2 && y < by - 2; })).toBe(true);
  expect(frames.some(f => f.routes.some(r => r.driven))).toBe(true);
  const earlyY = frames[3].tiles.find(t => t.key === b)!.y;
  expect(frames.slice(4, 7).some(f => {
    const y = f.tiles.find(t => t.key === b)!.y;
    return y < earlyY - 1 && y > finalY + 2;
  }), 'the clock advances through the stalls while still inside motion').toBe(true);
  // No stalled time is lost: the frames after a stall show at least the time that passed in it
  // (the clock runs on frame time only, also from a release: review fixes b7673b1, L1).
  for (const { stall, before, after } of stalled) expect(after - before, `${stall} ms stall`).toBeGreaterThanOrEqual(stall / clockScale - .5);
  expect(frames.reduce((n, f) => n + expectAttached(f, [start, end]), 0)).toBeGreaterThan(0);
  expect(await page.locator('[data-motion-route-layer]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});

// Shared tile/edge exit visibility can end very early as the clip reclaims space.
for (const returnAt of [0, .01]) test(`closing a travelling group preserves its displayed tiles and ports before its first frame (return at ${returnAt}ms)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, '?bandMotion=junction', false);
  const toggle = (name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`);
  for (const name of ['b', 'a']) { await toggle(name).click(); await settle(page); }
  const b = await key(page, 'stack-b'), child = await key(page, 'stack-b-merge');
  const start = await routeFrame(page);
  await holdMotion(page);
  try {
    await toggle('a').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    await toggle('b').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    const scene = await routeFrame(page);
    await testInfo.attach('delayed-exit', { body: JSON.stringify({ start, scene }), contentType: 'application/json' });
    const old = start.tiles.find(t => t.key === child)!;
    const copies = scene.tiles.filter(t => t.key === child && t.opacity > .2);
    expect(copies.length).toBe(1);
    expect(copies[0].y).toBeCloseTo(old.y, 1);
    expect(copies[0].bottom).toBeCloseTo(old.bottom, 1);
    expect(expectAttached(scene, [start])).toBeGreaterThan(0);
    if (returnAt) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, returnAt);
    }
    const beforeReturn = await routeFrame(page);
    await toggle('b').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    const reopened = await routeFrame(page);
    const returned = reopened.tiles.find(t => t.key === child && t.opacity > .2)!;
    const captured = beforeReturn.tiles.find(t => t.key === child)!;
    expect(returned.y).toBeCloseTo(captured.y, 1);
    expect(returned.bottom).toBeCloseTo(captured.bottom, 1);
    const visible = expectAttached(reopened, [start]);
    if (!returnAt) expect(visible).toBeGreaterThan(0);
    expect(await page.locator(`[data-grid-exit="${b}"]`).count()).toBe(0);
    if (returnAt) {
      await page.evaluate(async () => {
        (window as any).trace.motion.seek(16);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const partialReturn = await routeFrame(page);
      await toggle('b').evaluate((e: HTMLElement) => e.click());
      await awaitMotionStarted(page);
      await toggle('b').evaluate((e: HTMLElement) => e.click());
      await awaitMotionStarted(page);
      const secondReturn = await routeFrame(page);
      const prior = partialReturn.tiles.find(t => t.key === child)!;
      const current = secondReturn.tiles.find(t => t.key === child)!;
      expect(current.y).toBeCloseTo(prior.y, 1);
      expect(current.bottom).toBeCloseTo(prior.bottom, 1);
      expectAttached(secondReturn, [start]);
    }
    for (const time of [0, .01, 16, 64, 140, 159.9]) {
      await page.evaluate(async time => {
        (window as any).trace.motion.seek(time);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, time);
      expectAttached(await routeFrame(page), [start]);
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  expect(await page.locator('[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]').count()).toBe(0);
  expect(await uncaught(page)).toEqual([]);
});

// Review 099e72f: old connector paths fading inside a band were dropped from the page, mid-fade,
// when a publication closed that band (no band was left to draw them).
test('old connector paths fading in a band keep fading when the band closes', async ({ page }) => {
  await openView(page, 1400);
  /** Connector copies shown (effective opacity > .05) in `scope`: their route ids. Self-contained: it runs in the page. */
  const shown = (scope: string) => page.evaluate(scope => {
    const opacity = (element: Element | null): number => element && element.getAttribute('role') !== 'grid' ? Number(getComputedStyle(element).opacity) * opacity(element.parentElement) : 1;
    return [...document.querySelectorAll<SVGPathElement>(`${scope} path[data-motion-ghost]`)].filter(path => opacity(path) > .05).map(path => path.dataset.motionRoute!).sort();
  }, scope);
  await holdMotion(page);
  try {
    // Closing the first stack repacks its row and reroutes the connectors of the bands that stay
    // open: their old paths fade out in those bands. (A resize would snap.)
    await page.locator('section[data-component]').first().locator('[data-stack-toggle]').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    const cover = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-grid-band]')].find(band => band.querySelector('path[data-motion-ghost]'))?.dataset.gridBand ?? null);
    expect(cover, 'a band with old connector paths fading').not.toBeNull();
    const fading = await shown(`[data-grid-band="${cover}"]`);
    expect(fading.length).toBeGreaterThan(0);
    await page.locator(`[data-grid-cell="${cover}"]`).locator('xpath=ancestor::section[1]').locator('[data-stack-toggle]').evaluate((e: HTMLElement) => e.click());
    await awaitMotionStarted(page);
    expect(await page.locator(`[data-grid-band="${cover}"]`).count()).toBe(0);
    const after = new Set(await shown('[role="grid"]'));
    expect(fading.filter(id => !after.has(id)), 'old paths that vanished mid-fade').toEqual([]);
  } finally { await releaseMotion(page); }
  await settle(page);
  await expect(page.locator('[data-grid-exit], [data-grid-retiring], [data-motion-ghost], [data-motion-route-layer]')).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});
