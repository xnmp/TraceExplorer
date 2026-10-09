import { test, expect, type Page } from "@playwright/test";
import { openView, click, key, tile, card, state, uncaught, settle, tileBoxes, overlaps, rendered, type Box } from "./support";

/** Rendered width and image height of every tile, keyed by node key. */
const tileSizes = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => {
  const image = element.querySelector<HTMLElement>(".image")!;
  return [element.dataset.tileKey!, { width: element.getBoundingClientRect().width, image: image.getBoundingClientRect().height }];
})));

test.describe("selection neighborhood", () => {
  test("without a selection nothing is dimmed and every tile has the same size", async ({ page }) => {
    await openView(page);
    expect(await rendered(page, "tone", "unrelated")).toEqual([]);
    expect(await rendered(page, "tone", "focus")).toEqual([]);
    const sizes = Object.values(await tileSizes(page));
    expect(sizes.length).toBeGreaterThan(10);
    expect(new Set(sizes.map((size) => JSON.stringify(size))).size).toBe(1);
  });

  test("selecting a node dims the rest and drops the old branch, without resizing any tile", async ({ page }) => {
    await openView(page);
    const initial = Object.values(await tileSizes(page))[0];
    const uniform = async () => {
      for (const [k, size] of Object.entries(await tileSizes(page))) expect(size, k).toEqual(initial);
    };
    await click(page, "warm");
    await uniform();
    expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
    expect(await rendered(page, "tone", "related")).toEqual(["evening", "lantern", "merge", "mist", "palette", "rain", "village"]);
    const unrelated = await rendered(page, "tone", "unrelated");
    for (const name of ["daylight", "cool", "forest", "fan"]) expect(unrelated).toContain(name);
    expect(unrelated).not.toContain("warm");

    await click(page, "rain");
    await uniform();
    expect(await rendered(page, "tone", "focus")).toEqual(["rain"]);
    for (const name of ["village", "palette", "mist", "lantern"]) await expect(await tile(page, name)).toHaveAttribute("data-tone", "related");
    await expect(await tile(page, "daylight")).toHaveAttribute("data-tone", "unrelated");

    // Daylight's view no longer shows warm's children: the old branch is dropped.
    await click(page, "daylight");
    await uniform();
    for (const name of ["evening", "rain", "quiet"]) await expect(await tile(page, name)).toHaveCount(0);
  });

  test("selecting a node shows its parents, children and siblings", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await click(page, "rain");
    // Parent, child, and the other children of rain's parent (evening, and merge, which also needs daylight).
    for (const name of ["warm", "quiet", "evening", "merge", "daylight"]) await expect(await tile(page, name), name).toBeVisible();
    // Siblings are shown, but are not part of rain's own history.
    await expect(await tile(page, "evening")).toHaveAttribute("data-tone", "unrelated");
    expect(overlaps(await tileBoxes(page, 0))).toEqual([]);
  });

  test("the selection shows in the tile's styling: an accent border, and a ring around the focus", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await click(page, "rain", { modifiers: ["Control"] });
    const styles = await page.evaluate((keys) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { accent, cards: keys.map((k) => {
        const style = getComputedStyle(document.querySelector(`[data-node-key="${CSS.escape(k)}"]`)!);
        return { border: style.borderTopColor, ring: style.boxShadow };
      }) };
    }, await Promise.all(["rain", "warm", "village"].map((name) => key(page, name))));
    const [focus, selected, plain] = styles.cards;
    expect(focus.border).toBe(styles.accent);
    expect(selected.border).toBe(styles.accent);
    expect(plain.border).not.toBe(styles.accent);
    expect(focus.ring).toContain(styles.accent);
    expect(selected.ring).toBe("none");
  });

  test("ctrl-click multi-selects with one primary focus on the last clicked node", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await click(page, "rain", { modifiers: ["Control"] });
    await expect(await card(page, "warm")).toHaveAttribute("aria-pressed", "true");
    await expect(await card(page, "rain")).toHaveAttribute("aria-pressed", "true");
    expect(await rendered(page, "tone", "focus")).toEqual(["rain"]);
    expect((await state(page)).selected.sort()).toEqual(["/pictures/rain.png", "/pictures/warm.png"]);
  });

  test("clicking the empty background clears the selection and the dimming", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await page.locator('[data-testid="trace-view"]').click({ position: { x: 2, y: 2 } });
    await settle(page);
    expect((await state(page)).selected).toEqual([]);
    expect(await rendered(page, "tone", "unrelated")).toEqual([]);
  });
});

