import { test, expect, type Page } from "@playwright/test";
import { card, key, openView, settle, uncaught } from "./support";
import { samplePaintedFrames } from "./helpers/scene-events";

/**
 * A scene's images are part of the scene (docs/scene-transactions.md, "Native re-run fixes"):
 * the thumbnails of tiles a scene newly shows are fetched and decoded while it is prepared, so
 * the first frame that draws a tile draws its image, and selection styling changes in the frame
 * the scene commits. The mock host answers every thumbnail 150 ms later (`?thumbnailDelay`), as a
 * cold host thumbnail does, so each first reveal below is cold.
 */

const NAMES = ["Cerulean", "Saffron", "Pikachu's Ball", "Blastoise", "Ash"] as const;
const CHILDREN: Record<string, string[]> = { Cerulean: ["Pikachu's Ball"], Saffron: ["Blastoise", "Ash"] };

type Look = { border: string; background: string; shadow: string; opacity: string; filter: string };
type TileFrame = { image: "img" | "placeholder" | "blank" | "none"; look: Look; at: [number, number] };
type Frame = { t: number; tiles: Record<string, TileFrame | null> };

/** Per painted frame: each named tile's image state and card look (null when it is not mounted). */
function sampleTiles(): Frame {
  const keys = (window as any).__mediaKeys as Record<string, string>;
  return { t: performance.now(), tiles: Object.fromEntries(Object.entries(keys).map(([name, key]) => {
    const tile = document.querySelector(`[data-tile-key="${key}"]`);
    if (!tile) return [name, null];
    const cardElement = tile.querySelector(".card")!, image = tile.querySelector(".card .image");
    const img = image?.querySelector("img") as HTMLImageElement | null;
    const state = img ? (img.complete && img.naturalWidth > 0 ? "img" : "blank") : image?.querySelector(".placeholder") ? "placeholder" : "none";
    const style = getComputedStyle(cardElement), imageStyle = image ? getComputedStyle(image) : null, box = tile.getBoundingClientRect();
    return [name, { at: [Math.round(box.x), Math.round(box.y)], image: state, look: { border: style.borderTopColor, background: style.backgroundColor, shadow: style.boxShadow, opacity: style.opacity, filter: imageStyle?.filter ?? "" } }];
  })) };
}

/** Clicks `name`'s card, recording when in page time. */
async function press(page: Page, name: string): Promise<void> {
  const target = await card(page, name);
  await target.evaluate((element) => element.addEventListener("pointerdown", () => { (window as any).__pressedAt = performance.now(); }, { once: true }));
  await target.click();
}

async function prepare(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 720 });
  await openView(page, 454, query, false);
  await page.locator("[data-stack-toggle]").click();
  await settle(page);
  const keys = Object.fromEntries(await Promise.all(NAMES.map(async (name) => [name, await key(page, name)])));
  await page.evaluate((keys) => { (window as any).__mediaKeys = keys; }, keys);
}

const thumbnailRequests = (page: Page) => page.evaluate(() => (window as any).trace.backend.thumbnailRequests() as string[]);

