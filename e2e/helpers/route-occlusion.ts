import { expect, test } from '@playwright/test';

/** Installed only by frame specs. Called in the same task as each sampled frame. */
function installOcclusionProbe(): void {
  const w = window as any;
  w.__occlusionFaults = [];
  w.__occlusionSamples = 0;
  w.__occlusionOverlaps = 0;
  w.__checkOcclusion = (settled = false) => {
    const grid = document.querySelector<HTMLElement>('[role=grid][aria-label=Folder]');
    if (!grid) return;
    w.__occlusionSamples++;
    const opacity = (element: Element) => {
      let alpha = 1;
      for (let e: Element | null = element; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
      return alpha;
    };
    const tiles = [...grid.querySelectorAll<HTMLElement>('[data-tile-key], [data-ghost-tile-key], [data-grid-cell]:not(.stack)')]
      .map(element => ({ element, rect: element.getBoundingClientRect(), alpha: opacity(element),
        key: element.dataset.tileKey ?? element.dataset.ghostTileKey ?? element.dataset.gridCell! }));
    const routes = [...grid.querySelectorAll<SVGPathElement>('path[data-route], path[data-motion-route]')].filter(p => opacity(p) > .001);
    // Hit testing normally excludes passive routes and inert ghosts. Enable their hit regions
    // synchronously for this read, then restore before the browser can paint or dispatch input.
    const inert = [...grid.querySelectorAll<HTMLElement>('[inert]')];
    const elements = [...routes, ...tiles.map(t => t.element)];
    const previous = elements.map(e => [e.style.getPropertyValue('pointer-events'), e.style.getPropertyPriority('pointer-events')] as const);
    inert.forEach(e => e.removeAttribute('inert'));
    elements.forEach(e => e.style.setProperty('pointer-events', 'auto', 'important'));
    try {
      const alphaOf = (color: string): number => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
      };
      for (const path of routes) {
        const box = path.getBoundingClientRect();
        const candidates = tiles.filter(t => t.alpha > .999 && t.rect.left < box.right && t.rect.right > box.left && t.rect.top < box.bottom && t.rect.bottom > box.top);
        if (!candidates.length) continue;
        const length = path.getTotalLength(), matrix = path.getScreenCTM();
        if (!matrix) continue;
        for (let distance = 0; distance <= length; distance += 2) {
          const point = path.getPointAtLength(distance), p = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) continue;
          for (const tile of candidates) {
            const b = tile.rect;
            if (p.x <= b.left + 1 || p.x >= b.right - 1 || p.y <= b.top + 1 || p.y >= b.bottom - 1) continue;
            const stack = document.elementsFromPoint(p.x, p.y);
            // Clipped route/tile fragments aren't painted at this point.
            const routeIndex = stack.indexOf(path), tileIndex = stack.findIndex(e => e === tile.element || tile.element.contains(e));
            if (routeIndex < 0 || tileIndex < 0) continue;
            w.__occlusionOverlaps++;
            const style = getComputedStyle(tile.element);
            const fault = settled ? 'settled overlap' : tileIndex > routeIndex ? 'route above tile'
              : alphaOf(style.backgroundColor) < 1 ? 'translucent tile surface' : null;
            if (fault && w.__occlusionFaults.length < 20) w.__occlusionFaults.push({ fault, route: path.dataset.route ?? path.dataset.motionRoute, tile: tile.key, x: p.x, y: p.y });
          }
        }
      }
    } finally {
      elements.forEach((e, i) => previous[i][0] ? e.style.setProperty('pointer-events', ...previous[i]) : e.style.removeProperty('pointer-events'));
      inert.forEach(e => e.setAttribute('inert', ''));
    }
  };
}

export function checkRouteOcclusionFrames(): void {
  test.beforeEach(async ({ page }) => { await page.addInitScript(installOcclusionProbe); });
  test.afterEach(async ({ page }) => {
    if (page.isClosed()) return;
    const faults = await page.evaluate(() => (window as any).__occlusionFaults ?? []);
    expect(faults, 'opaque tiles must paint above every crossing route; settled routes must be clear').toEqual([]);
  });
}
