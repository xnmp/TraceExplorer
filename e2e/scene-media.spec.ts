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
    const revealed = frames.findIndex((frame) => children.every((child) => frame.tiles[child] !== null));
    expect(revealed, `${name}: its children appear`).toBeGreaterThan(-1);
    frames.forEach((frame, index) => {
      for (const tile of NAMES) {
        const shown = frame.tiles[tile];
        if (shown) expect(shown.image, `${name} frame ${index}: ${tile} draws its image`).toBe("img");
      }
      if (index < revealed) return;
      // From the frame the new scene first draws, every card already has its final look.
      for (const tile of NAMES) if (frame.tiles[tile] && final.tiles[tile]) expect(frame.tiles[tile]!.look, `${name} frame ${index}: ${tile} look`).toEqual(final.tiles[tile]!.look);
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
  // In place: the image arriving moves nothing.
  for (const child of ["Blastoise", "Ash"]) expect(frames[loaded].tiles[child]!.at, `${child} stays`).toEqual(frames[revealed].tiles[child]!.at);
  expect((await uncaught(page)).filter((e) => e !== "ResizeObserver loop completed with undelivered notifications.")).toEqual([]);
});