test.describe("exact parentage", () => {
  test("a two-parent output has one terminal arrow and a junction naming both parents", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const merge = await key(page, "merge");
    const into = page.locator(`svg path[data-route][data-to="node:${merge}"]`);
    await expect(into).toHaveCount(1);
    await expect(into).toHaveAttribute("marker-end", /url\(#/);
    const junction = page.locator("circle[data-junction] title").filter({ hasText: "daylight" }).filter({ hasText: "warm" });
    await expect(junction).toHaveCount(1);
    const targets = await page.locator("svg path[data-route][marker-end]").evaluateAll((paths) => paths.map((p) => p.getAttribute("data-to")));
    expect(new Set(targets).size).toBe(targets.length);
  });
});

test.describe("wide layouts", () => {
  const WIDTHS = [420, 700, 1100];
  const content = (page: import("@playwright/test").Page, index: number) =>
    page.locator("section.component[data-component]").nth(index).locator(".content");
  const overflow = (page: import("@playwright/test").Page, index: number) =>
    content(page, index).evaluate((element) => ({ over: element.scrollWidth - element.clientWidth, graph: element.querySelector(".graph")!.getBoundingClientRect().width, inner: element.clientWidth }));

  async function resize(page: import("@playwright/test").Page, width: number, index: number) {
    await page.evaluate((w) => (window as any).trace.setWidth(w), width);
    await expect.poll(async () => (await overflow(page, index)).over).toBeLessThanOrEqual(1);
    await settle(page);
    await page.waitForTimeout(150);
    await settle(page);
  }

  test("a wide fan-out wraps within the pane at every width without colliding", async ({ page }) => {
    await openView(page);
    await click(page, "fan");
    const children = await Promise.all(Array.from({ length: 18 }, (_, i) => key(page, `fan-${i + 1}`)));
    for (const width of WIDTHS) {
      await resize(page, width, 2);
      const measured = await overflow(page, 2);
      expect(measured.over, `overflow at ${width}`).toBeLessThanOrEqual(1);
      expect(measured.graph).toBeLessThanOrEqual(measured.inner + 1);
      const boxes = await tileBoxes(page, 2);
      expect(overlaps(boxes), `overlaps at ${width}`).toEqual([]);
      for (const child of children) expect(boxes[child], `child rendered at ${width}`).toBeTruthy();
      const rows = new Set(children.map((child) => Math.round(boxes[child].y / 8)));
      if (width < 1000) expect(rows.size, `rows at ${width}`).toBeGreaterThanOrEqual(2);
    }
  });

  /** Tile boxes of a section on screen (viewport coordinates), keyed by node key. */
  const screenBoxes = (page: Page, component: number) => page.evaluate((index) => {
    const section = document.querySelectorAll("section.component[data-component]")[index];
    return Object.fromEntries([...section.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => {
      const r = element.getBoundingClientRect();
      return [element.dataset.tileKey!, { x: r.x, y: r.y, width: r.width, height: r.height }];
    }));
  }, component);
  /** Every shown child lies entirely right of each of its shown parents. */
  const runsRight = (boxes: Record<string, Box>, edges: Array<[string, string]>) => {
    for (const [parent, child] of edges) if (boxes[parent] && boxes[child]) expect(boxes[child].x, `${child} right of ${parent}`).toBeGreaterThanOrEqual(boxes[parent].x + boxes[parent].width);
  };

  test("a component whose generations fit side by side runs left to right, and no tile jumps while selection reveals deeper generations", async ({ page }) => {
    await openView(page, 900, "?deeper=1");
    const [forest, mist, autumn, dawn, dusk] = await Promise.all(["forest", "forest-mist", "autumn", "mist-dawn", "mist-dusk"].map((name) => key(page, name)));
    const edges: Array<[string, string]> = [[forest, mist], [forest, autumn], [mist, dawn], [dawn, dusk]];
    const arrowEnd = (child: string) => page.evaluate((k) => {
      const section = document.querySelectorAll("section.component[data-component]")[1];
      const path = section.querySelector<SVGPathElement>(`path[data-route][data-to="node:${CSS.escape(k)}"]`)!;
      const point = path.getPointAtLength(path.getTotalLength());
      return { x: point.x, y: point.y };
    }, child);
    const settled: Record<string, Box> = {};
    /** Lays out sideways, and every tile shown before is exactly where it was on screen. */
    const check = async (shown: string[], hidden: string[]) => {
      const local = await tileBoxes(page, 1);
      const screen = await screenBoxes(page, 1);
      expect(Object.keys(screen).sort()).toEqual(expect.arrayContaining(shown.sort()));
      for (const k of hidden) expect(screen[k], `${k} hidden`).toBeUndefined();
      expect(overlaps(local)).toEqual([]);
      runsRight(local, edges);
      for (const [k, box] of Object.entries(screen)) {
        if (settled[k]) {
          expect(Math.abs(box.x - settled[k].x), `${k} x`).toBeLessThanOrEqual(1);
          expect(Math.abs(box.y - settled[k].y), `${k} y`).toBeLessThanOrEqual(1);
        }
        settled[k] = box;
      }
      return local;
    };
    const first = await check([forest, mist, autumn], [dawn, dusk]);
    // Both edits sit in one column right of the image they were made from, one above the other.
    expect(Math.abs(first[mist].x - first[autumn].x)).toBeLessThanOrEqual(1);
    expect(Math.abs(first[mist].y - first[autumn].y)).toBeGreaterThanOrEqual(first[mist].height);
    // Each arrow arrives at its edit's left edge (its line ends at the arrowhead's base, 8 px short).
    for (const child of [mist, autumn]) {
      const end = await arrowEnd(child);
      expect(end.x).toBeLessThanOrEqual(first[child].x);
      expect(end.x).toBeGreaterThan(first[child].x - 12);
      expect(end.y).toBeGreaterThan(first[child].y);
      expect(end.y).toBeLessThan(first[child].y + first[child].height);
    }
    // Each selection reveals the next generation in a new column; nothing already shown moves.
    await click(page, "forest-mist");
    await check([forest, mist, autumn, dawn], [dusk]);
    await click(page, "mist-dawn");
    await check([forest, mist, autumn, dawn, dusk], []);
    await click(page, "mist-dusk");
    await check([forest, mist, dawn, dusk], []);
    await click(page, "autumn");
    await check([forest, mist, autumn], [dawn, dusk]);
  });

  test("generating images into a left-to-right component keeps it left to right", async ({ page }) => {
    await openView(page, 900);
    const names = ["forest", "forest-mist", "autumn"];
    const [forest, mist, autumn] = await Promise.all(names.map((name) => key(page, name)));
    await click(page, "forest-mist");
    const columns = async () => {
      const boxes = await tileBoxes(page, 1);
      runsRight(boxes, [[forest, mist], [forest, autumn], ...batch.map((k) => [forest, k] as [string, string])]);
      expect(overlaps(boxes)).toEqual([]);
      return Object.fromEntries([forest, mist, autumn].map((k) => [k, Math.round(boxes[k].x)]));
    };
    const batch: string[] = [];
    const before = await columns();
    // A four-image batch of variations of the root, as one generation request makes them.
    for (let index = 1; index <= 4; index++) batch.push(await page.evaluate((n) => (window as any).trace.backend.startGeneration("forest", n), `variation-${index}`));
    for (const k of batch) await expect(page.locator(`[data-tile-key="${k}"]`)).toBeVisible();
    await settle(page);
    expect(await columns(), "while generating").toEqual(before);
    for (let index = 1; index <= 4; index++) await page.evaluate((n) => (window as any).trace.backend.completeGeneration(n), `variation-${index}`);
    await settle(page);
    expect(await columns(), "unsaved").toEqual(before);
    for (let index = 1; index <= 4; index++) await page.evaluate((n) => (window as any).trace.backend.discardGeneration(n), `variation-${index}`);
    // Discarded outputs with no edits of their own leave the graph.
    for (const k of batch) await expect(page.locator(`[data-tile-key="${k}"]`)).toHaveCount(0);
    await page.waitForTimeout(150);
    await settle(page);
    expect(await columns(), "discarded").toEqual(before);
    expect(await uncaught(page)).toEqual([]);
  });

  test("the view remembers a component's orientation while images are saved into it, and forgets it in another folder", async ({ page }) => {
    await openView(page, 900);
    const [forest, mist, autumn] = await Promise.all(["forest", "forest-mist", "autumn"].map((name) => key(page, name)));
    const flow = async () => {
      const boxes = await tileBoxes(page, 1);
      const children = [mist, autumn, ...extra].filter((k) => boxes[k]);
      if (children.every((k) => boxes[k].x >= boxes[forest].x + boxes[forest].width)) return "right";
      if (children.every((k) => boxes[k].y >= boxes[forest].y + boxes[forest].height)) return "down";
      return "mixed";
    };
    const extra: string[] = [];
    const visit = async (folder: string) => {
      await page.evaluate((path) => (window as any).trace.navigate(path), folder);
      await expect(page.locator(`[data-tile-key="${forest}"]`)).toBeVisible();
      await page.waitForTimeout(150);
      await settle(page);
    };
    // Visit the mirror once, so switching to it later keeps the same view mounted.
    await visit("/pictures-mirror");
    await visit("/pictures");
    expect(await flow()).toBe("right");
    // A third saved edit of the root: a little broader than deep. Shown sideways, it stays so.
    extra.push(await page.evaluate(() => (window as any).trace.backend.startGeneration("forest", "third")));
    await page.evaluate(() => { const b = (window as any).trace.backend; b.completeGeneration("third"); b.saveGeneration("third"); });
    await expect(page.locator(`[data-tile-key="${extra[0]}"]`)).toBeVisible();
    await page.waitForTimeout(150);
    await settle(page);
    expect(await flow()).toBe("right");
    // Another folder whose components happen to have the same ids remembers nothing: the plain rule lays it out top to bottom.
    await page.evaluate(() => { (document.querySelector("[data-testid=trace-view]") as any).__marked = true; });
    await visit("/pictures-mirror");
    expect(await page.evaluate(() => (document.querySelector("[data-testid=trace-view]") as any).__marked), "same view instance").toBe(true);
    expect(await flow()).toBe("down");
    expect(await uncaught(page)).toEqual([]);
  });

  test("an open tile's chevron points towards its children: down, or right when the component runs left to right", async ({ page }) => {
    await openView(page, 900);
    const chevron = async (name: string) => (await tile(page, name)).locator(".chevron").evaluate((svg) => {
      const box = (svg.querySelector("path") as SVGPathElement).getBBox();
      return box.width > box.height ? "down" : "right";
    });
    await click(page, "forest");
    expect(await chevron("forest")).toBe("right");
    await click(page, "village");
    expect(await chevron("village")).toBe("down");
  });

  test("the village graph keeps tiles apart at every width", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    for (const width of WIDTHS) {
      await resize(page, width, 0);
      expect((await overflow(page, 0)).over).toBeLessThanOrEqual(1);
      expect(overlaps(await tileBoxes(page, 0)), `overlaps at ${width}`).toEqual([]);
    }
  });
});

