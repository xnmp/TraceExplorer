import { test, expect, type Locator, type Page } from "@playwright/test";
import { openView, click, card, key, tile, state, settle, uncaught } from "./support";

const PROMPT = "A quiet harbour village at dusk, warm light spilling from the windows onto wet cobblestones.\n"
  + "Keep the original composition; shift the palette towards amber and teal.\n\nStyle: soft painterly brushwork, gentle film grain, no text.";
const bubble = (page: Page) => page.locator("#trace-tile-tooltip");

async function setPrompt(page: Page, name: string, prompt: string): Promise<void> {
  await page.evaluate(({ name, prompt }) => (window as any).trace.backend.setPrompt(name, prompt), { name, prompt });
  await expect.poll(() => page.evaluate((n) => (window as any).trace.backend.node(n).prompt, name)).toBe(prompt);
  await settle(page);
}

/**
 * Records, in the page, when the pointer entered `target` and when the
 * tooltip first showed `text`, both on the page's clock.
 */
async function recordTiming(target: Locator, text: string): Promise<() => Promise<{ entered: number; shown: number }>> {
  const handle = await target.evaluateHandle((element, expected) => {
    const record = { entered: -1, shown: -1 };
    element.addEventListener("pointerenter", () => { if (record.entered < 0) record.entered = performance.now(); });
    const check = () => {
      const shown = document.querySelector("#trace-tile-tooltip .text");
      if (record.shown < 0 && shown?.textContent === expected) record.shown = performance.now();
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
    return record;
  }, text);
  return async () => {
    await expect.poll(() => handle.evaluate((record) => record.shown)).toBeGreaterThan(0);
    return handle.evaluate((record) => ({ ...record }));
  };
}

test.describe("Trace tile tooltip", () => {
  test("appears after the hover delay, not before, styled with the host's tokens", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", PROMPT);
    const warm = await card(page, "warm");
    const timing = await recordTiming(warm, PROMPT);
    await warm.hover();
    await expect(bubble(page)).toHaveCount(0);
    const { entered, shown } = await timing();
    expect(shown - entered).toBeGreaterThanOrEqual(380);
    await expect(bubble(page)).toBeVisible();

    const style = await bubble(page).evaluate((element) => {
      const css = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("div");
      probe.style.background = root.getPropertyValue("--background-solid");
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { background: css.backgroundColor, expected, radius: css.borderTopLeftRadius, shadow: css.boxShadow, pointer: css.pointerEvents, position: css.position, parent: element.parentElement === document.body };
    });
    expect(style.background).toBe(style.expected);
    expect(style.radius).toBe("8px");
    expect(style.shadow).not.toBe("none");
    expect(style.pointer).toBe("none");
    expect(style.position).toBe("fixed");
    // Mounted in the body, so no scroll container or section clips it.
    expect(style.parent).toBe(true);
    expect(await uncaught(page)).toEqual([]);
  });

  test("shows the whole multi-line prompt, wrapped, with the image name and operation", async ({ page }) => {
    await openView(page);
    await setPrompt(page, "warm", PROMPT);
    await (await card(page, "warm")).hover();
    await expect(bubble(page)).toBeVisible();
    const text = bubble(page).locator(".text");
    expect(await text.evaluate((element) => (element as HTMLElement).innerText)).toBe(PROMPT);
    // Wrapped over several lines, within a readable width.
    const box = (await text.boundingBox())!;
    const lineHeight = await text.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect(box.height).toBeGreaterThan(lineHeight * 4);
    expect((await bubble(page).boundingBox())!.width).toBeLessThanOrEqual(381);
    await expect(bubble(page).locator(".detail")).toHaveText("warm.png · AI edit");
    // The tile is described by the tooltip while it shows.
    await expect(await card(page, "warm")).toHaveAttribute("aria-describedby", "trace-tile-tooltip");
  });

  test("an external reference names its location", async ({ page }) => {
    await openView(page);
    await (await card(page, "lantern")).hover();
    await expect(bubble(page).locator(".text")).toHaveText("lantern prompt");
    await expect(bubble(page).locator(".detail").last()).toHaveText("Outside this folder: /elsewhere/lantern.png");
  });

  test("moving to a neighbouring tile shows its tooltip at once", async ({ page }) => {
    await openView(page);
    await (await card(page, "village")).hover();
    await expect(bubble(page).locator(".text")).toHaveText("village prompt");
    const palette = await card(page, "palette");
    const timing = await recordTiming(palette, "palette prompt");
    await palette.hover();
    const { entered, shown } = await timing();
    expect(shown - entered).toBeLessThan(150);
  });

  test("hides when the pointer leaves, and on Escape until the tile is left", async ({ page }) => {
    await openView(page);
    const warm = await card(page, "warm");
    await warm.hover();
    await expect(bubble(page)).toBeVisible();
    await page.mouse.move(2, 2);
    await expect(bubble(page)).toHaveCount(0);
    await expect(warm).not.toHaveAttribute("aria-describedby");

    await warm.hover();
    await expect(bubble(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bubble(page)).toHaveCount(0);
    // Still hovering: it does not come back by itself.
    await page.waitForTimeout(700);
    await expect(bubble(page)).toHaveCount(0);
  });

  test("hides on scroll and when the window loses focus", async ({ page }) => {
    await openView(page, undefined, "?many=6");
    const warm = await card(page, "warm");
    await warm.hover();
    await expect(bubble(page)).toBeVisible();
    await page.getByTestId("trace-view").evaluate((element) => { element.scrollTop += 40; });
    await expect(bubble(page)).toHaveCount(0);

    await page.mouse.move(2, 2);
    await (await card(page, "village")).hover();
    await expect(bubble(page)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(bubble(page)).toHaveCount(0);
  });

  test("stays inside the window at the right and bottom edges", async ({ page }) => {
    for (const query of ["?many=6", "?many=6&zoom=1.3"]) {
      await page.setViewportSize({ width: 1280, height: 720 });
      await openView(page, 600, query);
      await setPrompt(page, "cool", PROMPT);
      // Only the Explorer pane, filling the window: its right edge is the window's.
      await page.addStyleTag({ content: "aside.preview { display: none !important; }" });
      const right = await page.locator(".explorer").evaluate((element) => Math.floor(element.getBoundingClientRect().right));
      await page.setViewportSize({ width: right, height: 720 });
      await settle(page);
      // Scroll the right-most tile of the first graph down to the window's bottom edge.
      const corner = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>("section.component")[0].querySelectorAll<HTMLElement>("[data-node-key]")];
        const card = cards.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
        view.scrollTop += card.getBoundingClientRect().bottom - Math.min(innerHeight, view.getBoundingClientRect().bottom) + 2;
        return card.dataset.nodeKey!;
      });
      await settle(page);
      const target = page.locator(`[data-node-key="${corner}"]`);
      const box = await target.evaluate((element) => { const r = element.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, right: r.right, bottom: r.bottom }; });
      expect(await page.evaluate(() => innerWidth) - box.right, query).toBeLessThan(190);
      // Move straight onto the tile: an auto-scrolling hover would dismiss the tooltip.
      await page.mouse.move(box.x, box.y);
      await expect(bubble(page), query).toBeVisible();
      const placed = await bubble(page).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
      });
      expect(placed.left, query).toBeGreaterThanOrEqual(0);
      expect(placed.top, query).toBeGreaterThanOrEqual(0);
      expect(placed.right, query).toBeLessThanOrEqual(placed.width);
      expect(placed.bottom, query).toBeLessThanOrEqual(placed.height);
      await page.mouse.move(2, 2);
    }
  });

  test("no native title remains on tiles", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    expect(await page.locator("[data-tile-key] .card[title], [data-tile-key] .card [title]").count()).toBe(0);
    expect(await page.locator("[data-tile-key] .image-actions [title]").count()).toBe(0);
  });

  test("the tile still selects on click, and the click closes the tooltip", async ({ page }) => {
    await openView(page);
    const warm = await card(page, "warm");
    await warm.hover();
    await expect(bubble(page)).toBeVisible();
    await warm.click();
    await expect(bubble(page)).toHaveCount(0);
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/warm.png"]);
  });

  test("keyboard focus shows the tooltip and describes the tile", async ({ page }) => {
    await openView(page);
    await click(page, "village");
    await page.mouse.move(2, 2);
    await page.keyboard.press("ArrowRight");
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.nodeKey ?? null);
    expect(focused).not.toBeNull();
    await expect(bubble(page)).toBeVisible();
    await expect(page.locator(`[data-node-key="${focused}"]`)).toHaveAttribute("aria-describedby", "trace-tile-tooltip");
    await page.keyboard.press("Escape");
    await expect(bubble(page)).toHaveCount(0);
  });
});

