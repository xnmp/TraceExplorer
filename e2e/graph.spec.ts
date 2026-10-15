import { settledScrollTop } from "./motion-support";
import { test, expect, type Page } from "@playwright/test";
import { openView, click, key, tile, card, caret, state, uncaught, settle, tileBoxes, overlaps, rendered, type Box } from "./support";
import { awaitMotionStarted, holdMotion, motionState, releaseMotion } from "./animation-control";

/** Rendered width and image height of every tile, keyed by node key. */
const tileSizes = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => {
  const image = element.querySelector<HTMLElement>(".image, .cover-image")!;
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

  test("selecting a node dims the rest and keeps every branch, without resizing any tile", async ({ page }) => {
    await openView(page);
    const initial = Object.values(await tileSizes(page))[0];
    const uniform = async () => {
      for (const [k, size] of Object.entries(await tileSizes(page))) expect(size, k).toEqual(initial);
    };
    await click(page, "warm");
    await uniform();
    expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
    expect(await rendered(page, "tone", "related")).toEqual(["evening", "merge", "palette", "rain", "village"]);
    const unrelated = await rendered(page, "tone", "unrelated");
    for (const name of ["daylight", "cool", "forest", "fan"]) expect(unrelated).toContain(name);
    expect(unrelated).not.toContain("warm");

    await click(page, "rain");
    await uniform();
    expect(await rendered(page, "tone", "focus")).toEqual(["rain"]);
    for (const name of ["village", "palette"]) await expect(await tile(page, name)).toHaveAttribute("data-tone", "related");
    await expect(await tile(page, "daylight")).toHaveAttribute("data-tone", "unrelated");

    // Selection never drops a branch (explicit expansion): warm's children stay until warm's caret collapses it.
    await click(page, "daylight");
    await uniform();
    for (const name of ["evening", "rain", "quiet"]) await expect(await tile(page, name)).toHaveCount(1);
    await (await caret(page, "warm")).click();
    await settle(page);
    await uniform();
    for (const name of ["evening", "rain", "quiet"]) await expect(await tile(page, name)).toHaveCount(0);
    expect(await rendered(page, "tone", "focus"), "the caret leaves the selection").toEqual(["daylight"]);
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

  const runsDown = (boxes: Record<string, Box>, edges: Array<[string, string]>) => {
    for (const [parent, child] of edges) if (boxes[parent] && boxes[child]) expect(boxes[child].y, `${child} below ${parent}`).toBeGreaterThanOrEqual(boxes[parent].y + boxes[parent].height);
  };

  test("a deep band uses sideways space and keeps its grid cover pinned while opening generations", async ({ page }) => {
    await openView(page, 900, "?deeper=1");
    const names = ["forest", "forest-mist", "autumn", "mist-dawn", "mist-dusk"];
    const [forest, mist, autumn, dawn, dusk] = await Promise.all(names.map((name) => key(page, name)));
    const coverX = (await (await tile(page, "forest")).boundingBox())!.x;
    for (const name of ["forest", "forest-mist", "mist-dawn", "mist-dusk", "autumn"]) {
      await click(page, name);
      const boxes = await tileBoxes(page, "forest");
      for (const [parent, child] of [[forest, mist], [forest, autumn], [mist, dawn], [dawn, dusk]]) if (boxes[parent] && boxes[child]) {
        expect(boxes[child].y >= boxes[parent].y + boxes[parent].height || boxes[child].x >= boxes[parent].x + boxes[parent].width).toBe(true);
      }
      expect(overlaps(boxes)).toEqual([]);
      expect((await (await tile(page, "forest")).boundingBox())!.x).toBeCloseTo(coverX, 1);
    }
    // Selecting autumn hides nothing; collapsing forest-mist hides its generations.
    await expect(await tile(page, "mist-dusk")).toHaveCount(1);
    await (await caret(page, "forest-mist")).click();
    await settle(page);
    await expect(await tile(page, "mist-dawn")).toHaveCount(0);
    await expect(await tile(page, "mist-dusk")).toHaveCount(0);
    expect((await (await tile(page, "forest")).boundingBox())!.x).toBeCloseTo(coverX, 1);
    expect(await uncaught(page)).toEqual([]);
  });

  test("generating, saving and discarding a batch keeps its band downward and its cover pinned", async ({ page }) => {
    await openView(page, 900);
    await click(page, "forest-mist");
    const forest = await key(page, "forest"), children = await Promise.all(["forest-mist", "autumn"].map((name) => key(page, name)));
    const coverX = (await (await tile(page, "forest")).boundingBox())!.x;
    const check = async (expected = children) => {
      const boxes = await tileBoxes(page, "forest");
      for (const child of expected) expect(boxes[child], `visible batch member ${child}`).toBeTruthy();
      runsDown(boxes, expected.map((child) => [forest, child]));
      expect(overlaps(boxes)).toEqual([]);
      expect((await (await tile(page, "forest")).boundingBox())!.x).toBeCloseTo(coverX, 1);
    };
    for (let i = 1; i <= 4; i++) children.push(await page.evaluate((name) => (window as any).trace.backend.startGeneration("forest", name), `variation-${i}`));
    await settle(page); await check();
    for (let i = 1; i <= 4; i++) await page.evaluate((name) => (window as any).trace.backend.completeGeneration(name), `variation-${i}`);
    await settle(page); await check();
    for (let i = 1; i <= 4; i++) await page.evaluate((name) => (window as any).trace.backend.saveGeneration(name), `variation-${i}`);
    await settle(page); await check();
    for (let i = 1; i <= 4; i++) await page.evaluate((name) => (window as any).trace.backend.discardGeneration(name), `variation-${i}`);
    await settle(page); await check(children.slice(0, 2));
    for (const child of children.slice(2)) await expect(page.locator(`[data-tile-key="${child}"]`)).toHaveCount(0);
    expect(await uncaught(page)).toEqual([]);
  });

  test("bands keep downward orientation after saving and switching folders", async ({ page }) => {
    await openView(page, 900);
    const forest = await key(page, "forest"), mist = await key(page, "forest-mist");
    await page.evaluate(() => { const b = (window as any).trace.backend; b.startGeneration("forest", "third"); b.completeGeneration("third"); b.saveGeneration("third"); });
    for (const directory of ["/pictures-mirror", "/pictures"]) {
      await page.evaluate((path) => (window as any).trace.navigate(path), directory); await settle(page);
      await click(page, "forest");
      const boxes = await tileBoxes(page, "forest"); runsDown(boxes, [[forest, mist], [forest, await key(page, "third")]]);
      expect(overlaps(boxes)).toEqual([]);
    }
    expect(await uncaught(page)).toEqual([]);
  });

  test("the cover chevron closes the band without changing its selected file", async ({ page }) => {
    await openView(page, 900); await click(page, "forest");
    await (await tile(page, "forest")).getByRole("button", { name: "Collapse stack" }).click(); await settle(page);
    await expect(page.locator('section[aria-label="forest"] .graph')).toHaveCount(0);
    expect((await state(page)).selected).toEqual(["/pictures/forest.png"]);
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
  for (const width of [360, 700]) {
    for (const zoom of [1, 1.3]) {
      test(`a compact band at width ${width} and ${zoom * 100}% zoom, every arrowhead ends on its tile's edge, points along its line and has one size`, async ({ page }) => {
        // A root with two edits and two further edits under the second, selected (the selected branch is highlighted).
        await openView(page, width, `?gym=1&zoom=${zoom}`);
        await click(page, "saffron");
        const heads = await arrowheads(page);
        expect(heads.filter((head) => head.tone === "highlight").length).toBeGreaterThanOrEqual(3);
        expect(heads.filter((head) => head.tone === "normal").length).toBeGreaterThanOrEqual(1);
        for (const head of heads) {
          const label = `${head.tone} ${head.route}`;
          // Compact bands may enter from the top or left; the same tip/axis contract holds.
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
      trace: widths("[data-tile-key]"), traceImage: heights("[data-grid-band] [data-tile-key] .image"), coverImage: heights("[data-grid-cell] [data-tile-key] .image"),
      ordinary: widths("[data-host-file-tile]"), thumbnail: heights("[data-host-file-tile] .icon"),
      preset: document.querySelector<HTMLElement>("[data-host-file-tile]")?.dataset.size ?? null,
    };
  });
  const boxes = async (page: Page) => ({ ...(await tileBoxes(page, 0)), ...(await tileBoxes(page, 1)) });

  test("changing the host's tile size resizes Trace tiles and the ordinary tiles to match, at once and without a stale layout", async ({ page }) => {
    await openView(page, 900, "?fileTile=1&tileSize=small");
    await click(page, "warm");
    const first = await boxes(page);
    const warm = await key(page, "warm");
    for (const preset of ["large", "medium", "xlarge", "small"] as const) {
      // Count the motion the change starts, however short: polling after a frame misses one that a
      // loaded machine runs whole (or starts) outside that frame.
      const startedBefore = (await motionState(page)).started;
      await setTileSize(page, preset);
      await settle(page);
      // A tile size change is a metrics change the user did not make in the view: the tiles take
      // the new size at once, with no resize motion (docs/scene-transactions.md, "Native findings fixes").
      const resizing = (await motionState(page)).started - startedBefore;
      const shown = await sizes(page);
      // One width for every Trace tile: the host's thumbnail edge plus its tile chrome, as wide as the host's own tiles.
      expect(shown.preset, preset).toBe(preset);
      expect(shown.thumbnail, preset).toHaveLength(1);
      expect(shown.coverImage, preset).toEqual(shown.thumbnail);
      expect(shown.trace, preset).toEqual([shown.thumbnail[0] + 44]);
      expect(shown.ordinary[0], preset).toBeGreaterThanOrEqual(shown.trace[0]);
      // The image keeps its aspect inside the same chrome.
      expect(shown.traceImage, preset).toEqual([Math.round((shown.trace[0] - 12) * 51 / 80)]);
      expect(resizing, `${preset}: motion started`).toBe(0);
      // Relaid out for the new size: nothing overlaps and every arrowhead still ends on its tile's edge.
      expect(overlaps(await tileBoxes(page, 0)), preset).toEqual([]);
      for (const head of await arrowheads(page)) {
        expect(Math.abs(head.edgeGap), `${preset} ${head.route}`).toBeLessThanOrEqual(1);
        expect(head.misalignment, `${preset} ${head.route}`).toBeLessThan(1);
      }
    }
    // Back at the first size, the same tiles show at that size. Placement history expires when the
    // tile size changes, so the click's history-preserving placement is not expected back; instead,
    // arriving from another size must give the same layout: no layout of another size was reused.
    const viaXlarge = await boxes(page);
    expect(Object.keys(viaXlarge).sort()).toEqual(Object.keys(first).sort());
    for (const [k, box] of Object.entries(first)) for (const side of ["width", "height"] as const) expect(Math.abs(viaXlarge[k][side] - box[side]), `${k} ${side}`).toBeLessThanOrEqual(0.5);
    await setTileSize(page, "medium");
    await settle(page);
    await setTileSize(page, "small");
    await settle(page);
    const viaMedium = await boxes(page);
    expect(Object.keys(viaMedium).sort()).toEqual(Object.keys(viaXlarge).sort());
    for (const [k, box] of Object.entries(viaXlarge)) for (const side of ["x", "y", "width", "height"] as const) expect(Math.abs(viaMedium[k][side] - box[side]), `${k} ${side}`).toBeLessThanOrEqual(0.5);
    expect(await uncaught(page)).toEqual([]);
  });

  test("a host that does not report its tile size gets the default tiles, and its own tile setting for the ordinary section", async ({ page }) => {
    await openView(page, 900, "?fileTile=1");
    const shown = await sizes(page);
    expect(shown.trace).toEqual([92]);
    expect(shown.traceImage).toEqual([51]);
    expect(shown.coverImage).toEqual(shown.thumbnail);
    // No `size` is passed, so the host's tiles keep their own (global) setting.
    expect(shown.preset).toBe("default");
    // A host that stops reporting it (say, the plugin is moved to an older host) returns to the default too.
    await setTileSize(page, "xlarge");
    await settle(page);
    expect((await sizes(page)).trace).toEqual([172]);
    await setTileSize(page, null);
    await settle(page);
    expect(await sizes(page)).toMatchObject({ trace: [92], traceImage: [51], coverImage: [64], preset: "default" });
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
        // A tile the previous click reveals is drawn once its scene commits, images included (a few frames when they are cold).
        let element: HTMLElement | null = null;
        for (let frame = 0; frame < 120 && !element; frame++) {
          element = document.querySelector<HTMLElement>(`[data-node-key="${CSS.escape(k)}"]`);
          if (!element) await new Promise((resolve) => requestAnimationFrame(resolve));
        }
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
      // Held at its first pose: a connector that fades in shows no instance there.
      await holdMotion(page);
      await (await card(page, name)).click();
      await awaitMotionStarted(page);
      const excess = await page.evaluate((previous) => {
        const shown = new Set(previous.map(([id]) => id));
        const paths = [...document.querySelectorAll<SVGPathElement>("path[data-route]")];
        const present = new Set(paths.map((path) => path.dataset.route!));
        const opacity = (element: Element) => { let value = 1; for (let at: Element | null = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
        const instances = (id: string) => [...document.querySelectorAll<SVGPathElement>("path[data-route], path[data-motion-route]")].filter((path) => (path.dataset.route ?? path.dataset.motionRoute) === id);
        const fromZero = (path: SVGPathElement) => Math.max(0, ...instances(path.dataset.route!).map(opacity)) <= .01;
        // Per source, only connectors beyond those that vanished may fade in.
        const sources = new Set(paths.map((path) => path.dataset.from!));
        return [...sources].flatMap((source) => {
          const vanished = previous.filter(([id, from]) => from === source && !present.has(id)).length;
          const fresh = paths.filter((path) => path.dataset.from === source && !shown.has(path.dataset.route!));
          const fading = fresh.filter(fromZero).length;
          return fading > Math.max(0, fresh.length - vanished) ? [`${source}: ${fading} fade in, ${fresh.length} new, ${vanished} vanished`] : [];
        });
      }, before);
      await releaseMotion(page);
      expect(excess, name).toEqual([]);
      await settle(page);
    }
  });

  // Selection alone changes no geometry (explicit expansion): it neither restarts nor finishes a
  // running entrance. (Before, a selection revealed a neighborhood and finished the entrance.)
  test("selecting a leaf during an entrance leaves the entrance running untouched", async ({ page }) => {
    await openView(page, undefined, "", false);
    await holdMotion(page);
    try {
      await page.locator('section[data-component]').first().locator('[data-stack-toggle]').click();
      await awaitMotionStarted(page);
      const entrance = await motionState(page);
      expect(entrance.running, "the entrance is held").toHaveLength(1);
      const copies = await page.locator('[data-motion-ghost]').count();
      await (await card(page, "cool")).evaluate((el: HTMLElement) => el.click());
      await awaitMotionStarted(page);
      const after = await motionState(page);
      expect(after.started, "no motion started").toBe(entrance.started);
      expect(after.running.map((epoch) => epoch.epoch), "the same epoch runs on").toEqual(entrance.running.map((epoch) => epoch.epoch));
      expect(await page.locator('[data-motion-ghost]').count(), "the entrance's own connector copies, unchanged").toBe(copies);
      expect(await page.locator('[data-ghost-tile-key]').count(), "no tile departs").toBe(0);
      expect(await rendered(page, "tone", "focus")).toEqual(["cool"]);
    } finally { await releaseMotion(page); }
    await settle(page);
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

  test("motion starts every tile where it was displayed while the band keeps its full width", async ({ page }) => {
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
      // A connector already shown is faded when the motion driver writes an opacity to it or to a layer holding it.
      const fading = (element: Element) => { for (let at: Element | null = element; at && at !== section; at = at.parentElement) if ((window as any).trace.motion.owns(at) && (at as HTMLElement).style.opacity !== "") return true; return false; };
      const instances = [...section.querySelectorAll<SVGPathElement>("path[data-route], path[data-motion-route]")];
      const refaded = instances.filter((path) => shownRoutes.has(path.dataset.route ?? path.dataset.motionRoute!) && fading(path)).length;
      const undimmed = paths.filter((path) => shownRoutes.has(path.dataset.route!) && path.classList.contains("unrelated") && Number(getComputedStyle(path).opacity) > 0.5).length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { jumps, refaded, undimmed, widthChanged: Math.abs(graph().getBoundingClientRect().width - widthBefore) > 20 };
    }, daylight);
    expect(result.widthChanged).toBe(false);
    expect(result.jumps).toEqual([]);
    expect(result.refaded).toBe(0);
    expect(result.undimmed).toBe(0);
  });

  // Selection never removes a branch (explicit expansion): from the commit of daylight's first click
  // (which opens its children) on, warm's open branch stays drawn, with no departing copy.
  test("opening another branch keeps the open one, tiles and connectors, from its first frame", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const evening = await key(page, "evening");
    await expect(await tile(page, "evening")).toHaveCount(1);
    const result = await page.evaluate(async ({ target, evening }) => {
      document.querySelector<HTMLElement>(`[data-node-key="${target}"]`)!.click();
      // The first frame of the new scene (it commits once its images are drawable): the target is the focus.
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (document.querySelector<HTMLElement>(`[data-tile-key="${target}"]`)?.dataset.tone === "focus") break;
      }
      return { tiles: document.querySelectorAll(`[data-tile-key="${evening}"]`).length,
        paths: document.querySelectorAll(`path[data-to="node:${evening}"]`).length,
        ghosts: document.querySelectorAll(`[data-ghost-tile-key="${evening}"]`).length };
    }, { target: await key(page, "daylight"), evening });
    expect(result).toEqual({ tiles: 1, paths: 1, ghosts: 0 });
    await settle(page);
    await expect(await tile(page, "evening")).toHaveCount(1);
  });

  test("rapid branch swaps return one fully opaque tile without a fading copy", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await holdMotion(page);
    try {
      for (const name of ["daylight", "warm"]) {
        await (await card(page, name)).click();
        await awaitMotionStarted(page);
      }
      const evening = await key(page, "evening");
      await expect(await tile(page, "evening")).toHaveCount(1);
      expect(await (await tile(page, "evening")).evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);
      // No departing copy of it (daylight's opening branch has connector copies in motion layers).
      expect(await page.locator(`[data-ghost-tile-key="${evening}"]`).count()).toBe(0);
    } finally { await releaseMotion(page); }
    await settle(page);
  });

  test("reduced motion starts no animations when selection changes", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openView(page);
    const startedBefore = (await motionState(page)).started;
    await (await card(page, "warm")).click();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await settle(page);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect((await motionState(page)).started, "motion started").toBe(startedBefore);
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
    expect(Math.abs(after.inGraph - before.inGraph), "feasible click keeps its attached position").toBeLessThanOrEqual(1);
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
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(100);
    const scrolled = await settledScrollTop(page);
    // Another component commits within the anchor window.
    await page.evaluate(() => (window as any).trace.backend.startGeneration("forest", "gen-anchor"));
    await page.waitForTimeout(400);
    await settle(page);
    expect(await scrollTop(page)).toBe(scrolled);
  });
});

test("opening and closing stacks toggles their bands while covers remain in the grid", async ({ page }) => {
  await openView(page);
  const sections = page.locator("section.component[data-component]");
  await expect(sections).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(sections.nth(i).locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  const forest = sections.nth(1);
  await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
  await forest.locator("[data-stack-toggle]").click();
  await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
  await expect(forest.locator(".graph")).toHaveCount(0);
  await expect(forest.locator("[data-tile-key]")).toHaveCount(1);
  await expect(sections.nth(0).locator("[data-tile-key]").first()).toBeVisible();
  await forest.locator("[data-stack-toggle]").click();
  await expect(forest.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(forest.locator("[data-tile-key]").first()).toBeVisible();
});

test.describe("keyboard", () => {
  test("arrow keys move the selection to a neighbouring node and keep keyboard focus on it", async ({ page }) => {
    await openView(page);
    // Each round's click on warm selects it (the first one opens its children). A click on warm
    // while it is the selection would collapse it instead (a second click toggles). Down reaches warm's children; right reaches the next tile on its row. The mist and lantern
    // references are badges, not tiles, so arrows never land on them.
    const neighbours = {
      ArrowDown: new Set(await Promise.all(["evening", "rain", "merge"].map((n) => key(page, n)))),
      ArrowRight: new Set([await key(page, "cool")]),
    };
    for (const arrow of ["ArrowDown", "ArrowRight"] as const) {
      const family = neighbours[arrow];
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
