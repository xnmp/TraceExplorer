import { checkRouteOcclusionFrames } from "./helpers/route-occlusion";
import { test, expect, type Page } from "@playwright/test";
import { awaitMotionStarted, holdMotion, releaseMotion, seekMotion } from "./animation-control";
import { byTransaction, clearSceneEvents, sampleFrames, sceneEvents } from "./helpers/scene-events";
import { openView, settle, uncaught } from "./support";

checkRouteOcclusionFrames();

/**
 * Interrupting motion (docs/scene-transactions.md §6): a publication that arrives while another
 * presentation is moving continues from exactly what is displayed. Its first frame shows every
 * tile and connector where, and as opaque as, it was (within half a CSS pixel and 0.01 opacity),
 * with visible connectors attached to their tiles, whether the interrupted motion had shown a frame
 * yet or not. Each action starts motion once.
 */

/** `top` and `bottom`: what its clips leave visible (`top` may exceed `bottom`: all hidden). */
interface Shown { key: string; live: boolean; x: number; y: number; width: number; top: number; bottom: number; opacity: number }
/** `shown`: the vertical window its clipping ancestors leave visible (screen pixels). */
interface Connector { id: string; source: string; target: string; from: { x: number; y: number }; tip: { x: number; y: number }; opacity: number; shown: { top: number; bottom: number } }
interface Displayed { tiles: Shown[]; routes: Connector[] }

/** What is displayed: every tile and connector instance, live or retiring, in screen pixels, with its effective opacity and clip. */
const displayed = (page: Page): Promise<Displayed> => page.evaluate(() => {
  (window as any).__checkOcclusion?.();
  const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
  /** The visible span under its own clip and every clipping ancestor's (clip paths are inset() or absolute polygon()). */
  const clipped = (element: Element, top: number, bottom: number, from: Element | null = element) => {
    for (let at: Element | null = from; at; at = at.parentElement) {
      const style = getComputedStyle(at), box = at.getBoundingClientRect();
      const inset = /^inset\(([^)]*)\)/.exec(style.clipPath), polygon = /^polygon\(([^)]*)\)/.exec(style.clipPath);
      if (inset) { const v = inset[1].split(/\s+/).map(parseFloat); top = Math.max(top, box.top + v[0]); bottom = Math.min(bottom, box.bottom - v[2 % v.length]); }
      if (polygon) {
        const ys = polygon[1].split(",").map((p) => parseFloat(p.trim().split(/\s+/)[1]));
        top = Math.max(top, box.top + Math.min(...ys)); bottom = Math.min(bottom, box.top + Math.max(...ys));
      }
    }
    return { top, bottom };
  };
  const tiles = [...document.querySelectorAll<HTMLElement>("[data-tile-key], [data-ghost-tile-key]")].map((element) => {
    const box = element.getBoundingClientRect(), { top, bottom } = clipped(element, box.top, box.bottom);
    return { key: element.dataset.tileKey ?? element.dataset.ghostTileKey!, live: !!element.dataset.tileKey, x: box.x, y: box.y, width: box.width,
      top, bottom, opacity: opacity(element) };
  });
  const routes = [...document.querySelectorAll<SVGPathElement>("path[data-route], path[data-motion-route]")].map((path) => {
    const matrix = path.getScreenCTM()!, scale = Math.hypot(matrix.a, matrix.b), length = path.getTotalLength();
    const point = (distance: number) => { const p = path.getPointAtLength(distance), s = new DOMPoint(p.x, p.y).matrixTransform(matrix); return { x: s.x, y: s.y }; };
    const from = point(0), end = point(length), near = point(Math.max(0, length - 1 / scale));
    const arrow = path.hasAttribute("marker-end") ? 8 * scale : 0, tangent = Math.hypot(end.x - near.x, end.y - near.y) || 1;
    return { id: path.dataset.route ?? path.dataset.motionRoute!, source: path.dataset.from ?? path.dataset.motionFrom ?? "", target: path.dataset.to ?? path.dataset.motionTo ?? "",
      from, tip: { x: end.x + arrow * (end.x - near.x) / tangent, y: end.y + arrow * (end.y - near.y) / tangent }, opacity: opacity(path),
      shown: clipped(path, -Infinity, Infinity, path.parentElement) };
  });
  return { tiles, routes };
});