interface Head { route: string; tone: string; sideways: boolean; edgeGap: number; withinEdge: boolean; misalignment: number; baseOffset: number; contrast: number; length: number; width: number; straight: boolean; painted: boolean }

/**
 * Every arrowhead of a section (the first by default) as the browser renders it: the
 * marker its line references, placed per SVG marker rules at the line's
 * end, against its tile's box (CSS pixels, so independent of any zoom).
 * `painted` samples the screenshot just inside the tip.
 */
async function arrowheads(page: Page, index = 0): Promise<Head[]> {
  const section = page.locator("section.component[data-component]").nth(index);
  const shot = await section.screenshot({ animations: "disabled" });
  return section.evaluate(async (element, png) => {
    const graph = element.querySelector<HTMLElement>(".graph")!;
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const sectionBox = element.getBoundingClientRect(), graphBox = graph.getBoundingClientRect();
    // Graph CSS pixels to screenshot pixels: document zoom, then device scale.
    const pixel = (x: number, y: number) => {
      const zoom = graphBox.width / graph.offsetWidth;
      const px = Math.round(((graphBox.left - sectionBox.left) + x * zoom) * (bitmap.width / sectionBox.width));
      const py = Math.round(((graphBox.top - sectionBox.top) + y * zoom) * (bitmap.height / sectionBox.height));
      return [...context.getImageData(px, py, 1, 1).data];
    };
    return [...element.querySelectorAll<SVGPathElement>("path[data-route][marker-end]")].map((path) => {
      const id = path.getAttribute("marker-end")!.match(/url\(#(.+)\)/)![1];
      const marker = element.querySelector<SVGMarkerElement>(`marker[id="${CSS.escape(id)}"]`)!;
      const polygon = marker.querySelector("polygon")!;
      const length = path.getTotalLength();
      const end = path.getPointAtLength(length);
      const before = path.getPointAtLength(Math.max(0, length - 0.5));
      const norm = Math.hypot(end.x - before.x, end.y - before.y);
      const direction = { x: (end.x - before.x) / norm, y: (end.y - before.y) / norm };
      // The line is straight over its last arrowhead's length (sampled every pixel).
      const viewBox = marker.viewBox.baseVal;
      const unit = marker.markerUnits.baseVal === SVGMarkerElement.SVG_MARKERUNITS_STROKEWIDTH ? parseFloat(getComputedStyle(path).strokeWidth) : 1;
      const sx = marker.markerWidth.baseVal.value / viewBox.width * unit, sy = marker.markerHeight.baseVal.value / viewBox.height * unit;
      const angle = marker.orientType.baseVal === SVGMarkerElement.SVG_MARKER_ORIENT_AUTO ? Math.atan2(direction.y, direction.x) : marker.orientAngle.baseVal.value * Math.PI / 180;
      const place = (point: DOMPoint) => {
        const lx = (point.x - marker.refX.baseVal.value) * sx, ly = (point.y - marker.refY.baseVal.value) * sy;
        return { x: end.x + lx * Math.cos(angle) - ly * Math.sin(angle), y: end.y + lx * Math.sin(angle) + ly * Math.cos(angle) };
      };
      const corners = [...polygon.points].map(place);
      const reach = (point: { x: number; y: number }) => (point.x - end.x) * direction.x + (point.y - end.y) * direction.y;
      const tip = corners.reduce((best, point) => reach(point) > reach(best) ? point : best);
      const base = corners.filter((point) => point !== tip);
      const baseMiddle = { x: (base[0].x + base[1].x) / 2, y: (base[0].y + base[1].y) / 2 };
      const axis = { x: tip.x - baseMiddle.x, y: tip.y - baseMiddle.y };
      const axisLength = Math.hypot(axis.x, axis.y);
      const misalignment = Math.acos(Math.min(1, (axis.x * direction.x + axis.y * direction.y) / axisLength)) * 180 / Math.PI;
      let straight = true;
      for (let back = 1; back <= axisLength; back++) {
        const point = path.getPointAtLength(Math.max(0, length - back));
        const off = Math.abs((point.x - end.x) * direction.y - (point.y - end.y) * direction.x);
        if (off > 0.05) straight = false;
      }
      const tile = graph.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(path.dataset.to!.slice(5))}"]`)!;
      const box = { left: tile.offsetLeft, top: tile.offsetTop, right: tile.offsetLeft + tile.offsetWidth, bottom: tile.offsetTop + tile.offsetHeight };
      const sideways = Math.abs(direction.x) > Math.abs(direction.y);
      const edgeGap = sideways ? tip.x - box.left : tip.y - box.top;
      const withinEdge = sideways ? tip.y > box.top && tip.y < box.bottom : tip.x > box.left && tip.x < box.right;
      // Just inside the tip (where the head is still wider than a pixel) the head is painted: the
      // pixel differs from the background beside it, by as much as the head's own colour does.
      const inside = { x: tip.x - direction.x * 3, y: tip.y - direction.y * 3 };
      const sample = pixel(inside.x, inside.y), beside = pixel(inside.x + direction.y * 6, inside.y - direction.x * 6);
      const contrast = Math.max(...[0, 1, 2].map((index) => Math.abs(sample[index] - beside[index])));
      const painted = contrast >= 12;
      return {
        route: path.dataset.route!, tone: path.classList.contains("highlight") ? "highlight" : "normal", sideways,
        edgeGap, withinEdge, misalignment, straight, painted, contrast,
        baseOffset: Math.hypot(baseMiddle.x - end.x, baseMiddle.y - end.y),
        length: axisLength, width: Math.hypot(base[0].x - base[1].x, base[0].y - base[1].y),
      };
    });
  }, shot.toString("base64"));
}

test.describe("arrowheads", () => {
  for (const { orientation, width } of [{ orientation: "top to bottom", width: 360 }, { orientation: "left to right", width: 700 }]) {
    for (const zoom of [1, 1.3]) {
      test(`running ${orientation} at ${zoom * 100}% zoom, every arrowhead ends on its tile's edge, points along its line and has one size`, async ({ page }) => {
        // A root with two edits and two further edits under the second, selected (the selected branch is highlighted).
        await openView(page, width, `?gym=1&zoom=${zoom}`);
        await click(page, "saffron");
        const heads = await arrowheads(page);
        expect(heads.filter((head) => head.tone === "highlight").length).toBeGreaterThanOrEqual(3);
        expect(heads.filter((head) => head.tone === "normal").length).toBeGreaterThanOrEqual(1);
        for (const head of heads) {
          const label = `${head.tone} ${head.route}`;
          expect(head.sideways, label).toBe(orientation === "left to right");
          // The tip touches the tile's edge, within a pixel, on the edge itself.
          expect(Math.abs(head.edgeGap), label).toBeLessThanOrEqual(1);
          expect(head.withinEdge, label).toBe(true);
          // It points the way the line arrives, and the line is straight beneath it.
          expect(head.misalignment, label).toBeLessThan(1);
          expect(head.straight, label).toBe(true);
          // The line stops at the head's base, so its stroke never pokes past the head.
          expect(head.baseOffset, label).toBeLessThan(0.5);
          expect(head.painted, `${label} is drawn at its tip (contrast ${head.contrast})`).toBe(true);
        }
        // One size for every line, highlighted or not.
        expect(new Set(heads.map((head) => `${head.length.toFixed(2)}x${head.width.toFixed(2)}`)).size).toBe(1);
      });
    }
  }
});

test.describe("tile size", () => {
  const PRESETS = ["small", "medium", "large", "xlarge"] as const;
  type Preset = (typeof PRESETS)[number] | null;
  const setTileSize = (page: Page, preset: Preset) => page.evaluate((p) => (window as any).trace.setTileSize(p), preset);
  /** Rendered sizes: every Trace tile and its image, and the ordinary section's host tiles and thumbnails. */
  const sizes = (page: Page) => page.evaluate(() => {
    const widths = (selector: string) => [...new Set([...document.querySelectorAll<HTMLElement>(selector)].map((element) => element.getBoundingClientRect().width))];
    const heights = (selector: string) => [...new Set([...document.querySelectorAll<HTMLElement>(selector)].map((element) => element.getBoundingClientRect().height))];
    return {
      trace: widths("[data-tile-key]"), traceImage: heights("[data-tile-key] .image"),
      ordinary: widths("[data-host-file-tiles] [data-entry-path]"), thumbnail: widths("[data-host-file-tiles] [data-thumbnail]"),
      preset: document.querySelector<HTMLElement>("[data-host-file-tiles]")?.dataset.size ?? null,
    };
  });
  const boxes = async (page: Page) => ({ ...(await tileBoxes(page, 0)), ...(await tileBoxes(page, 1)) });

  test("changing the host's tile size resizes Trace tiles and the ordinary tiles to match, smoothly and without a stale layout", async ({ page }) => {
    await openView(page, 900, "?fileTiles=1&tileSize=small");
    await click(page, "warm");
    const first = await boxes(page);
    const warm = await key(page, "warm");
    let previous = 92;
    for (const preset of ["large", "medium", "xlarge", "small"] as const) {
      await setTileSize(page, preset);
      // The tiles grow or shrink in motion, from the size shown to the new one.
      const resizing = await page.evaluate(async (k) => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const element = document.querySelector(`[data-tile-key="${CSS.escape(k)}"]`)!;
        return element.getAnimations().map((animation) => (animation.effect as KeyframeEffect).getKeyframes().map((frame) => frame.width).filter(Boolean));
      }, warm);
      await settle(page);
      const shown = await sizes(page);
      // One width for every Trace tile: the host's thumbnail edge plus its tile chrome, as wide as the host's own tiles.
      expect(shown.preset, preset).toBe(preset);
      expect(shown.thumbnail, preset).toHaveLength(1);
      expect(shown.trace, preset).toEqual([shown.thumbnail[0] + 44]);
      if (preset !== "small") expect(shown.trace, preset).toEqual(shown.ordinary);
      // The image keeps its aspect inside the same chrome.
      expect(shown.traceImage, preset).toEqual([Math.round((shown.trace[0] - 12) * 51 / 80)]);
      expect(resizing.flat(), preset).toEqual([`${previous}px`, `${shown.trace[0]}px`]);
      previous = shown.trace[0];
      // Relaid out for the new size: nothing overlaps and every arrowhead still ends on its tile's edge.
      expect(overlaps(await tileBoxes(page, 0)), preset).toEqual([]);
      for (const head of await arrowheads(page)) {
        expect(Math.abs(head.edgeGap), `${preset} ${head.route}`).toBeLessThanOrEqual(1);
        expect(head.misalignment, `${preset} ${head.route}`).toBeLessThan(1);
      }
    }
    // Back at the first size, every tile is exactly where it was: no layout of another size was reused.
    const last = await boxes(page);
    expect(Object.keys(last).sort()).toEqual(Object.keys(first).sort());
    for (const [k, box] of Object.entries(first)) for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(last[k][side] - box[side]), `${k} ${side}`).toBeLessThanOrEqual(0.5);
    expect(await uncaught(page)).toEqual([]);
  });

  test("a host that does not report its tile size gets the default tiles, and its own tile setting for the ordinary section", async ({ page }) => {
    await openView(page, 900, "?fileTiles=1");
    const shown = await sizes(page);
    expect(shown.trace).toEqual([92]);
    expect(shown.traceImage).toEqual([51]);
    // No `size` is passed, so the host's tiles keep their own (global) setting.
    expect(shown.preset).toBe("default");
    // A host that stops reporting it (say, the plugin is moved to an older host) returns to the default too.
    await setTileSize(page, "xlarge");
    await settle(page);
    expect((await sizes(page)).trace).toEqual([172]);
    await setTileSize(page, null);
    await settle(page);
    expect(await sizes(page)).toMatchObject({ trace: [92], traceImage: [51], preset: "default" });
  });
});

