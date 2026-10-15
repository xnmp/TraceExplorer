/**
 * Explicit expansion (docs/trace-view-layout.md, "Interaction model"), on the user's recording's
 * topology (`?selectionBlink=1`): a stack with Cerulean (→ Pikachu's Ball) and Saffron
 * (→ Blastoise, Ash → Charizard). A first click on an unselected tile selects it and opens its
 * children; a second click on the selected tile, or its caret, toggles them; selecting a leaf or
 * an expanded node changes no geometry at all. Frames are read at the last moment before they
 * paint (`samplePaintedFrames`).
 */
import { test, expect, type Page } from "@playwright/test";
import { card, caret, key, openView, settle, state, uncaught } from "./support";
import { samplePaintedFrames } from "./helpers/scene-events";
import { sceneFrame, type SceneFrame } from "./helpers/scene-frames";
import { awaitMotionStarted, holdMotion, releaseMotion, seekMotion } from "./animation-control";

const NAMES = ["stack", "Cerulean", "Saffron", "Pikachu's Ball", "Blastoise", "Ash", "Charizard"] as const;
type Name = (typeof NAMES)[number];
const path = (name: Name) => `/pictures/${name}.png`;

/** A painted frame: the scene (`sceneFrame`), each retiring tile's effective visibility (opacity × shown fraction), Saffron's caption and the motion count. */
type Frame = SceneFrame & { ghosts: Record<string, number>; caption: string | null; started: number };

async function open(page: Page): Promise<Record<Name, string>> {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openView(page, 900, "?selectionBlink=1", false);
  await page.evaluate((source) => { (window as any).__sceneFrame = new Function(`return (${source})`)(); }, sceneFrame.toString());
  await page.locator("[data-stack-toggle]").click();
  await settle(page);
  return Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await key(page, name)]))) as Record<Name, string>;
}

/** Every painted frame from just before `action` until `duration` ms later, then waits for the scene to settle. */
async function framesOf(page: Page, action: () => Promise<void>, duration = 600): Promise<Frame[]> {
  const frames = await samplePaintedFrames(page, () => {
    const w = window as any, frame = w.__sceneFrame();
    const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
    /** The fraction of a retiring tile its clips show (an exit group's polygon, or its own). */
    const shown = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      let top = box.top, bottom = box.bottom;
      for (let at: HTMLElement | null = element; at; at = at.parentElement) {
        const polygon = /^polygon\(([^)]*)\)/.exec(getComputedStyle(at).clipPath);
        if (!polygon) continue;
        const ys = polygon[1].split(",").map((point) => parseFloat(point.trim().split(/\s+/)[1])), origin = at.getBoundingClientRect().top;
        top = Math.max(top, origin + Math.min(...ys)); bottom = Math.min(bottom, origin + Math.max(...ys));
      }
      return box.height > 0 ? Math.max(0, bottom - top) / box.height : 0;
    };
    frame.ghosts = Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-ghost-tile-key]")]
      .map((ghost) => [ghost.dataset.ghostTileKey!, Math.round(opacity(ghost) * shown(ghost) * 100) / 100]));
    const saffron = document.querySelector<HTMLElement>(`[data-tile-key="${w.trace.backend.key("Saffron")}"]`);
    frame.caption = saffron ? saffron.innerText : null;
    frame.started = w.trace.motion.state().started;
    return frame;
  }, duration, action);
  await settle(page);
  return frames as Frame[];
}

const press = (page: Page, name: Name) => async () => { await (await card(page, name)).click(); };
const pressCaret = (page: Page, name: Name) => async () => { await (await caret(page, name)).click(); };
const now = (page: Page): Promise<SceneFrame> => page.evaluate(() => (window as any).__sceneFrame());
/** The rectangles a frame draws: every tile and connector, without opacity (selection restyles). */
const geometry = ({ tiles, routes }: SceneFrame) => ({
  tiles: Object.fromEntries(Object.entries(tiles).map(([k, v]) => [k, (v as number[]).slice(0, 4)])),
  routes: Object.fromEntries(Object.entries(routes).map(([k, list]) => [k, (list as number[][]).map((v) => v.slice(0, 4))])),
});
const drawn = (frame: SceneFrame, tileKey: string) => frame.tiles[tileKey] !== undefined;
const opacityOf = (frame: SceneFrame, tileKey: string) => (frame.tiles[tileKey] as number[] | undefined)?.[4] ?? 0;
const between = (value: number) => value > .02 && value < .98;

