import { test, expect } from "@playwright/test";
import { openView, key, settle } from "./support";

for (const scene of ["deep", "wrapped"] as const) test(`compact ${scene} band`, async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await openView(page, scene === "deep" ? 1150 : 625, `?layout=${scene}&fileTile=1&tileSize=${scene === "deep" ? "large" : "xlarge"}`, false);
  const covers = await page.locator("[data-grid-cell]").evaluateAll((els) => els.map(el => ({ id: (el as HTMLElement).dataset.gridCell, x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })));
  const firstRow = covers.filter((cell) => cell.y === covers[0].y);
  expect(firstRow.length).toBe(scene === "deep" ? 7 : 3);
  expect(firstRow[scene === "deep" ? 5 : 2].id).toBe(await key(page, scene === "deep" ? "deep" : "stack-b"));
  for (const name of scene === "deep" ? ["deep"] : ["stack-a", "stack-b"]) {
    await page.locator(`section[aria-label="${name}"] [data-stack-toggle]`).click(); await settle(page);
  }
  if (scene === "deep") {
    await page.evaluate(() => (window as any).trace.selectPath(`/pictures/Ash.png`)); await settle(page);
  }
  const band = page.locator("[data-grid-row-band]").first();
  const height = (await band.boundingBox())!.height;
  console.log(`LAYOUT ${scene} band height: ${height}px`);
  await page.screenshot({ path: test.info().outputPath(`layout-${scene}-${process.env.LAYOUT_BASELINE ? "before" : "after"}.png`) });
  if (process.env.LAYOUT_BASELINE) return;
  expect(height).toBeLessThanOrEqual(scene === "deep" ? 340 : 390);
  const relationships = scene === "deep" ? [["deep", "Cerulean"], ["deep", "Saffron"], ["Saffron", "Blastoise"], ["Saffron", "Ash"], ["Ash", "Charizard"]]
    : [["stack-a", "stack-a-1"], ["stack-a", "stack-a-2"], ["stack-b", "stack-b-1"], ["stack-b", "stack-b-2"]];
  const edges = await Promise.all(relationships.map(async ([parent, child]) => [await key(page, parent), await key(page, child)]));
  const geometry = await page.evaluate((edges) => {
    const tiles = new Map([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((el) => [el.dataset.tileKey!, el.getBoundingClientRect()]));
    const crossings: string[] = [], overlaps: string[] = [], wrongParents: string[] = [], sharing: string[] = [];
    const runs: { source: string; axis: string; coordinate: number; low: number; high: number }[] = [];
    for (const [id, a] of tiles) for (const [other, b] of tiles) if (id < other && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push(`${id}/${other}`);
    const routes = [...document.querySelectorAll<SVGPathElement>("path[data-route]")].map((el) => {
      const matrix = el.getScreenCTM()!, length = el.getTotalLength();
      const screen = (distance: number) => { const p = el.getPointAtLength(distance); return new DOMPoint(p.x, p.y).matrixTransform(matrix); };
      let previous: DOMPoint | undefined;
      for (let i = 0; i <= Math.ceil(length); i++) {
        const p = screen(length * i / Math.max(1, Math.ceil(length)));
        for (const [id, box] of tiles) if (p.x > box.left + 1 && p.x < box.right - 1 && p.y > box.top + 1 && p.y < box.bottom - 1) crossings.push(`${el.dataset.route}/${id}`);
        if (previous) {
          const vertical = Math.abs(p.x - previous.x) < .01 && Math.abs(p.y - previous.y) > .1;
          const horizontal = Math.abs(p.y - previous.y) < .01 && Math.abs(p.x - previous.x) > .1;
          if (vertical || horizontal) {
            const run = { source: el.dataset.from!, axis: vertical ? "y" : "x", coordinate: vertical ? p.x : p.y,
              low: Math.min(vertical ? p.y : p.x, vertical ? previous.y : previous.x), high: Math.max(vertical ? p.y : p.x, vertical ? previous.y : previous.x) };
            const last = runs.at(-1);
            if (last && last.source === run.source && last.axis === run.axis && Math.abs(last.coordinate - run.coordinate) < .1 && run.low <= last.high + .1 && run.high >= last.low - .1) {
              last.low = Math.min(last.low, run.low); last.high = Math.max(last.high, run.high);
            } else runs.push(run);
          }
        }
        previous = p;
      }
      return { from: el.dataset.from, to: el.dataset.to, terminal: el.hasAttribute("marker-end"), start: screen(0), end: screen(length), before: screen(Math.max(0, length - 1)) };
    });
    for (const [i, a] of runs.entries()) for (const b of runs.slice(i + 1)) if (a.source !== b.source && a.axis === b.axis
      && Math.abs(a.coordinate - b.coordinate) < .5 && Math.min(a.high, b.high) - Math.max(a.low, b.low) > 3) sharing.push(`${a.source}/${b.source}`);
    const near = (a: DOMPoint, b: DOMPoint) => Math.hypot(a.x - b.x, a.y - b.y) < 1;
    for (const [parent, child] of edges) {
      const terminals = routes.filter((route) => route.terminal && route.to === `node:${child}`);
      if (terminals.length !== 1 || terminals[0].from !== `node:${parent}`) { wrongParents.push(`${parent}>${child}: terminal`); continue; }
      const box = tiles.get(parent)!;
      // Trunk segments start at the tile; terminal branches may begin at the trunk's end.
      const pending = [terminals[0]], seen = new Set<typeof terminals[0]>();
      let startsAtParent = false;
      while (pending.length) {
        const route = pending.pop()!;
        if (seen.has(route)) continue; seen.add(route);
        const p = route.start;
        if ((Math.abs(p.y - box.bottom) < 1 && p.x >= box.left && p.x <= box.right) || (Math.abs(p.x - box.right) < 1 && p.y >= box.top && p.y <= box.bottom)) startsAtParent = true;
        pending.push(...routes.filter((other) => other.from === `node:${parent}` && near(other.end, p)));
      }
      if (!startsAtParent) wrongParents.push(`${parent}>${child}: source`);
      const terminal = terminals[0], target = tiles.get(child)!;
      const dx = terminal.end.x - terminal.before.x, dy = terminal.end.y - terminal.before.y, magnitude = Math.hypot(dx, dy);
      const tip = { x: terminal.end.x + 8 * dx / magnitude, y: terminal.end.y + 8 * dy / magnitude };
      if (!((Math.abs(tip.x - target.left) < 1 && tip.y >= target.top && tip.y <= target.bottom) || (Math.abs(tip.y - target.top) < 1 && tip.x >= target.left && tip.x <= target.right))) wrongParents.push(`${parent}>${child}: arrow`);
    }
    return { crossings: [...new Set(crossings)], overlaps, wrongParents, sharing: [...new Set(sharing)] };
  }, edges);
  expect(geometry).toEqual({ crossings: [], overlaps: [], wrongParents: [], sharing: [] });
  for (const before of covers) {
    const after = (await page.locator(`[data-grid-cell="${before.id}"]`).boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 1);
    if (before.y === covers[0].y) expect(after.y).toBeCloseTo(before.y, 1);
  }
  if (scene === "deep") {
    const visible = await page.locator("[data-grid-band] [data-tile-key]").evaluateAll((els) => els.map((el) => ({ id: (el as HTMLElement).dataset.tileKey!, x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })));
    await page.evaluate(() => (window as any).trace.selectPath("/pictures/Charizard.png")); await settle(page);
    for (const before of visible) {
      const target = page.locator(`[data-tile-key="${before.id}"]`);
      if (!await target.count()) continue;
      const after = (await target.boundingBox())!;
      expect(after.x).toBeCloseTo(before.x, 1); expect(after.y).toBeCloseTo(before.y, 1);
    }
    await page.evaluate(() => (window as any).trace.setWidth(1151)); await settle(page);
    expect((await band.boundingBox())!.height).toBeCloseTo(height, 1);
  }
});