test.describe("motion", () => {
  const NAMES = ["village", "palette", "cool", "daylight", "warm", "village"];

  test("rapid clicks end with one focus, no errors and no lingering transforms", async ({ page }) => {
    await openView(page);
    // Alternate between roots and their children that stay rendered across focus changes.
    const sequence = ["village", "daylight", "warm", "rain", "warm", "village"];
    const last = sequence.at(-1)!;
    const keys = await Promise.all(sequence.map((name) => key(page, name)));
    const missing = await page.evaluate(async (keys) => {
      const missing: string[] = [];
      for (const k of keys) {
        const element = document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(k)}"]`);
        if (element) element.click(); else missing.push(k);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return missing;
    }, keys);
    expect(missing).toEqual([]);
    await page.waitForTimeout(500);
    await settle(page);
    expect(await rendered(page, "tone", "focus")).toEqual([last]);
    expect((await state(page)).selected).toEqual([`/pictures/${last}.png`]);
    expect(await uncaught(page)).toEqual([]);
    const lingering = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-tile-key]")].filter((element) => {
      const t = getComputedStyle(element).transform; return t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)";
    }).length);
    expect(lingering).toBe(0);
    // Each tile's painted box equals its laid-out position.
    const mismatched = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-tile-key]")].filter((element) => {
      const r = element.getBoundingClientRect(); const parent = element.parentElement!.getBoundingClientRect();
      return Math.abs(r.left - parent.left - parseFloat(element.style.left)) > 0.5 || Math.abs(r.top - parent.top - parseFloat(element.style.top)) > 0.5;
    }).length);
    expect(mismatched).toBe(0);
  });

  test("a connector regrouped by a relayout morphs from the one it replaces instead of fading in", async ({ page }) => {
    await openView(page, 420);
    for (const name of ["fan", "fan-3", "fan-12", "fan-7", "fan"]) {
      const before = await page.evaluate(() => [...document.querySelectorAll<SVGPathElement>("path[data-route]")].map((path) => [path.dataset.route!, path.dataset.from!] as const));
      await (await card(page, name)).click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const excess = await page.evaluate((previous) => {
        const shown = new Set(previous.map(([id]) => id));
        const paths = [...document.querySelectorAll<SVGPathElement>("path[data-route]")];
        const present = new Set(paths.map((path) => path.dataset.route!));
        const fromZero = (path: SVGPathElement) => path.getAnimations().some((animation) => Number((animation.effect as KeyframeEffect).getKeyframes()[0]?.opacity ?? 1) === 0);
        // Per source, only connectors beyond those that vanished may fade in.
        const sources = new Set(paths.map((path) => path.dataset.from!));
        return [...sources].flatMap((source) => {
          const vanished = previous.filter(([id, from]) => from === source && !present.has(id)).length;
          const fresh = paths.filter((path) => path.dataset.from === source && !shown.has(path.dataset.route!));
          const fading = fresh.filter(fromZero).length;
          return fading > Math.max(0, fresh.length - vanished) ? [`${source}: ${fading} fade in, ${fresh.length} new, ${vanished} vanished`] : [];
        });
      }, before);
      expect(excess, name).toEqual([]);
      await settle(page);
    }
  });

  test("a tile interrupted while fading in continues from its displayed opacity", async ({ page }) => {
    await openView(page);
    const samples = await page.evaluate(async (target) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const select = (name: string) => document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape((window as any).trace.backend.key(name))}"]`)!.click();
      const opacity = () => {
        const element = document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(target)}"]`);
        return element ? Number(getComputedStyle(element).opacity) : null;
      };
      select("daylight");
      // Interrupt once the newly shown tile is part-way through its fade.
      let before = opacity();
      for (let i = 0; i < 30 && !(before !== null && before > 0.15 && before < 0.85); i++) { await frame(); before = opacity(); }
      select("warm");
      const after: Array<number | null> = [];
      for (let i = 0; i < 4; i++) { await frame(); after.push(opacity()); }
      return { before, after };
    }, await key(page, "merge"));
    expect(samples.before).toBeGreaterThan(0.15);
    expect(samples.before).toBeLessThan(0.85);
    for (const value of samples.after) {
      expect(value).not.toBeNull();
      expect(value!).toBeGreaterThanOrEqual(samples.before! - 0.05);
    }
    // It keeps fading rather than snapping to full opacity.
    expect(samples.after[0]!).toBeLessThan(0.95);
  });

  test("an interrupted transition settles where a fresh selection of the same node would", async ({ page }) => {
    const settled = async (interrupt: boolean) => {
      await openView(page);
      await page.evaluate(() => (window as any).trace.setWidth(700));
      await page.waitForTimeout(200); await settle(page);
      if (interrupt) {
        await (await card(page, "village")).click();
        await page.waitForTimeout(60);
        await (await card(page, "daylight")).click({ force: true });
      } else {
        await (await card(page, "village")).click(); await settle(page);
        await (await card(page, "daylight")).click();
      }
      await page.waitForTimeout(300); await settle(page);
      const boxes = await tileBoxes(page, 0);
      const names = await rendered(page);
      return { boxes, names };
    };
    const interrupted = await settled(true);
    // Compare against clicking only the final node from a fresh load.
    await openView(page);
    await page.evaluate(() => (window as any).trace.setWidth(700));
    await page.waitForTimeout(200); await settle(page);
    await click(page, "daylight");
    await page.waitForTimeout(200); await settle(page);
    const fresh = { boxes: await tileBoxes(page, 0), names: await rendered(page) };
    expect(interrupted.names).toEqual(fresh.names);
    const delta = (a: Record<string, Box>, b: Record<string, Box>) => Object.keys(b).map((k) => Math.max(Math.abs(a[k].x - b[k].x), Math.abs(a[k].y - b[k].y), Math.abs(a[k].width - b[k].width), Math.abs(a[k].height - b[k].height)));
    expect(Object.keys(interrupted.boxes).sort()).toEqual(Object.keys(fresh.boxes).sort());
    expect(Math.max(...delta(interrupted.boxes, fresh.boxes))).toBeLessThanOrEqual(1);
    void NAMES;
  });

  test("motion starts every tile where it was displayed, even when the graph changes width", async ({ page }) => {
    await openView(page);
    await click(page, "village");
    // Daylight's six children widen the graph.
    const daylight = await key(page, "daylight");
    const result = await page.evaluate(async (target) => {
      const section = document.querySelector("section[data-component]")!;
      const graph = () => section.querySelector<HTMLElement>(".graph")!;
      const boxes = () => new Map([...section.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => [element.dataset.tileKey!, element.getBoundingClientRect()]));
      const routes = () => new Set([...section.querySelectorAll<SVGPathElement>("path[data-route]")].map((path) => path.dataset.route!));
      const before = boxes(), shownRoutes = routes(), widthBefore = graph().getBoundingClientRect().width;
      section.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(target)}"]`)!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const first = boxes();
      const jumps = [...first].filter(([k, box]) => before.has(k) && Math.max(Math.abs(box.left - before.get(k)!.left), Math.abs(box.top - before.get(k)!.top)) > 2).map(([k]) => k);
      const paths = [...section.querySelectorAll<SVGPathElement>("path[data-route]")];
      const refaded = paths.filter((path) => shownRoutes.has(path.dataset.route!) && path.getAnimations().some((animation) => (animation.effect as KeyframeEffect).getKeyframes().some((frame) => "opacity" in frame))).length;
      const undimmed = paths.filter((path) => shownRoutes.has(path.dataset.route!) && path.classList.contains("unrelated") && Number(getComputedStyle(path).opacity) > 0.5).length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { jumps, refaded, undimmed, widthChanged: Math.abs(graph().getBoundingClientRect().width - widthBefore) > 20 };
    }, daylight);
    expect(result.widthChanged).toBe(true);
    expect(result.jumps).toEqual([]);
    expect(result.refaded).toBe(0);
    expect(result.undimmed).toBe(0);
  });

  test("tiles and connectors that leave fade out where they were, then are gone", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const evening = await key(page, "evening");
    const before = await page.evaluate((k) => {
      const box = document.querySelector(`[data-tile-key="${CSS.escape(k)}"]`)!.getBoundingClientRect();
      return { x: box.x, y: box.y, routes: document.querySelectorAll(`path[data-route][data-to="node:${CSS.escape(k)}"]`).length };
    }, evening);
    expect(before.routes).toBeGreaterThan(0);
    // Select and sample in one evaluation, so a slow runner cannot miss the 180 ms fade.
    const during = await page.evaluate(async ({ target, label }) => {
      document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(target)}"]`)!.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      for (const animation of document.getAnimations()) animation.pause();
      const ghosts = [...document.querySelectorAll<HTMLElement>("[data-motion-ghost]")];
      const tile = ghosts.find((ghost) => ghost.classList.contains("tile") && ghost.textContent?.includes(label));
      const box = tile?.getBoundingClientRect();
      const result = {
        tile: tile ? { x: box!.x, y: box!.y, opacity: Number(getComputedStyle(tile).opacity),
          fading: tile.getAnimations().some((animation) => Number((animation.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity ?? 1) === 0),
          interactive: !!tile.querySelector("[data-node-key]") || !tile.closest("[inert]") } : null,
        paths: ghosts.filter((ghost) => ghost instanceof SVGPathElement).length,
      };
      for (const animation of document.getAnimations()) animation.play();
      return result;
    }, { target: await key(page, "daylight"), label: "evening prompt" });
    expect(during.tile).not.toBeNull();
    expect(Math.abs(during.tile!.x - before.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(during.tile!.y - before.y)).toBeLessThanOrEqual(2);
    expect(during.tile!.opacity).toBeGreaterThan(0);
    expect(during.tile!.fading).toBe(true);
    expect(during.tile!.interactive).toBe(false);
    expect(during.paths).toBeGreaterThan(0);
    await settle(page);
    expect(await page.locator("[data-motion-ghost]").count()).toBe(0);
    await expect(await tile(page, "evening")).toHaveCount(0);
  });

  test("a tile that returns while fading out continues from its fading copy instead of appearing twice", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const result = await page.evaluate(async ({ daylight, warm, evening }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const select = (k: string) => document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(k)}"]`)!.click();
      const copies = () => [...document.querySelectorAll<HTMLElement>("[data-motion-ghost].tile")].filter((ghost) => ghost.textContent?.includes("evening prompt"));
      select(daylight);
      // Wait until evening's copy is part-way through fading out.
      let copy = copies()[0];
      for (let i = 0; i < 30 && !(copy && Number(getComputedStyle(copy).opacity) < 0.9); i++) { await frame(); copy = copies()[0]; }
      const left = copy ? Number(getComputedStyle(copy).opacity) : null;
      select(warm);
      await frame();
      for (const animation of document.getAnimations()) animation.pause();
      const tile = document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(evening)}"]`);
      const sample = { left, copies: copies().length, returned: tile ? Number(getComputedStyle(tile).opacity) : null };
      for (const animation of document.getAnimations()) animation.play();
      return sample;
    }, { daylight: await key(page, "daylight"), warm: await key(page, "warm"), evening: await key(page, "evening") });
    expect(result.left).not.toBeNull();
    expect(result.copies).toBe(0);
    expect(result.returned).not.toBeNull();
    // It fades back in from where its copy had faded to, rather than from nothing or at full opacity.
    expect(result.returned!).toBeGreaterThan(0.05);
    expect(result.returned!).toBeLessThanOrEqual(result.left! + 0.05);
    await settle(page);
    expect(await page.locator("[data-motion-ghost]").count()).toBe(0);
  });

  test("reduced motion starts no animations when selection changes", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openView(page);
    await (await card(page, "warm")).click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
  });
});

