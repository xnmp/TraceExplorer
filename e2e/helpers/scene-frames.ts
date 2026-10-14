/**
 * Whole-scene frame samples for frame-level invariants (used with `sampleFrames`): each mounted
 * tile, cell and connector relative to the grid with its effective opacity, the view's width, and
 * the view's own scene motion (CSS transitions and CSS animations, such as spinners and selection
 * borders, are not scene motion).
 */
import { expect, type Page } from "@playwright/test";
import { settle } from "../support";

/** What one frame shows. Self-contained: it runs in the page. */
export function sceneFrame() {
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]");
  const grid = view?.querySelector<HTMLElement>('[role="grid"]');
  const directory = document.querySelector<HTMLElement>("[data-directory]")?.dataset.directory ?? "";
  const owned = document.getAnimations().filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return !!view && target instanceof Element && view.contains(target) && !(animation instanceof CSSTransition) && !(animation instanceof CSSAnimation)
      && animation.playState !== "finished" && animation.playState !== "idle";
  }).length;
  if (!view || !grid) return { directory, width: view?.clientWidth ?? 0, owned, retirees: 0, clipped: 0, tiles: {}, cells: {}, routes: {} };
  const origin = grid.getBoundingClientRect(), frame = view.getBoundingClientRect();
  const r = (value: number) => Math.round(value * 2) / 2;
  const opacity = (element: Element) => {
    let value = 1;
    for (let at: Element | null = element; at && at !== view; at = at.parentElement) {
      const style = getComputedStyle(at);
      value *= style.visibility === "hidden" || style.display === "none" ? 0 : Number(style.opacity);
    }
    return Math.round(value * 100) / 100;
  };
  const box = (element: Element) => { const b = element.getBoundingClientRect(); return [r(b.left - origin.left), r(b.top - origin.top), r(b.width), r(b.height)]; };
  let clipped = 0;
  const tiles = Object.fromEntries([...grid.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => {
    const b = tile.getBoundingClientRect();
    // A tile cut by the view's right edge: a layout for a wider pane shown in this one.
    if (b.width > 0 && b.right > frame.left + view.clientLeft + view.clientWidth + .5) clipped++;
    return [tile.dataset.tileKey!, [...box(tile), opacity(tile.querySelector(".card") ?? tile)]];
  }));
  const cells = Object.fromEntries([...grid.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => [cell.dataset.gridCell!, [...box(cell), opacity(cell)]]));
  const routes: Record<string, unknown[]> = {};
  for (const path of grid.querySelectorAll<SVGPathElement>("path[data-from][data-to]")) {
    const id = `${path.getAttribute("data-from")}->${path.getAttribute("data-to")}`;
    (routes[id] ??= []).push([...box(path), opacity(path)]);
  }
  const retirees = view.querySelectorAll("[data-grid-exit], [data-motion-ghost], [data-motion-route-layer], [data-ghost-tile-key]").length;
  return { directory, width: view.clientWidth, owned, retirees, clipped, tiles, cells, routes };
}
export type SceneFrame = ReturnType<typeof sceneFrame>;

export const now = (page: Page) => page.evaluate(sceneFrame);
export const drawn = (frame: SceneFrame) => Object.keys(frame.tiles).length > 0;
/** The scene a frame shows, without the bookkeeping that legitimately differs between frames. */
export const scene = ({ tiles, cells, routes }: SceneFrame) => ({ tiles, cells, routes });

/** A frame's scene as text, independent of the order its records were mounted in. */
const canonical = (value: unknown): string => JSON.stringify(value, (_, inner) => inner && typeof inner === "object" && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner);

/** The frames from the first drawn one on; none of them may be blank (a blank frame after a drawn one is a blink). */
function fromFirstDrawn(frames: SceneFrame[], label: string): SceneFrame[] {
  const first = frames.findIndex(drawn);
  expect(first, `${label}: frames drawn`).toBeGreaterThanOrEqual(0);
  const shown = frames.slice(first);
  const blank = shown.flatMap((frame, index) => drawn(frame) ? [] : [index]);
  expect(blank, `${label}: blank frames after the first drawn one`).toEqual([]);
  return shown;
}

/** Once drawn, every frame is motionless and shows `settled`, from the first one on, and none is blank. */
export function expectSnapped(frames: SceneFrame[], settled: SceneFrame, label: string): void {
  const shown = fromFirstDrawn(frames, label);
  expect(scene(shown[0]), `${label}: the first frame drawn is the settled scene`).toEqual(scene(settled));
  for (const [index, frame] of shown.entries()) {
    expect(frame.owned, `${label}: frame ${index} runs scene motion`).toBe(0);
    expect(frame.retirees, `${label}: frame ${index} draws retirees`).toBe(0);
    expect(scene(frame), `${label}: frame ${index}`).toEqual(scene(settled));
  }
}

/**
 * A change laid out off the main thread: once drawn, every frame is motionless and shows `before`
 * until the new scene commits, then `settled` from then on; none is blank and none shows anything else.
 */
export function expectHeldThenSnapped(frames: SceneFrame[], before: SceneFrame, settled: SceneFrame, label: string): void {
  const shown = fromFirstDrawn(frames, label);
  let arrived = false;
  for (const [index, frame] of shown.entries()) {
    expect(frame.owned, `${label}: frame ${index} runs scene motion`).toBe(0);
    expect(frame.retirees, `${label}: frame ${index} draws retirees`).toBe(0);
    arrived ||= canonical(scene(frame)) === canonical(scene(settled));
    expect(scene(frame), `${label}: frame ${index} shows ${arrived ? "the new scene" : "the previous scene until the new one commits"}`).toEqual(scene(arrived ? settled : before));
  }
  expect(scene(shown.at(-1)!), `${label}: the last frame shows the new scene`).toEqual(scene(settled));
}


/**
 * Navigates as the host does while it resolves the new folder's eligibility: the view unmounts
 * (a neutral background for a frame) and a new one mounts on the new folder.
 */
export const navigateRemounting = (page: Page, directory: string) => page.evaluate(async (directory) => {
  const trace = (window as any).trace;
  trace.leaveView();
  trace.navigate(directory);
  await new Promise(requestAnimationFrame);
  trace.enterView();
}, directory);

export const toggleOf = (page: Page, index = 0) => page.locator("section[data-component]").nth(index).locator("[data-stack-toggle]");

/** Opens or closes the `index`th stack and waits for the scene to settle. */
export async function setExpanded(page: Page, index: number, expanded: boolean): Promise<void> {
  const toggle = toggleOf(page, index);
  if ((await toggle.getAttribute("aria-expanded")) !== String(expanded)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
  await settle(page);
}