test("alternating clicks with cold thumbnails: every frame drawing a tile draws its image, and selection styling changes with the commit", async ({ page }, info) => {
  await prepare(page, "?selectionBlink=1&thumbnailDelay=150");
  for (const [round, name] of ["Saffron", "Cerulean", "Saffron", "Cerulean"].entries()) {
    const before = (await thumbnailRequests(page)).length;
    const frames = await samplePaintedFrames(page, sampleTiles, 700, () => press(page, name));
    await settle(page);
    const [final] = await samplePaintedFrames(page, sampleTiles, 50);
    await info.attach(`${round} ${name} frames`, { body: JSON.stringify(frames), contentType: "application/json" });
    const children = CHILDREN[name];
    // The first reveal of each stack's children is cold: their thumbnails were requested by this click.
    if (round < 2) expect((await thumbnailRequests(page)).length, `${name}: cold thumbnails requested`).toBeGreaterThan(before);
    // The first click on each opens its children (explicit expansion); later ones select only, the
    // children shown already. The scene commits in the frame the clicked card takes its final look.
    const committed = frames.findIndex((frame) => children.every((child) => frame.tiles[child] !== null)
      && JSON.stringify(frame.tiles[name]?.look) === JSON.stringify(final.tiles[name]?.look));
    expect(committed, `${name}: its children shown and the selection drawn`).toBeGreaterThan(-1);
    if (round < 2) expect(children.some((child) => frames[0].tiles[child] !== null), `${name}: its children are new`).toBe(false);
    frames.forEach((frame, index) => {
      for (const tile of NAMES) {
        const shown = frame.tiles[tile];
        if (shown) expect(shown.image, `${name} frame ${index}: ${tile} draws its image`).toBe("img");
      }
      // Until the commit, the previous scene's looks (but the pressed card's hover); from it on,
      // every card already has its final look.
      const expected = index < committed ? frames[0] : final;
      for (const tile of NAMES) if (frame.tiles[tile] && expected.tiles[tile] && (index >= committed || tile !== name)) expect(frame.tiles[tile]!.look, `${name} frame ${index}: ${tile} look`).toEqual(expected.tiles[tile]!.look);
    });
  }
  expect((await uncaught(page)).filter((e) => e !== "ResizeObserver loop completed with undelivered notifications.")).toEqual([]);
});

test("a thumbnail slower than the media deadline: the scene commits at the deadline with its placeholder, then the image replaces it in place", async ({ page }) => {
  await prepare(page, "?selectionBlink=1&thumbnailDelay=1500");
  const frames = await samplePaintedFrames(page, sampleTiles, 2500, () => press(page, "Saffron"));
  const pressedAt = await page.evaluate(() => (window as any).__pressedAt as number);
  const revealed = frames.findIndex((frame) => frame.tiles["Blastoise"] !== null && frame.tiles["Ash"] !== null);
  expect(revealed, "the scene commits without its images").toBeGreaterThan(-1);
  // The previous scene stays until the deadline (400 ms); the scene does not wait for the image (1500 ms).
  expect(frames[revealed].t - pressedAt).toBeGreaterThanOrEqual(400);
  expect(frames[revealed].t - pressedAt).toBeLessThan(1400);
  for (const child of ["Blastoise", "Ash"]) expect(frames[revealed].tiles[child]!.image, `${child} at the deadline`).toBe("placeholder");
  const loaded = frames.findIndex((frame) => frame.tiles["Blastoise"]?.image === "img" && frame.tiles["Ash"]?.image === "img");
  expect(loaded, "the images arrive in place").toBeGreaterThan(revealed);
  // In place: the image arriving moves nothing (the children's entrance ended long before).
  for (const child of ["Blastoise", "Ash"]) expect(frames[loaded].tiles[child]!.at, `${child} stays`).toEqual(frames[loaded - 1].tiles[child]!.at);
  expect((await uncaught(page)).filter((e) => e !== "ResizeObserver loop completed with undelivered notifications.")).toEqual([]);
});

/** Tiles intersecting the view, and those drawing a placeholder or an image not yet decoded. */
function visibleMedia() {
  const view = document.querySelector('[data-testid="trace-view"]')!.getBoundingClientRect();
  let tiles = 0; const bad: string[] = [];
  for (const tile of document.querySelectorAll<HTMLElement>("[data-tile-key]")) {
    const box = tile.getBoundingClientRect();
    if (box.bottom < view.top || box.top > view.bottom || !box.height) continue;
    const image = tile.querySelector(".card .image");
    if (!image) continue;
    tiles++;
    const img = image.querySelector("img") as HTMLImageElement | null;
    if (img ? !(img.complete && img.naturalWidth > 0) : !!image.querySelector(".placeholder")) bad.push(tile.dataset.tileKey!);
  }
  return { t: performance.now(), tiles, bad };
}

