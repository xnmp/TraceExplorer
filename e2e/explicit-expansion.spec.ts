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
import { DOUBLE_CLICK_MS } from "../src/lib/plugins/trace/view/reclick";

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

/**
 * A motion started for the action, and at least `least` frames show a pose part-way. An arrival
 * fades in over the last ~80 ms of its motion, of which a loaded machine may paint only two
 * frames, one of them fully shown; so arrivals ask for one.
 */
function expectAnimated(frames: Frame[], label: string, partWay: (frame: Frame) => boolean, least = 2): void {
  expect(frames.at(-1)!.started, `${label}: a motion epoch started`).toBeGreaterThan(frames[0].started);
  expect(frames.filter(partWay).length, `${label}: frames part-way`).toBeGreaterThanOrEqual(least);
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
  expectAnimated(frames, "open Saffron", arriving(children.Saffron), 1);
  expect(all(frames.at(-1)!, children.Saffron)).toBe(true);

  // Cerulean's first click opens its children; Saffron's stay on every frame.
  frames = await framesOf(page, press(page, "Cerulean"));
  expectSteady(frames, "open Cerulean");
  expectAnimated(frames, "open Cerulean", arriving(children.Cerulean), 1);
  frames.forEach((frame, index) => expect(all(frame, children.Saffron), `Saffron's children at frame ${index}`).toBe(true));
  expect(all(frames.at(-1)!, children.Cerulean)).toBe(true);

  // A second click on Cerulean (the selection) hides its children once no double click follows,
  // with motion; the selection stays.
  frames = await framesOf(page, press(page, "Cerulean"), 1100);
  const due = frames.findIndex((frame) => frame.started > frames[0].started);
  expect(due, "nothing moves within the double-click window").toBeGreaterThan(0);
  frames.slice(0, due).forEach((frame, index) => expect(geometry(frame), `frame ${index}`).toEqual(geometry(frames[0])));
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
  expectAnimated(frames, "Saffron's caret again", arriving(children.Saffron), 1);
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
  await cover.click();
  await expect(toggle, "a second click closes").toHaveAttribute("aria-expanded", "false");
  await settle(page);
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

test("a double click on the selected open tile or the selected open stack cover opens the file and moves nothing on any frame", async ({ page }) => {
  const keys = await open(page);
  await press(page, "Saffron")(); await settle(page);
  let frames = await framesOf(page, async () => { await (await card(page, "Saffron")).dblclick(); }, DOUBLE_CLICK_MS + 500);
  expect((await state(page)).opened).toContain(path("Saffron"));
  expect(frames.at(-1)!.started, "no motion").toBe(frames[0].started);
  frames.forEach((frame, index) => expect(geometry(frame), `Saffron: frame ${index}`).toEqual(geometry(frames[0])));
  await expect(page.locator(`[data-tile-key="${keys.Blastoise}"]`)).toHaveCount(1);

  const cover = page.locator(".cover-press").first();
  await cover.click(); await settle(page);
  expect((await state(page)).selected).toEqual([path("stack")]);
  frames = await framesOf(page, async () => { await cover.dblclick(); }, DOUBLE_CLICK_MS + 500);
  expect((await state(page)).opened).toContain(path("stack"));
  expect(frames.at(-1)!.started, "no motion").toBe(frames[0].started);
  frames.forEach((frame, index) => expect(geometry(frame), `cover: frame ${index}`).toEqual(geometry(frames[0])));
  await expect(page.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  expect(await uncaught(page)).toEqual([]);
});

test("a Ctrl or Shift click on a collapsed node selects it and moves nothing", async ({ page }) => {
  const keys = await open(page);
  await press(page, "Saffron")(); await settle(page);
  for (const modifier of ["Control", "Shift"] as const) {
    const frames = await framesOf(page, async () => { await (await card(page, "Cerulean")).click({ modifiers: [modifier] }); });
    expect((await state(page)).selected, modifier).toContain(path("Cerulean"));
    expect(frames.at(-1)!.started, `${modifier}: no motion`).toBe(frames[0].started);
    frames.forEach((frame, index) => expect(geometry(frame), `${modifier}: frame ${index}`).toEqual(geometry(frames[0])));
    await expect(page.locator(`[data-tile-key="${keys["Pikachu's Ball"]}"]`)).toHaveCount(0);
    await press(page, "Saffron")(); await settle(page);
  }
  expect(await uncaught(page)).toEqual([]);
});

test("a selected leaf shows the AI edit started from it", async ({ page }) => {
  await open(page);
  for (const name of ["Saffron", "Ash", "Charizard"] as const) { await press(page, name)(); await settle(page); }
  const placeholder = await page.evaluate(() => (window as any).trace.backend.startGeneration("Charizard", "gen1"));
  await expect(page.locator(`[data-tile-key="${placeholder}"]`)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("an AI edit started from the view on an image in a collapsed branch reveals the image and its output", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openView(page, 900, "?selectionBlink=1&ai=1", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  for (const name of ["Saffron", "Ash", "Charizard"] as const) { await press(page, name)(); await settle(page); }
  await (await caret(page, "Saffron")).click(); await settle(page);
  const charizard = await key(page, "Charizard");
  await expect(page.locator(`[data-tile-key="${charizard}"]`)).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill("Give Charizard a hat");
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("jobs.start").length)).toBe(1);
  const output = await page.evaluate(() => { const b = (window as any).trace.backend; return b.key("job-900") ?? b.key("job-901"); });
  expect(output).toBeTruthy();
  await expect(page.locator(`[data-tile-key="${charizard}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-tile-key="${output}"]`)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("a child of two parents: both offer a caret, and the latest press of either wins", async ({ page }) => {
  const keys = await open(page);
  const caretOf = (name: Name) => page.locator(`[data-node-caret="${keys[name]}"]`);
  const charizard = page.locator(`[data-tile-key="${keys.Charizard}"]`);
  for (const name of ["Saffron", "Ash"] as const) { await press(page, name)(); await settle(page); }
  // Charizard becomes an edit of Ash and Blastoise.
  await page.evaluate(() => (window as any).trace.backend.addInput("Charizard", "Blastoise"));
  await expect(charizard).toHaveCount(1);
  await expect(caretOf("Ash")).toHaveAttribute("aria-expanded", "true");
  await expect(caretOf("Blastoise"), "Blastoise's only child is shown").toHaveAttribute("aria-expanded", "true");
  // Selecting Blastoise, whose child is shown, moves nothing.
  let frames = await framesOf(page, press(page, "Blastoise"));
  expect(frames.at(-1)!.started, "no motion").toBe(frames[0].started);
  frames.forEach((frame, index) => expect(geometry(frame), `frame ${index}`).toEqual(geometry(frames[0])));
  // Blastoise's caret hides Charizard although Ash opened it earlier; both carets then read collapsed.
  await caretOf("Blastoise").click(); await settle(page);
  await expect(charizard).toHaveCount(0);
  await expect(caretOf("Ash")).toHaveAttribute("aria-expanded", "false");
  await expect(caretOf("Blastoise")).toHaveAttribute("aria-expanded", "false");
  // Ash's caret shows it again; a slow second click on the selected Blastoise hides it again.
  await caretOf("Ash").click(); await settle(page);
  await expect(charizard).toHaveCount(1);
  frames = await framesOf(page, press(page, "Blastoise"), DOUBLE_CLICK_MS + 400);
  expect(frames.at(-1)!.started, "the second click moves something").toBeGreaterThan(frames[0].started);
  await expect(charizard).toHaveCount(0);
  // And Blastoise's caret, now collapsed, shows it.
  await caretOf("Blastoise").click(); await settle(page);
  await expect(charizard).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("an AI edit whose job is refused reveals nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openView(page, 900, "?selectionBlink=1&ai=1", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  for (const name of ["Saffron", "Ash", "Charizard"] as const) { await press(page, name)(); await settle(page); }
  await (await caret(page, "Saffron")).click(); await settle(page);
  const charizard = page.locator(`[data-tile-key="${await key(page, "Charizard")}"]`);
  await expect(charizard).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.backend.refuseJobStarts("The image service is busy"));
  await page.evaluate(() => (window as any).trace.command("plugin.openai-image.edit"));
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Prompt", exact: true }).fill("Give Charizard a hat");
  await page.keyboard.press("Control+Enter");
  await expect(dialog.getByText("The image service is busy")).toBeVisible();
  await settle(page);
  await expect(charizard, "nothing was started, so nothing is revealed").toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("an opening interrupted by another toggle continues its children's fade from where it was", async ({ page }) => {
  const keys = await open(page);
  await press(page, "Saffron")(); await settle(page);
  await holdMotion(page);
  const opacities: number[] = [];
  try {
    await press(page, "Cerulean")();
    await awaitMotionStarted(page);
    await seekMotion(page, 60);
    await (await caret(page, "Saffron")).click();
    await awaitMotionStarted(page);
    for (let at = 0; at <= 160; at += 10) {
      await seekMotion(page, at);
      opacities.push(((await now(page)).tiles[keys["Pikachu's Ball"]] as number[] | undefined)?.[4] ?? 0);
    }
  } finally { await releaseMotion(page); }
  // Its arrival began fading in about 80 ms after the first click: 40 ms into the second motion
  // (100 ms after the first click) it is appearing, and it never jumps.
  expect(opacities[4], JSON.stringify(opacities)).toBeGreaterThan(0);
  for (let i = 1; i < opacities.length; i++) {
    expect(opacities[i], JSON.stringify(opacities)).toBeGreaterThanOrEqual(opacities[i - 1] - .01);
    expect(opacities[i] - opacities[i - 1], JSON.stringify(opacities)).toBeLessThan(.5);
  }
  expect(opacities.at(-1)).toBe(1);
  expect(await uncaught(page)).toEqual([]);
});

test("a second click on the selected cover of a stack still opening closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openView(page, 900, "?selectionBlink=1", false);
  const toggle = page.locator("[data-stack-toggle]"), cover = page.locator(".cover-press").first();
  await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
  await cover.click();
  await expect(toggle, "opening").toHaveAttribute("aria-label", "Cancel opening stack");
  expect((await state(page)).selected).toEqual([path("stack")]);
  await page.waitForTimeout(DOUBLE_CLICK_MS + 100);
  await cover.click();
  await expect(toggle, "the second click cancels the opening").toHaveAttribute("aria-label", "Expand stack");
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await settle(page);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await uncaught(page)).toEqual([]);
});

test("a second click on a stack's cover toggles its stack when the toggle fires, even after its component merged", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  const coverKey = await key(page, "photo-a");
  const cell = page.locator(`[data-grid-cell="${coverKey}"]`);
  const cover = cell.locator(".cover-press"), toggle = cell.locator("[data-stack-toggle]");
  await cover.click(); await settle(page);
  await expect(toggle, "a first click opens").toHaveAttribute("aria-expanded", "true");
  const before = await page.locator("section[data-component]").evaluateAll((sections) => sections.map((section) => (section as HTMLElement).dataset.component));
  await cover.click();
  // Within the double-click window, an edit of both chains merges their components (the toggle
  // finds the stack again by its cover's key, as a merge can change a stack's id).
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined"));
  await expect(page.locator("section[data-component]")).not.toHaveCount(before.length);
  await page.waitForTimeout(DOUBLE_CLICK_MS + 200); await settle(page);
  await expect(toggle, "the second click closes the merged stack").toHaveAttribute("aria-expanded", "false");
  expect(await uncaught(page)).toEqual([]);
});

test("a caret on a child of the stack's cover changes what is shown, both ways (the junction)", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await openView(page, 900, "?bandMotion=junction", false);
  await page.locator('section[aria-label="stack-b"] [data-stack-toggle]').click(); await settle(page);
  // stack-b-merge is an edit of the cover and of stack-b-1.
  const merge = page.locator(`[data-tile-key="${await key(page, "stack-b-merge")}"]`);
  const caretOfOne = await caret(page, "stack-b-1");
  await expect(merge).toHaveCount(1);
  await expect(caretOfOne).toHaveAttribute("aria-expanded", "true");
  await caretOfOne.click(); await settle(page);
  await expect(merge, "collapsing stack-b-1 hides the merge, though the cover opened it earlier").toHaveCount(0);
  await expect(caretOfOne).toHaveAttribute("aria-expanded", "false");
  await caretOfOne.click(); await settle(page);
  await expect(merge).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("pressing a reference badge shared by two stacks opens its consumers only in the stack it was pressed in", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1400 });
  await openView(page, 1300, "", false);
  await page.evaluate(() => {
    const backend = (window as any).trace.backend;
    backend.joinGeneration(["forest", "mist"], "x");
    backend.joinGeneration(["autumn", "mist"], "y");
    backend.joinGeneration(["morning", "mist"], "z");
  });
  await settle(page);
  for (const name of ["village", "forest"]) {
    const toggle = page.locator(`section[aria-label="${name}"] [data-stack-toggle]`);
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await settle(page);
  }
  const y = page.locator(`[data-tile-key="${await key(page, "y")}"]`), z = page.locator(`[data-tile-key="${await key(page, "z")}"]`);
  await expect(y, "autumn is collapsed").toHaveCount(0);
  await expect(z, "daylight is collapsed").toHaveCount(0);
  // The mist badge on warm, in village's band.
  const mist = await key(page, "mist");
  const badge = page.locator(`section[aria-label="village"] [data-reference-key="${mist}"]`).first();
  await badge.click(); await settle(page);
  await expect(z, "village's z shows").toHaveCount(1);
  await expect(y, "forest's y stays hidden").toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});