test.describe("scroll anchoring", () => {
  test.use({ viewport: { width: 1200, height: 700 } });
  const scrollTop = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop);

  test("the clicked tile stays where it was on screen while its graph relayouts", async ({ page }) => {
    await openView(page, undefined, "?many=8");
    // Selecting quiet after rain drops rain's siblings and with them the merge
    // junction above rain's generation, so quiet moves up in its graph.
    await click(page, "warm");
    await click(page, "rain");
    await page.evaluate(() => { document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop += 200; });
    await settle(page);
    const offset = async () => page.evaluate((k) => {
      const element = document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(k)}"]`)!;
      return { screen: element.getBoundingClientRect().top, inGraph: parseFloat(element.style.top) };
    }, await key(page, "quiet"));
    const before = await offset();
    await click(page, "quiet");
    const after = await offset();
    expect(Math.abs(after.inGraph - before.inGraph)).toBeGreaterThan(10);
    expect(Math.abs(after.screen - before.screen)).toBeLessThanOrEqual(2);
  });

  test("keyboard navigation reveals a tile that lies outside the view", async ({ page }) => {
    await openView(page, undefined, "?many=8");
    await click(page, "fan");
    // Scroll so the fan's children start below the visible area.
    const fanBottom = await page.evaluate((k) => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
      const tile = document.querySelector<HTMLElement>(`[data-tile-key="${CSS.escape(k)}"]`)!;
      view.scrollTop += tile.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom + 4;
      return tile.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom;
    }, await key(page, "fan"));
    expect(fanBottom).toBeLessThanOrEqual(0);
    await (await card(page, "fan")).focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await settle(page);
    const result = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!.getBoundingClientRect();
      const active = document.activeElement as HTMLElement;
      const box = active.getBoundingClientRect();
      return { key: active.dataset.nodeKey ?? null, inside: box.top >= view.top - 1 && box.bottom <= view.bottom + 1 };
    });
    expect(result.key).not.toBeNull();
    expect(result.key).not.toBe(await key(page, "fan"));
    expect(result.inside).toBe(true);
  });

  test("scrolling by the user wins over the anchor, also when another section relayouts later", async ({ page }) => {
    await openView(page, undefined, "?many=8");
    await (await card(page, "daylight")).click();
    await page.waitForTimeout(60);
    await page.mouse.move(400, 400);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(250);
    const scrolled = await scrollTop(page);
    expect(scrolled).toBeGreaterThan(100);
    // Another component commits within the anchor window.
    await page.evaluate(() => (window as any).trace.backend.startGeneration("forest", "gen-anchor"));
    await page.waitForTimeout(400);
    await settle(page);
    expect(await scrollTop(page)).toBe(scrolled);
  });
});