const PX = .5, ALPHA = .01;
const near = (a: number, b: number, tolerance = PX) => Math.abs(a - b) <= tolerance;

/** Every tile and connector displayed before is displayed the same way after (by one of its instances). */
function expectContinuous(before: Displayed, after: Displayed, label: string, { opacity = true } = {}): number {
  let checked = 0;
  for (const shown of before.tiles) {
    if (shown.opacity <= ALPHA) continue;
    const same = after.tiles.filter((t) => t.key === shown.key).some((t) => near(t.x, shown.x) && near(t.y, shown.y) && near(t.width, shown.width)
      && near(Math.max(t.y, t.bottom), Math.max(shown.y, shown.bottom)) && (!opacity || near(t.opacity, shown.opacity, ALPHA)));
    expect(same, `${label}: tile ${shown.key} ${JSON.stringify({ shown, after: after.tiles.filter((t) => t.key === shown.key) })}`).toBe(true);
    checked++;
  }
  for (const shown of before.routes) {
    if (shown.opacity <= ALPHA) continue;
    const same = after.routes.filter((r) => r.id === shown.id).some((r) => near(r.from.x, shown.from.x) && near(r.from.y, shown.from.y)
      && near(r.tip.x, shown.tip.x) && near(r.tip.y, shown.tip.y) && (!opacity || near(r.opacity, shown.opacity, ALPHA)));
    expect(same, `${label}: connector ${shown.id} ${JSON.stringify({ shown, after: after.routes.filter((r) => r.id === shown.id) })}`).toBe(true);
    checked++;
  }
  return checked;
}

/**
 * Visible connectors end on visible tiles: each tile endpoint lies on (within 2px of) the visible
 * part of its tile's box. A tile or connector whose clips hide all of it is not visible. Where a clip
 * hides an endpoint, the connector's visible end is at the clip's edge, which must lie on the tile
 * instead. (A closing band slides up under its cover, hiding tiles there; their connectors show
 * from the cover's bottom edge.)
 */
function expectAttached(scene: Displayed, label: string): number {
  const onBox = (p: { x: number; y: number }, t: Shown) => {
    const dx = Math.max(t.x - p.x, 0, p.x - (t.x + t.width)), dy = Math.max(t.top - p.y, 0, p.y - t.bottom);
    const outside = Math.hypot(dx, dy);
    const inside = Math.min(p.x - t.x, t.x + t.width - p.x, p.y - t.top, t.bottom - p.y);
    return outside > 0 ? outside : inside;
  };
  let attached = 0;
  const visible = (r: Connector) => r.opacity > .2 && Math.max(r.from.y, r.tip.y) > r.shown.top && Math.min(r.from.y, r.tip.y) < r.shown.bottom;
  for (const route of scene.routes.filter(visible)) for (const [end, shownAt] of [[route.source, route.from], [route.target, route.tip]] as const) {
    if (!end.startsWith("node:") || route.source === route.target) continue;
    const point = { x: shownAt.x, y: Math.min(Math.max(shownAt.y, route.shown.top), route.shown.bottom) };
    const tiles = scene.tiles.filter((t) => t.key === end.slice(5) && t.opacity > .2 && t.top < t.bottom);
    if (!tiles.length) continue;
    expect(Math.min(...tiles.map((t) => onBox(point, t))), `${label}: ${route.id} ${end} ${JSON.stringify({ point, tiles })}`).toBeLessThanOrEqual(2);
    attached++;
  }
  return attached;
}

const seek = seekMotion;

const toggle = (page: Page, name: string) => page.locator(`section[aria-label="stack-${name}"] [data-stack-toggle]`)
  .evaluate((element: HTMLElement) => element.click());

/**
 * Each action published geometry once and started motion at most once; one that leaves nothing to move
 * (interrupted before anything was displayed moving, back to where it began) settles without starting.
 */
