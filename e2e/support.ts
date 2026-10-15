import { expect, test, type Locator, type Page } from "@playwright/test";

/** Scenario names used by the fixture (see harness/view-fixture.ts). */
export type Name = string;

export async function openView(page: Page, width?: number, query = "", expand = true): Promise<void> {
  const parameters = new URLSearchParams(query);
  if (width) parameters.set("width", String(width));
  await page.goto(`/view.html${parameters.size ? `?${parameters}` : ""}`);
  await page.waitForFunction(() => !!(window as any).trace);
  // The first tiles wait on the layout worker (an inline blob worker) and the
  // folder session, on top of the module graph that the Vite dev server
  // transforms on the first request. On a starved machine (load far above the
  // core count) that takes well over the 5 s default `expect` timeout; it is
  // not product latency, so only this wait is extended, not timeouts globally.
  // The test's own budget grows by the same amount, so a slow start does not eat it.
  test.info().setTimeout(test.info().timeout + FIRST_TILES_TIMEOUT_MS);
  await expect(page.locator("[data-tile-key]").first()).toBeVisible({ timeout: FIRST_TILES_TIMEOUT_MS });
  await settle(page);
  if (expand) {
    const stacks = page.locator("section[data-component]");
    for (let i = 0; i < Math.min(3, await stacks.count()); i++) await ensureExpanded(stacks.nth(i));
    await page.getByTestId("trace-view").click({ position: { x: 2, y: 2 } });
    await settle(page);
  }
}

const FIRST_TILES_TIMEOUT_MS = 20_000;

export const key = (page: Page, name: Name): Promise<string> => page.evaluate((n) => (window as any).trace.backend.key(n), name);
export const tile = async (page: Page, name: Name): Promise<Locator> => page.locator(`[data-tile-key="${await key(page, name)}"], [data-reference-key="${await key(page, name)}"]`).first();
export const card = async (page: Page, name: Name): Promise<Locator> => page.locator(`[data-node-key="${await key(page, name)}"], [data-reference-key="${await key(page, name)}"]`).first();
/** A tile's disclosure caret: expands or collapses that node without changing the selection. */
export const caret = async (page: Page, name: Name): Promise<Locator> => page.locator(`[data-node-caret="${await key(page, name)}"]`);
export const state = (page: Page) => page.evaluate(() => (window as any).trace.state() as {
  selected: string[]; inputs: string[]; cursor: string | null; target: { id: string; title: string; badge: string | null } | null;
  fileView: string | null; opened: string[]; menus: Array<string | null>; navigations: string[];
});
export const uncaught = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).trace.errors]);

/**
 * Waits for layout and motion to finish: no layout queued or computing, no scene
 * motion running (the motion driver idle) and no other animation, for several consecutive frames, so a layout that a
 * final scroll or reveal starts late is waited for too. Looping spinners are
 * not geometry motion.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__settleStreak = 0; });
  await page.waitForFunction(() => {
    const animating = document.getAnimations().some((a) => {
      const target = a.effect && (a.effect as KeyframeEffect).target;
      return !(target instanceof Element && target.closest(".spinner, .title-spinner"));
    }) || ((window as any).trace?.motion?.state().running.length ?? 0) > 0;
    // A layout still queued or computing (the worker is slow on a loaded machine) has started no motion yet.
    const laying = ((window as any).trace?.layoutsPending?.() ?? 0) > 0;
    const w = window as any;
    w.__settleStreak = animating || laying ? 0 : w.__settleStreak + 1;
    return w.__settleStreak >= 4;
  }, undefined, { polling: "raf" });
}

export async function click(page: Page, name: Name, options: Parameters<Locator["click"]>[0] = {}): Promise<void> {
  await (await card(page, name)).click(options);
  await settle(page);
}

/** Open a stack without depending on the folder's default expansion state. */
export async function ensureExpanded(section: Locator): Promise<void> {
  const heading = section.locator("[data-stack-toggle]");
  await expect(heading).toHaveAttribute("aria-expanded", /^(true|false)$/);
  if (await heading.getAttribute("aria-expanded") === "false") await heading.click();
  await expect(heading).toHaveAttribute("aria-expanded", "true");
  await settle(section.page());
}

export interface Box { x: number; y: number; width: number; height: number }

/** Tile boxes keyed by node key, relative to the graph that holds them. */
export function tileBoxes(page: Page, component: number | Name): Promise<Record<string, Box>> {
  return page.evaluate((index) => {
    const sections = [...document.querySelectorAll("section.component[data-component]")];
    const section = typeof index === "number" ? sections[index] : sections.find((element) =>
      element.querySelector(`[data-tile-key="${CSS.escape((window as any).trace.backend.key(index))}"]`))!;
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
export const rendered = (page: Page, attribute?: "tone", value?: string): Promise<string[]> => page.evaluate(({ attribute, value }) => {
  const b = (window as any).trace.backend;
  const names = ["village", "palette", "mist", "lantern", "daylight", "warm", "cool", "morning", "sunny", "evening", "rain", "merge", "quiet", "dawn", "noon", "dusk", "forest", "forest-mist", "autumn", "fan", "gen",
    ...Array.from({ length: 18 }, (_, i) => `fan-${i + 1}`)];
  const lookup = new Map(names.map((name) => [b.key(name), name] as const));
  return [...document.querySelectorAll<HTMLElement>("[data-tile-key]")]
    .filter((element) => !attribute || element.dataset[attribute] === value)
    .map((element) => lookup.get(element.dataset.tileKey!) ?? element.dataset.tileKey!).sort();
}, { attribute, value });

/** Opens a themed Select and clicks the option whose label or `data-value` is `choice`. */
export async function pickOption(combobox: Locator, choice: string): Promise<void> {
  await combobox.click();
  const page = combobox.page();
  const option = page.locator(`[role="option"][data-value=${JSON.stringify(choice)}]`).or(page.getByRole("option", { name: choice, exact: true })).first();
  await option.click();
  await expect(combobox).toHaveAttribute("aria-expanded", "false");
}
