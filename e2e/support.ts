import { expect, type Locator, type Page } from "@playwright/test";

/** Scenario names used by the fixture (see harness/view-fixture.ts). */
export type Name = string;

export async function openView(page: Page, width?: number, query = ""): Promise<void> {
  await page.goto(`/view.html${query}`);
  await page.waitForFunction(() => !!(window as any).trace);
  if (width) await page.evaluate((w) => (window as any).trace.setWidth(w), width);
  await expect(page.locator("[data-tile-key]").first()).toBeVisible();
  await settle(page);
}

export const key = (page: Page, name: Name): Promise<string> => page.evaluate((n) => (window as any).trace.backend.key(n), name);
export const tile = async (page: Page, name: Name): Promise<Locator> => page.locator(`[data-tile-key="${await key(page, name)}"]`);
export const card = async (page: Page, name: Name): Promise<Locator> => page.locator(`[data-node-key="${await key(page, name)}"]`);
export const state = (page: Page) => page.evaluate(() => (window as any).trace.state() as {
  selected: string[]; cursor: string | null; target: { id: string; title: string; badge: string | null } | null;
  fileView: string | null; opened: string[]; menus: Array<string | null>; navigations: string[];
});
export const uncaught = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).trace.errors]);

/** Waits for layout and motion to finish. Looping spinners are not geometry motion. */
export async function settle(page: Page): Promise<void> {
  const idle = () => document.getAnimations().filter((a) => {
    const target = a.effect && (a.effect as KeyframeEffect).target;
    return !(target instanceof Element && target.closest(".spinner, .title-spinner"));
  }).length === 0;
  await page.waitForFunction(idle);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(idle);
}

export async function click(page: Page, name: Name, options: Parameters<Locator["click"]>[0] = {}): Promise<void> {
  await (await card(page, name)).click(options);
  await settle(page);
}

export interface Box { x: number; y: number; width: number; height: number }

/** Tile boxes keyed by node key, relative to the graph that holds them. */
export function tileBoxes(page: Page, component: number): Promise<Record<string, Box>> {
  return page.evaluate((index) => {
    const section = document.querySelectorAll("section.component[data-component]")[index];
    const graph = section.querySelector(".graph")!.getBoundingClientRect();
    return Object.fromEntries([...section.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => {
      const r = element.getBoundingClientRect();
      return [element.dataset.tileKey!, { x: r.x - graph.x, y: r.y - graph.y, width: r.width, height: r.height }];
    }));
  }, component);
}

export const overlaps = (boxes: Record<string, Box>): Array<[string, string]> => {
  const entries = Object.entries(boxes);
  const found: Array<[string, string]> = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const [a, b] = [entries[i][1], entries[j][1]];
    if (a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5) found.push([entries[i][0], entries[j][0]]);
  }
  return found;
};

/** Names of rendered tiles, optionally limited to those with a given data attribute value. */
export const rendered = (page: Page, attribute?: "size" | "tone", value?: string): Promise<string[]> => page.evaluate(({ attribute, value }) => {
  const b = (window as any).trace.backend;
  const names = ["village", "palette", "mist", "lantern", "daylight", "warm", "cool", "morning", "sunny", "evening", "rain", "merge", "quiet", "forest", "forest-mist", "autumn", "fan", "gen",
    ...Array.from({ length: 18 }, (_, i) => `fan-${i + 1}`)];
  const lookup = new Map(names.map((name) => [b.key(name), name] as const));
  return [...document.querySelectorAll<HTMLElement>("[data-tile-key]")]
    .filter((element) => !attribute || element.dataset[attribute] === value)
    .map((element) => lookup.get(element.dataset.tileKey!) ?? element.dataset.tileKey!).sort();
}, { attribute, value });