/** No frame is blank, and no frame drops a tile that frames before and after it draw. */
function expectSteady(frames: Frame[], label: string): void {
  frames.forEach((frame, index) => expect(Object.keys(frame.tiles).length, `${label}: frame ${index} is drawn`).toBeGreaterThan(0));
  for (let i = 1; i + 1 < frames.length; i++) for (const tileKey of Object.keys(frames[i - 1].tiles))
    if (frames.slice(i + 1).some((later) => drawn(later, tileKey))) expect(drawn(frames[i], tileKey), `${label}: ${tileKey} blinks at frame ${i}`).toBe(true);
}

/** A motion started for the action, and at least two frames show a pose part-way. */
function expectAnimated(frames: Frame[], label: string, partWay: (frame: Frame) => boolean): void {
  expect(frames.at(-1)!.started, `${label}: a motion epoch started`).toBeGreaterThan(frames[0].started);
  expect(frames.filter(partWay).length, `${label}: frames part-way`).toBeGreaterThanOrEqual(2);
}

const arriving = (keys: string[]) => (frame: Frame) => keys.some((k) => drawn(frame, k) && between(opacityOf(frame, k)));
const leaving = (keys: string[]) => (frame: Frame) => keys.some((k) => frame.ghosts[k] !== undefined && between(frame.ghosts[k]));

test("the recording: with a sibling branch open, selecting a leaf and then its expanded parent moves nothing on any frame", async ({ page }) => {
  const keys = await open(page);
  for (const name of ["Saffron", "Ash", "Cerulean"] as const) { await press(page, name)(); await settle(page); }
  for (const name of ["Blastoise", "Charizard", "Pikachu's Ball"] as const) await expect(page.locator(`[data-tile-key="${keys[name]}"]`)).toHaveCount(1);
  for (const name of ["Charizard", "Ash", "Saffron"] as const) {
    const frames = await framesOf(page, press(page, name));
    const [before] = frames;
    expect((await state(page)).selected, `${name} is the selection`).toEqual([path(name)]);
    expect(frames.at(-1)!.started, `${name}: no motion`).toBe(before.started);
    expect(before.caption).toBeTruthy();
    frames.forEach((frame, index) => {
      expect(geometry(frame), `${name}: frame ${index}`).toEqual(geometry(before));
      expect(frame.retirees, `${name}: frame ${index} draws no retiring copy`).toBe(0);
      expect(frame.caption, `${name}: frame ${index}, Saffron's caption`).toBe(before.caption);
    });
  }
  expect(await uncaught(page)).toEqual([]);
});

test("a first click on a collapsed node opens its children with motion and leaves the other branch as it was", async ({ page }) => {
  const keys = await open(page);
  await press(page, "Saffron")();
  await settle(page);
  const before = geometry(await now(page));
  await holdMotion(page);
  try {
    await press(page, "Cerulean")();
    await awaitMotionStarted(page);
    const samples: SceneFrame[] = [];
    for (const at of [0, 100, 140, 400]) { await seekMotion(page, at); samples.push(await now(page)); }
    const child = keys["Pikachu's Ball"];
    const [start, , late, end] = samples.map((sample) => sample.tiles[child] as number[]);
    expect(start[4], "the child starts hidden").toBe(0);
    expect(late[4], "it is appearing").toBeGreaterThan(0);
    expect(late[4]).toBeLessThan(end[4]);
    expect(end[4], "fully shown at the end").toBe(1);
    expect(Math.hypot(start[0] - end[0], start[1] - end[1]), "it slides in").toBeGreaterThan(5);
    // Saffron's open branch is untouched throughout.
    for (const sample of samples) for (const name of ["Saffron", "Blastoise", "Ash"] as const) {
      expect((sample.tiles[keys[name]] as number[]).slice(0, 4), `${name} stays`).toEqual(before.tiles[keys[name]]);
      expect((sample.tiles[keys[name]] as number[])[4]).toBeGreaterThan(0);
    }
  } finally { await releaseMotion(page); }
  await settle(page);
  expect((await state(page)).selected).toEqual([path("Cerulean")]);
  expect(await uncaught(page)).toEqual([]);
});