test("collapsing and expanding sections toggles their graphs; the first three start expanded", async ({ page }) => {
  await openView(page);
  const sections = page.locator("section.component[data-component]");
  await expect(sections).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(sections.nth(i).locator("button.heading")).toHaveAttribute("aria-expanded", "true");
  const forest = sections.nth(1);
  await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
  await forest.locator("button.heading").click();
  await expect(forest.locator("button.heading")).toHaveAttribute("aria-expanded", "false");
  await expect(forest.locator("[data-tile-key]")).toHaveCount(0);
  await expect(sections.nth(0).locator("[data-tile-key]").first()).toBeVisible();
  await forest.locator("button.heading").click();
  await expect(forest.locator("button.heading")).toHaveAttribute("aria-expanded", "true");
  await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
});

test.describe("keyboard", () => {
  test("arrow keys move the selection to a neighbouring node and keep keyboard focus on it", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const family = new Set(await Promise.all(["village", "palette", "mist", "lantern", "evening", "rain", "merge"].map((n) => key(page, n))));
    for (const arrow of ["ArrowDown", "ArrowRight"]) {
      await click(page, "warm");
      await (await card(page, "warm")).focus();
      const before = await state(page);
      await page.keyboard.press(arrow);
      await settle(page);
      const active = await page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null);
      expect(active, `${arrow} keeps focus on a tile`).not.toBeNull();
      expect(family.has(active!), `${arrow} lands on a neighbour`).toBe(true);
      const after = await state(page);
      expect(JSON.stringify([after.selected, after.target])).not.toBe(JSON.stringify([before.selected, before.target]));
      expect(await rendered(page, "tone", "focus")).toHaveLength(1);
    }
  });

  test("Enter opens a file node", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await (await card(page, "warm")).focus();
    await page.keyboard.press("Enter");
    expect((await state(page)).opened).toEqual(["/pictures/warm.png"]);
  });
});