test("collapsing a big stack brings back tiles whose thumbnails went idle: none draws a placeholder", async ({ page }) => {
  test.setTimeout(120_000);
  const toggle = (name: string) => page.locator(`section[data-component][aria-label="${name}"] [data-stack-toggle]`).first();
  await page.setViewportSize({ width: 900, height: 900 });
  await openView(page, 420, "?fanChildren=120&many=12&thumbnailDelay=150", false);
  for (let i = 0; i < 12; i++) { await toggle(`m${i}`).click(); await settle(page); }
  const before = await page.evaluate(visibleMedia);
  expect(before.tiles, "the open stacks' tiles are on screen").toBeGreaterThan(0);
  expect(before.bad, "every visible tile drew its image before").toEqual([]);
  // The fan's 120 children mount and push the stacks' thumbnails out of view, then past the cache's idle limit.
  await toggle("fan").click();
  await settle(page);
  // The fan's own images may still be loading (on a slow machine, past the media deadline): the
  // frames sampled below are the collapse's, not the open's.
  await expect.poll(async () => (await page.evaluate(visibleMedia)).bad, { timeout: 30_000 }).toEqual([]);
  // Collapsing brings those tiles back: their thumbnails were loaded, and the scene holds them until its views draw them.
  const frames = await samplePaintedFrames(page, visibleMedia, 900, () => toggle("fan").click());
  await settle(page);
  const flagged = frames.filter((frame) => frame.bad.length);
  expect(flagged.map((frame) => frame.bad), "frames drawing a visible tile without its image").toEqual([]);
  expect(frames.at(-1)!.tiles).toBeGreaterThan(0);
});

/** Opens village's stack (Warm draws three of its four references and "+1") and returns the hidden reference. */
async function openReferences(page: Page, query: string): Promise<string[]> {
  await openView(page, 420, `?moreBadges=1&${query}`, false);
  await page.locator('section[data-component][aria-label="village"] [data-stack-toggle]').first().click();
  await settle(page);
  await expect(page.getByRole("button", { name: /^Show \d+ more references$/ })).toHaveCount(1);
  const shown = await page.evaluate(() => [...document.querySelectorAll("[data-reference-key]")].map((badge) => badge.getAttribute("aria-label")!.split(", ")[0]));
  // Warm's references: two in a subfolder, two elsewhere; three are drawn and one is behind "+1".
  const hidden = ["/pictures/refs/mist.png", "/elsewhere/lantern.png", "/pictures/refs/reference-3.png", "/elsewhere/reference-4.png"]
    .filter((path) => !shown.includes(path));
  expect(shown).toHaveLength(3);
  expect(hidden, "one reference is behind +1").toHaveLength(1);
  const requested = await thumbnailRequests(page);
  for (const path of shown) expect(requested, `drawn badge ${path}`).toContain(path);
  for (const path of hidden) expect(requested, `hidden badge ${path}`).not.toContain(path);
  await page.evaluate((hidden) => { (window as any).__hiddenReferences = hidden; }, hidden);
  return hidden;
}

type ReferenceFrame = { t: number; more: string | null; badges: Record<string, "img" | "blank" | "placeholder" | "none"> };
/** Per painted frame: how each hidden reference draws (not at all, its image, an undecoded image or its placeholder), and the overflow button's label. */
function sampleReferences(): ReferenceFrame {
  const hidden = (window as any).__hiddenReferences as string[];
  const all = [...document.querySelectorAll<HTMLElement>("[data-reference-key]")];
  return {
    t: performance.now(),
    more: document.querySelector(".badges .more")?.getAttribute("aria-label") ?? null,
    badges: Object.fromEntries(hidden.map((path) => {
      const badge = all.find((candidate) => candidate.getAttribute("aria-label")!.startsWith(`${path}, `));
      if (!badge) return [path, "none"];
      const img = badge.querySelector("img") as HTMLImageElement | null;
      return [path, img ? (img.complete && img.naturalWidth > 0 ? "img" : "blank") : badge.querySelector(".placeholder") ? "placeholder" : "none"];
    })),
  };
}