test("the brief: branches stay open across selection; a second click, the caret and the stack's caret close them, with motion", async ({ page }) => {
  const keys = await open(page);
  const children = { Saffron: [keys.Blastoise, keys.Ash], Cerulean: [keys["Pikachu's Ball"]] };
  const all = (frame: Frame, list: string[]) => list.every((k) => drawn(frame, k));
  const none = (frame: Frame, list: string[]) => !list.some((k) => drawn(frame, k));

  // Saffron's first click opens its children: they arrive with motion.
  let frames = await framesOf(page, press(page, "Saffron"));
  expectSteady(frames, "open Saffron");
  expectAnimated(frames, "open Saffron", arriving(children.Saffron));
  expect(all(frames.at(-1)!, children.Saffron)).toBe(true);

  // Cerulean's first click opens its children; Saffron's stay on every frame.
  frames = await framesOf(page, press(page, "Cerulean"));
  expectSteady(frames, "open Cerulean");
  expectAnimated(frames, "open Cerulean", arriving(children.Cerulean));
  frames.forEach((frame, index) => expect(all(frame, children.Saffron), `Saffron's children at frame ${index}`).toBe(true));
  expect(all(frames.at(-1)!, children.Cerulean)).toBe(true);

  // A second click on Cerulean (the selection) hides its children, with motion; the selection stays.
  frames = await framesOf(page, press(page, "Cerulean"));
  expectSteady(frames, "re-click Cerulean");
  expectAnimated(frames, "re-click Cerulean", leaving(children.Cerulean));
  expect(none(frames.at(-1)!, children.Cerulean)).toBe(true);
  frames.forEach((frame, index) => expect(all(frame, children.Saffron), `Saffron's children at frame ${index}`).toBe(true));
  expect((await state(page)).selected).toEqual([path("Cerulean")]);

  // Saffron's caret hides Saffron's children, with motion, and leaves the selection alone.
  frames = await framesOf(page, pressCaret(page, "Saffron"));
  expectSteady(frames, "Saffron's caret");
  expectAnimated(frames, "Saffron's caret", leaving(children.Saffron));
  expect(none(frames.at(-1)!, children.Saffron)).toBe(true);
  expect((await state(page)).selected).toEqual([path("Cerulean")]);

  // The caret opens it again, without selecting it.
  frames = await framesOf(page, pressCaret(page, "Saffron"));
  expectSteady(frames, "Saffron's caret again");
  expectAnimated(frames, "Saffron's caret again", arriving(children.Saffron));
  expect(all(frames.at(-1)!, children.Saffron)).toBe(true);
  expect((await state(page)).selected).toEqual([path("Cerulean")]);

  // The stack's caret closes the stack, with motion: its band slides up under the cover.
  frames = await framesOf(page, async () => { await page.locator("[data-stack-toggle]").click(); });
  expectSteady(frames, "the stack's caret");
  expectAnimated(frames, "the stack's caret", leaving([keys.Cerulean, keys.Saffron, ...children.Saffron]));
  await expect(page.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
  expect(none(frames.at(-1)!, [keys.Cerulean, keys.Saffron])).toBe(true);
  // The selection stays, hidden, as a file tree keeps a selection inside a folder it collapses.
  expect((await state(page)).selected).toEqual([path("Cerulean")]);
  expect(await uncaught(page)).toEqual([]);
});

test("a stack's cover follows the same rules: a first click selects and opens, a second click closes, a click while open only selects", async ({ page }) => {
  const keys = await open(page);
  const toggle = page.locator("[data-stack-toggle]"), cover = page.locator(".cover-press").first();
  await toggle.click(); await settle(page);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await cover.click(); await settle(page);
  await expect(toggle, "a first click opens").toHaveAttribute("aria-expanded", "true");
  expect((await state(page)).selected).toEqual([path("stack")]);
  await cover.click(); await settle(page);
  await expect(toggle, "a second click closes").toHaveAttribute("aria-expanded", "false");
  expect((await state(page)).selected).toEqual([path("stack")]);
  await cover.click(); await settle(page);
  await expect(toggle, "a third click opens again").toHaveAttribute("aria-expanded", "true");
  // Select a tile inside, then the open cover: selection only.
  await press(page, "Cerulean")(); await settle(page);
  const frames = await framesOf(page, async () => { await cover.click(); });
  expect(frames.at(-1)!.started, "no motion").toBe(frames[0].started);
  frames.forEach((frame, index) => expect(geometry(frame), `frame ${index}`).toEqual(geometry(frames[0])));
  expect((await state(page)).selected).toEqual([path("stack")]);
  await expect(page.locator(`[data-tile-key="${keys["Pikachu's Ball"]}"]`)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});