test.describe("theme colours", () => {
  // The harness themes copy host themes that, like most, define no `--accent-text`.
  for (const theme of ["light", "dark"]) {
    test(`connectors follow the ${theme} theme: the selected branch is drawn in the accent and every arrowhead matches its line`, async ({ page }) => {
      await openView(page, undefined, `?theme=${theme}`);
      await click(page, "warm");
      const result = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.append(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const section = document.querySelector("section.component[data-component]")!;
        const lines = [...section.querySelectorAll<SVGPathElement>("path[data-route]")].map((path) => {
          const style = getComputedStyle(path);
          const marker = path.getAttribute("marker-end")?.match(/url\(#(.+)\)/)?.[1];
          const head = marker ? section.querySelector<SVGPolygonElement>(`marker[id="${marker}"] polygon`) : null;
          return {
            tone: path.classList.contains("highlight") ? "highlight" : path.classList.contains("branch") ? "branch" : "other",
            stroke: style.stroke, width: parseFloat(style.strokeWidth), head: head ? getComputedStyle(head).fill : null,
          };
        });
        const dots = [...section.querySelectorAll<SVGCircleElement>("circle.junction.highlight")].map((dot) => getComputedStyle(dot).fill);
        return { accent, lines, dots };
      });
      const { accent, lines, dots } = result;
      const highlight = lines.filter((line) => line.tone === "highlight");
      const branch = lines.filter((line) => line.tone === "branch");
      expect(highlight.length).toBeGreaterThan(0);
      expect(branch.length + lines.filter((line) => line.tone === "other").length).toBeGreaterThan(0);
      for (const line of lines) {
        // An undefined token would make the stroke `none` and the arrowhead black.
        expect(line.stroke).not.toBe("none");
        if (line.head !== null) expect(line.head, `${line.tone} arrowhead`).toBe(line.stroke);
      }
      for (const line of highlight) expect(line.stroke).toBe(accent);
      for (const dot of dots) expect(dot).toBe(accent);
      // The selected branch stands out from every other line.
      const others = lines.filter((line) => line.tone !== "highlight");
      for (const line of others) {
        expect(line.stroke).not.toBe(accent);
        expect(line.width).toBeLessThan(highlight[0].width);
      }
    });
  }
});