test("opening +n draws the hidden reference badges together with their images, in no frame a placeholder", async ({ page }) => {
  const hidden = await openReferences(page, "thumbnailDelay=150");
  const more = page.getByRole("button", { name: /^Show \d+ more references$/ });
  const frames = await samplePaintedFrames(page, sampleReferences, 900, () => more.click());
  for (const [index, frame] of frames.entries()) {
    const states = new Set(Object.values(frame.badges));
    expect([...states].every((state) => state === "img" || state === "none"), `frame ${index}: ${JSON.stringify(frame.badges)}`).toBe(true);
    expect(states.size, `frame ${index}: the hidden badges appear together`).toBe(1);
    // The tile keeps its look until they appear, then the overflow reads as open.
    expect(frame.more, `frame ${index}`).toBe(states.has("img") ? "Show fewer references" : `Show ${hidden.length} more references`);
  }
  expect(frames.some((frame) => Object.values(frame.badges).includes("none")), "the open waited for the images").toBe(true);
  expect(Object.values(frames.at(-1)!.badges).every((state) => state === "img"), "opened").toBe(true);
  for (const path of hidden) expect(await thumbnailRequests(page), `hidden badge ${path} requested on opening`).toContain(path);
});

test("clicking +n again while its images load withdraws the open; once they are cached it opens in the next frame", async ({ page }) => {
  const hidden = await openReferences(page, "thumbnailDelay=150");
  const more = page.getByRole("button", { name: /^Show \d+ more references$/ });
  // Two clicks a frame apart, well inside the image's 150 ms: the second withdraws the first.
  const frames = await samplePaintedFrames(page, sampleReferences, 900, () => more.evaluate(async (button: HTMLButtonElement) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    button.click();
  }));
  for (const [index, frame] of frames.entries()) {
    expect(Object.values(frame.badges).every((state) => state === "none"), `frame ${index}: ${JSON.stringify(frame.badges)}`).toBe(true);
    expect(frame.more, `frame ${index}`).toBe(`Show ${hidden.length} more references`);
  }
  for (const path of hidden) expect(await thumbnailRequests(page), `hidden badge ${path} requested by the withdrawn open`).toContain(path);
  // Its image arrived meanwhile: opening now draws the badges, with their images, in the first frame after the click.
  await page.evaluate((source) => { (window as any).__sampleReferences = new Function(`return (${source})`)(); }, sampleReferences.toString());
  const opened = await more.evaluate(async (button: HTMLButtonElement) => {
    button.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return (window as any).__sampleReferences();
  });
  expect(opened.badges).toEqual(Object.fromEntries(hidden.map((path) => [path, "img"])));
  expect(opened.more).toBe("Show fewer references");
});

test("a thumbnail the host fails to load: the scene commits once it failed, without waiting for the deadline, and draws the placeholder steadily", async ({ page }) => {
  await prepare(page, "?selectionBlink=1&thumbnailDelay=150&thumbnailFail=Blastoise");
  const frames = await samplePaintedFrames(page, sampleTiles, 900, () => press(page, "Saffron"));
  const pressedAt = await page.evaluate(() => (window as any).__pressedAt as number);
  const revealed = frames.findIndex((frame) => frame.tiles["Blastoise"] !== null && frame.tiles["Ash"] !== null);
  expect(revealed, "the scene commits").toBeGreaterThan(-1);
  // A failed image settles the wait: the scene does not wait for the media deadline (400 ms).
  expect(frames[revealed].t - pressedAt, "committed before the media deadline").toBeLessThan(400);
  frames.slice(revealed).forEach((frame, index) => {
    expect(frame.tiles["Blastoise"]?.image, `frame ${revealed + index}: the failed image's placeholder`).toBe("placeholder");
    expect(frame.tiles["Ash"]?.image, `frame ${revealed + index}: Ash's image`).toBe("img");
  });
  expect((await thumbnailRequests(page)).some((path) => path.includes("Blastoise")), "the failing thumbnail was asked for").toBe(true);
  expect((await uncaught(page)).filter((e) => e !== "ResizeObserver loop completed with undelivered notifications.")).toEqual([]);
});