test.describe("unsaved output actions", () => {
  async function showMerge(page: Page, query = ""): Promise<Locator> {
    await openView(page, undefined, query);
    await click(page, "warm");
    await page.mouse.move(2, 2);
    return tile(page, "merge");
  }

  test("are labelled by the styled tooltip, with no native title", async ({ page }) => {
    const merge = await showMerge(page);
    await merge.hover();
    const save = merge.getByRole("button", { name: "Save image permanently" });
    await save.hover();
    await expect(bubble(page).locator(".text")).toHaveText("Save");
    await expect(save).not.toHaveAttribute("title");
    await merge.getByRole("button", { name: "Delete unsaved image" }).hover();
    await expect(bubble(page).locator(".text")).toHaveText("Delete");
  });

  for (const theme of ["light", "dark"]) {
    test(`stay legible over bright and dark images (${theme} theme)`, async ({ page }) => {
      const merge = await showMerge(page, `?theme=${theme}`);
      await merge.hover();
      const chip = merge.locator(".image-actions");
      await expect(chip).toBeVisible();
      for (const fill of ["#ffffff", "#000000"]) {
        await merge.locator("img").evaluate((img, colour) => {
          (img as HTMLImageElement).src = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="${colour}"/></svg>`);
          return (img as HTMLImageElement).decode();
        }, fill);
        const look = await chip.evaluate((element) => {
          const parse = (colour: string) => colour.match(/[\d.]+/g)!.map(Number);
          const luminance = ([r, g, b]: number[]) => {
            const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          // Nothing between the icons and the image lets it show through: an opaque chip, no translucent ancestor.
          let opacity = 1;
          for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
          const background = parse(getComputedStyle(element).backgroundColor);
          const icons = [...element.querySelectorAll("button")].map((button) => parse(getComputedStyle(button).color));
          const ratios = icons.map((icon) => {
            const [high, low] = [luminance(icon), luminance(background)].sort((a, b) => b - a);
            return (high + 0.05) / (low + 0.05);
          });
          const image = element.closest("[data-tile-key]")!.querySelector("img")!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return { opacity, alpha: background.length > 3 ? background[3] : 1, ratios, overImage: box.top < image.bottom && box.right > image.left };
        });
        expect(look.overImage, fill).toBe(true);
        expect(look.opacity, fill).toBe(1);
        expect(look.alpha, fill).toBe(1);
        for (const ratio of look.ratios) expect(ratio, fill).toBeGreaterThan(4.5);
      }
      // The chip covers only a corner of the image.
      const [chipBox, imageBox] = [await chip.boundingBox(), await merge.locator(".image").boundingBox()];
      expect(chipBox!.width * chipBox!.height).toBeLessThan(0.35 * imageBox!.width * imageBox!.height);
    });
  }


  test("are reachable by keyboard and do not select the tile", async ({ page }) => {
    const merge = await showMerge(page);
    const before = (await state(page)).selected;
    await page.evaluate(() => (window as any).trace.backend.holdSaves());
    await (await card(page, "merge")).focus();
    await page.keyboard.press("Tab");
    const save = merge.getByRole("button", { name: "Save image permanently" });
    await expect(save).toBeFocused();
    await expect(save).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(merge.getByRole("button", { name: "Delete unsaved image" })).toBeFocused();

    await page.mouse.move(2, 2);
    await merge.hover();
    await save.click();
    // The press starts the save; the tile itself is not activated.
    await expect(merge.getByRole("status")).toHaveText("Saving image…");
    expect((await state(page)).selected).toEqual(before);
    expect((await state(page)).selected).not.toContain(await key(page, "merge"));
    await page.evaluate(() => (window as any).trace.backend.releaseSaves());
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
  });
});