async function expectOneMotionPerAction(page: Page, actions: number): Promise<void> {
  const events = await sceneEvents(page, "geometry-publication", "motion-start", "settled");
  const transactions = [...byTransaction(events)].filter(([, own]) => own.some((e) => e.kind === "geometry-publication"));
  expect(transactions, JSON.stringify(events)).toHaveLength(actions);
  for (const [transaction, own] of transactions) {
    expect(own.filter((e) => e.kind === "geometry-publication").length, `transaction ${transaction}`).toBe(1);
    const starts = own.filter((e) => e.kind === "motion-start").length;
    expect(starts, `transaction ${transaction}`).toBeLessThanOrEqual(1);
    if (!starts) expect(own.map((e) => e.kind), `transaction ${transaction} neither moved nor settled`).toContain("settled");
  }
}

const scenarios = [
  { name: "an expansion", setup: [] as string[], first: "b", second: "b" },
  { name: "a collapse", setup: ["b"], first: "b", second: "b" },
  { name: "a reopening", setup: ["b"], first: "b", second: "b", third: "b" },
  { name: "a reflow of another band", setup: ["b"], first: "a", second: "a" },
];

for (const scenario of scenarios) for (const at of ["before its first frame", .01, 40, 100] as const) {
  test(`interrupting ${scenario.name} ${typeof at === "number" ? `at ${at} ms` : at} continues from what is displayed`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 1300 });
    await openView(page, 390, "?bandMotion=junction", false);
    for (const name of scenario.setup) { await toggle(page, name); await settle(page); }
    const settledScene = await displayed(page);
    await clearSceneEvents(page);
    // Held, an epoch shows its first pose until seeked: as before the driver's first frame.
    const delayed = at === "before its first frame";
    await holdMotion(page);
    try {
      const actions = [scenario.first, scenario.second, ...(scenario.third ? [scenario.third] : [])];
      await toggle(page, actions[0]);
      await awaitMotionStarted(page);
      if (typeof at === "number") await seek(page, at);
      let previous = await displayed(page);
      // An action may restyle at once (focus and relatedness), but nothing moves before its motion runs.
      if (delayed) expectContinuous(settledScene, previous, "a motion shows its first pose before its first frame", { opacity: false });
      for (const [index, action] of actions.slice(1).entries()) {
        await toggle(page, action);
        await awaitMotionStarted(page);
        const replaced = await displayed(page);
        expect(expectContinuous(previous, replaced, `interruption ${index + 1}`)).toBeGreaterThan(0);
        expectAttached(replaced, `interruption ${index + 1}`);
        if (delayed) {
          // The replacement's first frame (its clock's start) changes nothing displayed.
          await seek(page, 0);
          expectContinuous(replaced, await displayed(page), `first frame ${index + 1}`);
        }
        previous = replaced;
      }
      for (const time of [0, 16, 48, 96, 159.9]) {
        await seek(page, time);
        expectAttached(await displayed(page), `${time} ms`);
      }
      await expectOneMotionPerAction(page, actions.length);
    } finally { await releaseMotion(page); }
    await settle(page);
    await expect(page.locator("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]")).toHaveCount(0);
    expect(await uncaught(page)).toEqual([]);
  });
}

test("rapid toggles at native speed never show a tile twice and leave nothing behind", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 1300 });
  await openView(page, 390, "?bandMotion=junction", false);
  await toggle(page, "a"); await settle(page);
  await clearSceneEvents(page);
  const frames = await sampleFrames(page, () => {
    const counts: Record<string, number> = {};
    for (const element of document.querySelectorAll<HTMLElement>("[data-tile-key], [data-ghost-tile-key]")) {
      let value = 1;
      for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity);
      const key = element.dataset.tileKey ?? element.dataset.ghostTileKey!;
      if (value > .01) counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts).filter(([, count]) => count > 1).map(([key]) => key);
  }, 700, async () => {
    for (const delay of [0, 50, 50, 70]) {
      await page.waitForTimeout(delay);
      await toggle(page, "b");
    }
  });
  expect(frames.length).toBeGreaterThan(10);
  expect(frames.flat(), "a tile shown twice in one frame").toEqual([]);
  await settle(page);
  await expectOneMotionPerAction(page, 4);
  await expect(page.locator("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});
