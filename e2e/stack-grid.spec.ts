import { test, expect, type Page } from "@playwright/test";
import { openView, key, state, settle, uncaught, rendered } from "./support";
import { awaitAnimationsCreated, holdScriptedAnimations, releaseScriptedAnimations } from "./animation-control";

const stack = (page: Page, name: string) => page.locator(`section[data-component][aria-label="${name}"]`);
const gridBoxes = (page: Page) => page.evaluate(() => {
  const view = document.querySelector<HTMLElement>("[data-testid=trace-view]")!;
  return Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((element) => {
    const box = element.getBoundingClientRect();
    return [element.dataset.gridCell!, { x: box.x, y: box.y + view.scrollTop, width: box.width }];
  }));
});
const sameColumns = (before: Awaited<ReturnType<typeof gridBoxes>>, after: Awaited<ReturnType<typeof gridBoxes>>) => {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const id of Object.keys(before)) expect(after[id].x, id).toBeCloseTo(before[id].x, 1);
};

for (const theme of ["light", "dark"]) for (const host of ["", "&fileTile=1&tileSize=small"]) {
  test(`#68 name disclosure has a 20px target, hover/focus feedback and toggles (${theme}, ${host ? "small host" : "fallback"})`, async ({ page }) => {
    await openView(page, 420, `?grouping=two-chains&theme=${theme}${host}`, false);
    const section = stack(page, "photo-a");
    await section.locator("[data-stack-toggle]").click(); await settle(page);
    const caret = section.getByRole("button", { name: "Collapse stack" });
    const box = (await caret.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeGreaterThanOrEqual(20);
    const caption = (await section.locator(".label").first().boundingBox())!;
    const text = (await section.locator(".text").first().boundingBox())!;
    const lineHeight = await section.locator(".text").first().evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect(box.x).toBeGreaterThanOrEqual(text.x + text.width);
    expect(box.y + box.height / 2).toBeCloseTo(text.y + text.height - lineHeight / 2, 0);
    expect(box.y).toBeLessThan(caption.y + caption.height);
    await expect(page.locator('[role="grid"] [tabindex="0"]:not([data-stack-toggle])')).toHaveCount(1);
    const child = (await section.locator("[data-grid-band] [data-tile-key]").first().boundingBox())!;
    expect(box.y + box.height).toBeLessThan(child.y);
    const style = () => caret.evaluate((element) => {
      const style = getComputedStyle(element), canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      // Compare visible colours, including alpha, against the theme's surface.
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--background-solid");
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
      return { background: style.backgroundColor, rgb: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3),
        color: style.color, cursor: style.cursor, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
    });
    await section.locator(".cover-press").focus();
    await page.mouse.move(1, 1); await settle(page);
    const normal = await style();
    expect(normal.cursor).toBe("pointer");
    await caret.hover(); await settle(page);
    const hovered = await style();
    expect(Math.hypot(...hovered.rgb.map((channel, i) => channel - normal.rgb[i]))).toBeGreaterThan(50);
    expect(hovered.color).not.toBe(normal.color);
    expect(await caret.evaluate((element) => {
      const probe = document.createElement("span"); probe.style.color = "var(--accent)"; element.append(probe);
      const accent = getComputedStyle(probe).color; probe.remove(); return accent;
    })).toBe(hovered.color);
    await page.mouse.move(1, 1);
    await page.keyboard.press("Tab"); await caret.focus(); await settle(page);
    expect(await caret.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
    const focused = await style();
    expect(focused.background).toBe(hovered.background);
    expect(focused.outlineStyle).toBe("solid");
    expect(parseFloat(focused.outlineWidth)).toBeGreaterThanOrEqual(2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await caret.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
    await caret.click(); await settle(page);
    await expect(section.locator("[data-grid-band]")).toHaveCount(0);
    await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
    const after = await state(page);
    await section.getByRole("button", { name: "Expand stack" }).click(); await settle(page);
    await expect(section.locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
    expect((await state(page)).selected).toEqual(after.selected);
    await expect(page.locator('[data-entry-path] [data-stack-toggle]')).toHaveCount(0);
    expect(await uncaught(page)).toEqual([]);
  });
}

/** Sample in screen space at <= 1px intervals, including curves and SVG transforms. */
const connectorCoverClearance = (page: Page) => page.evaluate(() => {
  const covers = [...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((caret) => caret.getBoundingClientRect());
  const crossings: string[] = [], highRuns: string[] = [];
  let horizontalRuns = 0;
  for (const route of document.querySelectorAll<SVGPathElement>("path[data-route]")) {
    const matrix = route.getScreenCTM()!, length = route.getTotalLength(), steps = Math.ceil(length);
    let previous: DOMPoint | undefined;
    for (let i = 0; i <= steps; i++) {
      const point = route.getPointAtLength(length * i / steps), screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      if (covers.some((box) => screen.x > box.left + 1 && screen.x < box.right - 1 && screen.y > box.top + 1 && screen.y < box.bottom - 1)) crossings.push(route.dataset.route!);
      if (previous && Math.abs(screen.x - previous.x) > .1 && Math.abs(screen.y - previous.y) < Math.abs(screen.x - previous.x) * .05) {
        horizontalRuns++;
        const own = route.closest("section")!.querySelector<HTMLElement>("[data-grid-cell]")!.getBoundingClientRect();
        if (Math.min(screen.y, previous.y) < own.bottom + .5) highRuns.push(route.dataset.route!);
      }
      previous = screen;
    }
  }
  return { crossings: [...new Set(crossings)], highRuns: [...new Set(highRuns)], horizontalRuns };
});

for (const preset of [null, "small", "medium", "large", "xlarge"]) test(`#58 offset forest stems bend below the cover row in the village shared band (${preset ?? "fallback"})`, async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openView(page, 840, `?draftStack=1${preset ? `&fileTile=1&tileSize=${preset}` : ""}`, false);
  for (const name of ["village", "forest"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await expect(page.locator("[data-grid-row-band]")).toHaveCount(1);
  const geometry = await connectorCoverClearance(page);
  expect(geometry.crossings).toEqual([]);
  expect(geometry.highRuns).toEqual([]);
  expect(geometry.horizontalRuns).toBeGreaterThan(0);
});

test("#58 two same-row stacks share one band and connectors stay in their own group", async ({ page }) => {
  await openView(page, 620, "?grouping=two-chains", false);
  const before = await gridBoxes(page);
  for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  sameColumns(before, await gridBoxes(page));
  await expect(page.locator("[data-grid-row-band]")).toHaveCount(1);
  const groups = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-grid-band]")].map((element) => {
    const graph = element.querySelector<HTMLElement>(".graph")!, origin = graph.getBoundingClientRect();
    const left = Number(element.dataset.groupLeft), right = left + Number(element.dataset.groupWidth);
    const children = [...graph.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => tile.getBoundingClientRect());
    const parent = element.closest("section")!.querySelector<HTMLElement>("[data-grid-cell] [data-tile-key]")!;
    const parentBox = parent.getBoundingClientRect();
    const source = graph.querySelector<SVGPathElement>(`path[data-from="node:${parent.dataset.tileKey}"]`)!;
    const point = source.getPointAtLength(0), matrix = source.getScreenCTM()!;
    const port = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { left, right, sourceX: port.x, parentX: parentBox.x + parentBox.width / 2, row: element.dataset.gridBandRow, childTop: Math.min(...children.map((child) => child.y)),
      childCenter: children.reduce((sum, child) => sum + child.x + child.width / 2, 0) / children.length,
      parentCenter: element.closest("section")!.querySelector("[data-grid-cell]")!.getBoundingClientRect().x + element.closest("section")!.querySelector("[data-grid-cell]")!.getBoundingClientRect().width / 2,
      routes: [...graph.querySelectorAll<SVGPathElement>("path[data-route]")].map((route) => { const box = route.getBBox(); return { left: box.x, right: box.x + box.width }; }),
      childLeft: Math.min(...children.map((child) => child.x - origin.x)), childRight: Math.max(...children.map((child) => child.right - origin.x)) };
  }));
  expect(groups).toHaveLength(2);
  expect(groups[0].row).toBe(groups[1].row);
  expect(groups[0].childTop).toBeCloseTo(groups[1].childTop, 1);
  for (const group of groups) {
    // Tight cover columns may displace groups; their contents stay bounded
    // and each cover's connector still begins at its actual port.
    expect(group.childLeft).toBeGreaterThanOrEqual(group.left - .5);
    expect(group.childRight).toBeLessThanOrEqual(group.right + .5);
    expect(group.sourceX).toBeCloseTo(group.parentX, 1);
    expect(group.routes.length).toBeGreaterThan(0);
    for (const route of group.routes) { expect(route.left).toBeGreaterThanOrEqual(group.left - .5); expect(route.right).toBeLessThanOrEqual(group.right + .5); }
  }
  expect(groups[0].childRight).toBeLessThan(groups[1].childLeft);
});

for (const width of [620, 350]) {
  test(`#58 broad groups ${width === 620 ? "shift within a shared line" : "wrap inside one band"} without crossed tiles`, async ({ page }) => {
    await openView(page, width, "?grouping=two-chains", false);
    await page.evaluate(() => {
      const backend = (window as any).trace.backend;
      for (const parent of ["photo-a", "photo-b"]) { backend.startGeneration(parent, `${parent}-second`); backend.completeGeneration(`${parent}-second`); }
    });
    await settle(page);
    for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
    await expect(page.locator("[data-grid-row-band]")).toHaveCount(1);
    const result = await page.evaluate(() => {
      const groups = [...document.querySelectorAll<HTMLElement>("[data-grid-band]")].map((element) => {
        const graph = element.querySelector<HTMLElement>(".graph")!, origin = graph.getBoundingClientRect();
        return { element, graph, origin, children: [...graph.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => tile.getBoundingClientRect()) };
      });
      const crossings: string[] = [], outside: string[] = [];
      for (const group of groups) for (const route of group.graph.querySelectorAll<SVGPathElement>("path[data-route]")) {
        const matrix = route.getScreenCTM()!, left = Number(group.element.dataset.groupLeft), right = left + Number(group.element.dataset.groupWidth);
        const bounds = route.getBBox();
        if (bounds.x < left - .5 || bounds.x + bounds.width > right + .5) outside.push(route.dataset.route!);
        for (let i = 0; i <= 300; i++) {
          const point = route.getPointAtLength(route.getTotalLength() * i / 300), screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
          for (const other of groups) if (other !== group) for (const tile of other.children) {
            if (screen.x > tile.left + 1 && screen.x < tile.right - 1 && screen.y > tile.top + 1 && screen.y < tile.bottom - 1) crossings.push(route.dataset.route!);
          }
        }
      }
      return { crossings, outside, tops: groups.map((group) => Math.min(...group.children.map((tile) => tile.y))),
        counts: groups.map((group) => group.children.length), childIntervals: groups.map((group) => [Number(group.element.dataset.childGroupLeft), Number(group.element.dataset.childGroupWidth)]) };
    });
    expect(result.counts).toEqual([2, 2]);
    expect(result.crossings).toEqual([]);
    expect(result.outside).toEqual([]);
    const clearance = await connectorCoverClearance(page);
    expect(clearance.crossings).toEqual([]);
    expect(clearance.highRuns).toEqual([]);
    if (width === 620) {
      expect(result.tops[0]).toBeCloseTo(result.tops[1], 1);
      expect(result.childIntervals[0][0] + result.childIntervals[0][1]).toBeLessThan(result.childIntervals[1][0]);
    } else expect(result.tops[1]).toBeGreaterThan(result.tops[0] + 80);
    await page.screenshot({ path: `/tmp/sg56-packed-${width}.png` });
  });
}

for (const preset of [null, "small", "medium", "large", "xlarge"]) {
  test(`#57 stack cover matches ordinary thumbnail and name at ${preset ?? "fallback"} size`, async ({ page }) => {
    await openView(page, 420, `${preset ? `?fileTile=1&tileSize=${preset}` : ""}`, false);
    const section = stack(page, "village");
    const count = (await section.getAttribute("data-stack-count"))!.split(" ")[0];
    const plain = page.locator('[data-entry-path="/pictures/plain.png"]');
    const styles = async () => {
      const coverImage = await section.locator(".image").first().boundingBox();
      const plainImage = await plain.locator(".icon").boundingBox();
      expect(coverImage!.width).toBeCloseTo(plainImage!.width, 1);
      expect(coverImage!.height).toBeCloseTo(plainImage!.height, 1);
      expect(await section.locator(".text").first().evaluate((element) => getComputedStyle(element).fontSize))
        .toBe(await plain.locator(".name").evaluate((element) => getComputedStyle(element).fontSize));
      const name = await section.locator(".label").first().boundingBox();
      expect(name!.y).toBeGreaterThanOrEqual(coverImage!.y + coverImage!.height);
      await expect(section.locator(".count-badge")).toHaveText(count);
      await expect(section.locator("[data-node-key]").first()).toHaveAccessibleName(new RegExp(`${count} images`));
      expect(await section.innerText()).not.toMatch(/images|Unsaved/);
      await expect(section.locator(".image").first().locator(".stack-sheet")).toHaveCount(2);
    };
    await styles();
    await section.locator("[data-stack-toggle]").click(); await settle(page);
    await styles();
  });
}

test("#57 unsaved edits use a dot on the cover thumbnail", async ({ page }) => {
  await openView(page, 420, "?draftStack=1", false);
  const section = stack(page, "draft");
  await expect(section.locator(".cover-unsaved-dot")).toBeVisible();
  await expect(section.locator("[data-node-key]")).toHaveAccessibleName(/unsaved/);
  expect(await section.innerText()).not.toContain("Unsaved");
});

test("#56 opening settles once and unchanged journal refresh preserves children and following rows", async ({ page }) => {
  await openView(page, 220, "?grouping=two-chains", false);
  await stack(page, "photo-a").locator("[data-stack-toggle]").click(); await settle(page);
  const child = await key(page, "photo-a-edit");
  const samples = await page.evaluate(async (child) => {
    const section = document.querySelector<HTMLElement>('section[aria-label="photo-a"]')!;
    const following = document.querySelector<HTMLElement>('section[aria-label="photo-b"]')!;
    const removed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof Element && (node.matches(`[data-tile-key="${child}"]`) || node.querySelector(`[data-tile-key="${child}"]`))) removed.push(node.nodeName);
      }
    });
    observer.observe(section, { childList: true, subtree: true });
    const start = performance.now(), samples = [];
    let refreshed = false;
    while (performance.now() - start < 650) {
      await new Promise(requestAnimationFrame);
      const time = performance.now() - start;
      if (time >= 100 && !refreshed) { (window as any).trace.backend.refresh(); refreshed = true; }
      const tile = section.querySelector<HTMLElement>(`[data-tile-key="${child}"]`);
      const rect = tile?.getBoundingClientRect();
      samples.push({ time, child: rect ? { y: rect.y, height: rect.height, opacity: Number(getComputedStyle(tile!).opacity) } : null, following: following.getBoundingClientRect().y });
    }
    observer.disconnect();
    return { removed, samples };
  }, child);
  expect(samples.removed).toEqual([]);
  const settled = samples.samples;
  expect(settled.length).toBeGreaterThan(5);
  const baseline = settled.at(-1)!;
  for (const sample of settled) {
    expect(sample.child, `frame ${sample.time}`).not.toBeNull();
    expect(sample.child!.height).toBeCloseTo(baseline.child!.height, 0);
    expect(sample.child!.y).toBeCloseTo(baseline.child!.y, 0);
    expect(sample.child!.opacity).toBeGreaterThanOrEqual(.99);
    expect(sample.following).toBeCloseTo(baseline.following, 0);
  }
});

test("#56 unchanged refresh does not restart an expansion in progress", async ({ page }) => {
  await openView(page, 220, "?grouping=two-chains", false);
  await holdScriptedAnimations(page);
  try {
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await awaitAnimationsCreated(page);
    const child = await key(page, "photo-a-edit");
    const result = await page.evaluate(async (child) => {
      const w = window as any;
      const original = [...w.__heldAnimations] as Animation[];
      for (const animation of original) if (animation.playState === "running") animation.currentTime = 80;
      await new Promise(requestAnimationFrame);
      w.trace.backend.refresh();
      for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame);
      const box = () => {
        const element = document.querySelector<HTMLElement>(`[data-tile-key="${child}"]`)!;
        return { y: element.getBoundingClientRect().y, opacity: Number(getComputedStyle(element).opacity), following: document.querySelector('section[aria-label="photo-b"]')!.getBoundingClientRect().y };
      };
      for (const animation of original) if (animation.playState === "running") animation.currentTime = 160;
      await new Promise(requestAnimationFrame);
      const atOriginalEnd = box();
      for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 160;
      await new Promise(requestAnimationFrame);
      return { atOriginalEnd, settled: box() };
    }, child);
    expect(result.atOriginalEnd.opacity).toBe(1);
    expect(result.atOriginalEnd.y).toBeCloseTo(result.settled.y, 1);
    expect(result.atOriginalEnd.following).toBeCloseTo(result.settled.following, 1);
  } finally { await releaseScriptedAnimations(page); }
});

for (const host of ["", "&fileTile=1&tileSize=medium"]) {
  test(`opening and closing stacks preserves every column and the cover's position (${host ? "host tile" : "fallback"})`, async ({ page }) => {
    await openView(page, 420, `?grouping=style-many${host}`, false);
    const before = await gridBoxes(page), cover = stack(page, "photo-a").locator("[data-tile-key]");
    const coverX = (await cover.boundingBox())!.x;
    await cover.click(); await settle(page);
    sameColumns(before, await gridBoxes(page));
    expect((await stack(page, "photo-a").locator(`[data-tile-key="${await key(page, "photo-a")}"]`).boundingBox())!.x).toBeCloseTo(coverX, 1);
    await expect(stack(page, "photo-a").locator(`[data-node-key="${await key(page, "photo-a-edit")}"]`)).toBeVisible();
    await stack(page, "photo-a").getByRole("button", { name: "Collapse stack" }).click(); await settle(page);
    sameColumns(before, await gridBoxes(page));
    expect((await stack(page, "photo-a").locator("[data-tile-key]").boundingBox())!.x).toBeCloseTo(coverX, 1);
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    expect((await state(page)).selected).toEqual(["/pictures/photo-a.png"]);
    await expect(stack(page, "photo-a").locator(".card").first()).toHaveClass(/selected/);
  });
}

test("selection inside a band snaps only rows below vertically, including another open band", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1400 });
  await openView(page, 180, "?deeper=1", false);
  await expect(page.getByRole("grid", { name: "Folder", exact: true })).toHaveAttribute("aria-colcount", "1");
  for (const name of ["village", "forest"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await stack(page, "village").locator(`[data-node-key="${await key(page, "warm")}"]`).click(); await settle(page);
  const before = await gridBoxes(page);
  const forestChild = page.locator(`[data-tile-key="${await key(page, "forest-mist")}"]`);
  const childBefore = await forestChild.evaluate((element) => element.getBoundingClientRect().y + document.querySelector<HTMLElement>('[data-testid="trace-view"]')!.scrollTop);
  await holdScriptedAnimations(page);
  let samples: Awaited<ReturnType<typeof gridBoxes>>[];
  try {
    await stack(page, "village").locator(`[data-node-key="${await key(page, "rain")}"]`).click();
    await page.waitForFunction(() => (window as any).trace.layoutsPending() === 0);
    samples = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await frame();
      const animations = ((window as any).__heldAnimations as Animation[]).filter((animation) => animation.playState === "running");
      const view = document.querySelector<HTMLElement>('[data-testid="trace-view"]')!;
      const samples = [];
      for (const time of [0, 40, 80, 120, 160]) {
        for (const animation of animations) animation.currentTime = time;
        await frame();
        samples.push(Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((element) => {
          const box = element.getBoundingClientRect();
          return [element.dataset.gridCell!, { x: box.x, y: box.y + view.scrollTop, width: box.width }];
        })));
      }
      return samples;
    });
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  const after = await gridBoxes(page); sameColumns(before, after);
  // The village band grows under the village cover, so the cover stays put while every row below it,
  // including the other open stack's cover, is placed vertically by the band's growth.
  const village = await key(page, "village"), forest = await key(page, "forest"), below = await key(page, "fan");
  for (const sample of samples) {
    sameColumns(before, sample);
    expect(sample[village].y).toBeCloseTo(before[village].y, 1);
  }
  const delta = after[below].y - before[below].y;
  expect(Math.abs(delta)).toBeGreaterThan(40);
  expect(after[forest].y - before[forest].y).toBeCloseTo(delta, 1);
  expect(samples[0][below].y).toBeCloseTo(after[below].y, 1);
  expect(samples.at(-1)![below].y).toBeCloseTo(after[below].y, 1);
  let previous = before[below].y;
  for (const sample of samples) {
    expect((sample[below].y - previous) * Math.sign(delta)).toBeGreaterThanOrEqual(-.5);
    expect(sample[forest].y - before[forest].y).toBeCloseTo(sample[below].y - before[below].y, 1);
    previous = sample[below].y;
  }
  expect(after["/pictures/notes.txt"].y - before["/pictures/notes.txt"].y).toBeCloseTo(delta, 1);
  const childAfter = await forestChild.evaluate((element) => element.getBoundingClientRect().y + document.querySelector<HTMLElement>('[data-testid="trace-view"]')!.scrollTop);
  expect(childAfter - childBefore).toBeCloseTo(delta, 1);
});

test("a shared style is one badge on each of two separate stacks; click selects its path and hover highlights both consumers", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  const style = await key(page, "style");
  await expect(page.locator("section[data-component]")).toHaveCount(2);
  await expect(page.locator(`[data-tile-key="${style}"]`)).toHaveCount(0);
  const badges = page.locator(`[data-reference-key="${style}"]`); await expect(badges).toHaveCount(2);
  await badges.first().hover(); await settle(page);
  for (const name of ["photo-a-edit", "photo-b-edit"]) await expect(page.locator(`[data-tile-key="${await key(page, name)}"]`)).toHaveAttribute("data-tone", "related");
  await badges.last().click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/pictures/refs/style.png"]);
  expect(await page.evaluate(() => (window as any).trace.state().target.imagePath)).toBe("/pictures/refs/style.png");
  await expect(page.locator(`path[data-from="node:${style}"], path[data-to="node:${style}"]`)).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("a cover made from an external reference hangs in place with its reference badge", async ({ page }) => {
  await openView(page, 420, "?grouping=external-cover", false);
  const before = await gridBoxes(page);
  await stack(page, "cover").locator("[data-stack-toggle]").click(); await settle(page);
  sameColumns(before, await gridBoxes(page));
  const reference = await key(page, "reference"), cover = await key(page, "cover");
  // The reference fed both images, so each carries a badge for it.
  await expect(page.locator(`[data-tile-key="${cover}"] [data-reference-key="${reference}"]`)).toBeVisible();
  await expect(page.locator(`[data-tile-key="${await key(page, "cover-edit")}"] [data-reference-key="${reference}"]`)).toBeVisible();
  await expect(page.locator(`[data-tile-key="${reference}"]`)).toHaveCount(0);
  const root = (await page.locator(`[data-tile-key="${cover}"]`).boundingBox())!;
  const child = (await page.locator(`[data-tile-key="${await key(page, "cover-edit")}"]`).boundingBox())!;
  expect(child.y).toBeGreaterThan(root.y + root.height);
  await page.locator(`[data-tile-key="${cover}"] [data-reference-key="${reference}"]`).click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/elsewhere/reference.png"]);
});

test("reference overflow expands to selectable references with path and scope tooltips", async ({ page }) => {
  await openView(page, 420, "?moreBadges=1");
  const warm = stack(page, "village").locator(`[data-tile-key="${await key(page, "warm")}"]`);
  await expect(warm.locator("[data-reference-key]")).toHaveCount(3);
  await warm.getByRole("button", { name: "Show 1 more references" }).click();
  await expect(warm.locator("[data-reference-key]")).toHaveCount(4);
  const reference = warm.locator(`[data-reference-key="${await key(page, "reference-4")}"]`);
  await reference.hover();
  await expect(page.getByRole("tooltip")).toContainText("/elsewhere/reference-4.png");
  await expect(page.getByRole("tooltip")).toContainText(/Outside this folder/i);
  await reference.click(); await settle(page);
  expect((await state(page)).inputs).toEqual(["/elsewhere/reference-4.png"]);
});

test("clicking the image centre selects the image even when the badges wrap onto two rows", async ({ page }) => {
  await openView(page, 420, "?moreBadges=1");
  const warm = page.locator(`[data-node-key="${await key(page, "warm")}"]`);
  await warm.hover();
  const box = (await warm.boundingBox())!;
  const badges = await stack(page, "village").locator(`[data-tile-key="${await key(page, "warm")}"] [data-reference-key], [data-tile-key="${await key(page, "warm")}"] button.more`).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
  expect(new Set(badges.map(Math.round)).size, "badges wrap onto more than one row").toBeGreaterThan(1);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await settle(page);
  expect((await state(page)).selected).toEqual(["/pictures/warm.png"]);
});

test("a stack refreshed away under a hovered reference leaves no hover highlight behind", async ({ page }) => {
  await openView(page, 900);
  const village = stack(page, "village");
  const press = (selector: string) => village.locator(selector).first().evaluate((element) => (element as HTMLElement).click());
  // Close and reopen with the pointer elsewhere (programmatic presses move nothing): what the reopened band dims.
  const cycle = async () => {
    await press('[aria-label="Collapse stack"]'); await settle(page);
    await press("[data-stack-toggle]"); await settle(page);
    await expect(village.locator("[data-grid-band]")).toHaveCount(1);
    return village.locator("[data-tone]").evaluateAll((tiles) => tiles.map((tile) => `${tile.getAttribute("data-tile-key")}:${tile.getAttribute("data-tone")}`).sort());
  };
  const baseline = await cycle();
  await village.locator(`[data-reference-key="${await key(page, "lantern")}"]`).first().hover();
  expect((await rendered(page, "tone", "unrelated")).length).toBeGreaterThan(0);
  // The band goes away while the pointer rests on the badge: no mouseleave ever reaches it.
  await press('[aria-label="Collapse stack"]'); await settle(page);
  await page.mouse.move(2, 2);
  await press("[data-stack-toggle]"); await settle(page);
  await expect(village.locator("[data-grid-band]")).toHaveCount(1);
  expect(await village.locator("[data-tone]").evaluateAll((tiles) => tiles.map((tile) => `${tile.getAttribute("data-tile-key")}:${tile.getAttribute("data-tone")}`).sort())).toEqual(baseline);
});

test("a context click on a cold unsaved stack never reaches the host folder menu", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-and-placeholder", false);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click(); await settle(page);
  expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
  expect((await state(page)).menus).toEqual([]);
  await stack(page, "out").locator(".cover-press").click({ button: "right" });
  await expect.poll(async () => (await state(page)).target).toMatchObject({ id: "trace:o:11:0" });
  // The host's empty-space menu never saw the event.
  expect((await state(page)).menus).toEqual([]);
  expect(await uncaught(page)).toEqual([]);
});

test("hovering a reference preserves a deeper selected tile and keyboard focus", async ({ page }) => {
  await openView(page, 420);
  for (const name of ["warm", "rain", "quiet"]) {
    await page.locator(`[data-node-key="${await key(page, name)}"]`).click(); await settle(page);
  }
  const selected = page.locator(`[data-node-key="${await key(page, "quiet")}"]`);
  await selected.focus();
  const before = await selected.boundingBox();
  await stack(page, "village").locator(`[data-reference-key="${await key(page, "mist")}"]`).hover(); await settle(page);
  await expect(selected).toBeFocused();
  await expect(selected).toBeVisible();
  await expect(page.locator(`[data-tile-key="${await key(page, "quiet")}"]`)).toHaveAttribute("data-tone", "focus");
  expect(await selected.boundingBox()).toEqual(before);
  expect((await state(page)).selected).toEqual(["/pictures/quiet.png"]);
});

test("closing during emergence reclaims rows without overlapping the remaining band", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1600 });
  await openView(page, 220, "?grouping=two-chains", false);
  await stack(page, "photo-b").locator("[data-stack-toggle]").click(); await settle(page);
  await holdScriptedAnimations(page);
  try {
    await stack(page, "photo-a").locator("[data-stack-toggle]").click();
    await awaitAnimationsCreated(page);
    const child = await key(page, "photo-a-edit");
    const samples = await page.evaluate(async () => {
      const w = window as any;
      for (const animation of w.__heldAnimations as Animation[]) if (animation.playState === "running") animation.currentTime = 40;
      await new Promise(requestAnimationFrame);
      document.querySelector<HTMLElement>('section[aria-label="photo-a"] [aria-label="Collapse stack"]')!.click();
      const samples = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        const backgrounds = [...document.querySelectorAll<HTMLElement>("[data-grid-row-band]")];
        samples.push([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => {
          const row = Number(cell.getAttribute("aria-rowindex")) - 1, rect = cell.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom,
            earlierBottom: Math.max(-Infinity, ...backgrounds.filter((band) => Number(band.dataset.gridRowBand) < row).map((band) => band.getBoundingClientRect().bottom)),
            ownTop: Math.min(Infinity, ...backgrounds.filter((band) => Number(band.dataset.gridRowBand) === row).map((band) => band.getBoundingClientRect().top)) };
        }));
      }
      return samples;
    });
    for (const frame of samples) for (const cell of frame) {
      expect(cell.top).toBeGreaterThanOrEqual(cell.earlierBottom - .5);
      expect(cell.bottom).toBeLessThanOrEqual(cell.ownTop + .5);
    }
    await expect(stack(page, "photo-a").locator(`[data-tile-key="${child}"]`)).toHaveCount(0);
    // Whatever retires is passive: inert and hidden from assistive technology.
    expect(await page.locator('[data-grid-exit], [data-ghost-tile-key], [data-motion-route-layer]').evaluateAll((elements) =>
      elements.every((element) => !!element.closest('[inert]') && !!element.closest('[aria-hidden="true"]')))).toBe(true);
    await expect(stack(page, "photo-b").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("selecting in another band after a reveal snaps each neighborhood without subsequent motion", async ({ page }) => {
  // Both focus changes reveal new neighborhoods and snap their footprints.
  await openView(page, 420, "?deeper=1", false);
  for (const name of ["village", "forest"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await holdScriptedAnimations(page);
  try {
    const warm = await key(page, "warm"), mist = await key(page, "forest-mist");
    const positions = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((tile) => {
      const box = tile.getBoundingClientRect(); return [tile.dataset.tileKey!, [box.x, box.y]];
    })));
    // Seeks the animations created since `from` (earlier ones were cancelled by the interruption).
    const seek = (time: number, from: number) => page.evaluate(async ([time, from]) => {
      const held = (window as any).__heldAnimations as Animation[];
      for (const animation of held.slice(from)) if (animation.playState === "running") animation.currentTime = time;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, [time, from]);
    const start = await positions();
    await page.locator(`[data-node-key="${warm}"]`).click();
    await awaitAnimationsCreated(page);
    await seek(40, 0);
    const displayed = await positions();
    expect(displayed[mist][1], "the first selection is under way").toBeGreaterThan(start[mist][1] + 20);
    const created = await page.evaluate(() => (window as any).__heldAnimations.length as number);
    await page.locator(`[data-node-key="${mist}"]`).click();
    await awaitAnimationsCreated(page);
    await seek(0, created);
    const resumed = await positions();
    expect(await page.evaluate(() => ((window as any).__heldAnimations as Animation[]).filter(a => a.playState === 'running').length)).toBe(0);
    // The newly committed positions remain fixed, even when test clocks seek.
    let previous = resumed[mist][1];
    for (const time of [20, 40, 80, 120, 160]) {
      await seek(time, created);
      const now = (await positions())[mist][1];
      expect(now, `forest-mist at ${time}ms`).toBeCloseTo(previous, 1);
      previous = now;
    }
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  expect(await uncaught(page)).toEqual([]);
});

test("host selection opens every selected stack and focused bands survive refreshed component ids", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  await page.evaluate(() => (window as any).trace.setSelection(["/pictures/photo-a-edit.png", "/pictures/photo-b-edit.png"])); await settle(page);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined")); await settle(page);
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await expect(page.locator("[data-grid-band]")).toHaveCount(1);
  await page.evaluate(() => (window as any).trace.backend.failGeneration("joined")); await settle(page);
  await expect(page.locator("[data-grid-band]")).toHaveCount(2);
});

test("grid Shift selection follows listing ranges and unchanged selection contents do not notify", async ({ page }) => {
  await openView(page, 900, "", false);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click();
  const before = await page.evaluate(() => (window as any).trace.state().selectionNotifications);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click();
  expect(await page.evaluate(() => (window as any).trace.state().selectionNotifications)).toBe(before);
  await page.locator('[data-entry-path="/pictures/refs"]').click({ modifiers: ["Shift"] });
  expect((await state(page)).selected).toEqual(["/pictures/notes.txt", "/pictures/plain.png", "/pictures/refs"]);
});

test("End reaches the final virtualized row and arrows can cross the mounted window", async ({ page }) => {
  await openView(page, 180, "?many=80", false);
  await expect(page.getByRole("grid", { name: "Folder", exact: true })).toHaveAttribute("aria-colcount", "1");
  const cover = page.locator(".cover-press").first(); await cover.focus();
  await page.keyboard.press("End"); await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/refs"]')).toBeFocused();
  await expect(page.locator('[data-entry-path="/pictures/refs"]')).toBeInViewport();
  expect((await state(page)).selected).toEqual(["/pictures/refs"]);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid=trace-view]")!.scrollTop)).toBeGreaterThan(1200);
  await page.keyboard.press("ArrowUp"); await settle(page);
  // One column: the listing order is notes.txt, plain.png, refs.
  await expect(page.locator('[data-entry-path="/pictures/plain.png"]')).toBeFocused();
  expect((await state(page)).selected).toEqual(["/pictures/plain.png"]);
  expect(await uncaught(page)).toEqual([]);
});

test("keyboard focus remains on the cover across opening and chevron closing", async ({ page }) => {
  await openView(page, 420, "?grouping=two-chains", false);
  const keyA = await key(page, "photo-a"), section = stack(page, "photo-a");
  await section.locator(".cover-press").focus();
  await page.keyboard.press("Space"); await settle(page);
  await expect(section.locator(`[data-node-key="${keyA}"]`)).toBeFocused();
  await section.getByRole("button", { name: "Collapse stack" }).focus();
  await page.keyboard.press("Enter"); await settle(page);
  await expect(section.locator("[data-stack-toggle]")).toBeFocused();
  await page.keyboard.press("ArrowRight"); await settle(page);
  expect((await state(page)).selected).toEqual(["/pictures/photo-b.png"]);
});

test("ordinary host tile editing keeps navigation keys in the editor", async ({ page }) => {
  await openView(page, 420, "?fileTile=1", false);
  const entry = page.locator('[data-entry-path="/pictures/notes.txt"]');
  await entry.click();
  // The real host forwards bubbled keys from its inline rename textarea.
  // Supply an editable descendant without duplicating host rename logic.
  await entry.evaluate((element) => {
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Rename filename"); input.value = "notes.txt";
    element.append(input); input.focus();
  });
  const editor = page.getByRole("textbox", { name: "Rename filename" });
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Enter"]) {
    await page.keyboard.press(key);
    await expect(editor).toBeFocused();
    expect((await state(page)).selected).toEqual(["/pictures/notes.txt"]);
    expect((await state(page)).opened).toEqual([]);
  }
});

test("double-clicking a closed stack opens the cover file", async ({ page }) => {
  await openView(page, 420, "?grouping=two-chains", false);
  await stack(page, "photo-a").locator(".cover-press").dblclick(); await settle(page);
  expect((await state(page)).opened).toEqual(["/pictures/photo-a.png"]);
  expect((await state(page)).selected).toEqual(["/pictures/photo-a.png"]);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
});

test("reduced motion opens and closes bands without animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openView(page, 420, "?grouping=two-chains", false);
  await stack(page, "photo-a").locator("[data-stack-toggle]").click(); await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await stack(page, "photo-a").getByRole("button", { name: "Collapse stack" }).click(); await settle(page);
  await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("clicking a closed in-place-edit stack selects its cover revision, as clicking the open cover does", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
});

test("double-clicking a closed in-place-edit stack opens the file at its path, as double-clicking its open cover does", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  await page.locator(".cover-press").dblclick(); await settle(page);
  expect((await state(page)).opened).toEqual(["/pictures/photo.png"]);
  await expect(page.locator("[data-grid-band]")).toHaveCount(1);
  // The open cover behaves the same.
  await page.locator('[data-tile-key="a:1"]').dblclick(); await settle(page);
  expect((await state(page)).opened).toEqual(["/pictures/photo.png", "/pictures/photo.png"]);
  expect(await uncaught(page)).toEqual([]);
});

test("a band wider than the pane scrolls the view sideways, keeping routes attached to their cover", async ({ page }) => {
  await openView(page, 220, "?wideRoots=24", false);
  await stack(page, "wr-0").locator("[data-stack-toggle]").click(); await settle(page);
  const cover = await key(page, "wr-0");
  const view = page.getByTestId("trace-view");
  expect(await view.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // Where the cover hangs its outgoing route, against the route's first point as drawn.
  const attachment = () => page.evaluate((cover) => {
    const tile = document.querySelector(`[data-tile-key="${cover}"]`)!.getBoundingClientRect();
    const routes = [...document.querySelectorAll<SVGPathElement>(`path[data-route][data-from="node:${cover}"]`)];
    return { center: tile.left + tile.width / 2, starts: routes.map((route) => {
      const start = route.getPointAtLength(0), at = route.getScreenCTM()!;
      return start.x * at.a + start.y * at.c + at.e;
    }) };
  }, cover);
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await attachment();
  expect(before.starts.length).toBeGreaterThan(0);
  for (const wheel of [100, 5000, -5000]) {
    const left = await view.evaluate((element) => element.scrollLeft);
    await page.mouse.wheel(wheel, 0);
    await expect.poll(() => view.evaluate((element) => element.scrollLeft)).not.toBe(left);
    await settle(page);
    const now = await attachment();
    for (const start of now.starts) expect(Math.abs(start - now.center), `route start vs cover centre after wheel ${wheel}`).toBeLessThan(3);
  }
  // Every tile is reachable: at the far end of the scroll the rightmost tile lies inside the view.
  await page.mouse.wheel(5000, 0);
  await expect.poll(() => view.evaluate((element) => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThan(20);
  const rightmost = await view.evaluate((element) => Math.max(...[...element.querySelectorAll("[data-tile-key]")].map((tile) => tile.getBoundingClientRect().right)) <= element.getBoundingClientRect().right + 1);
  expect(rightmost).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});

test("the focused tile stays mounted when windowing scrolls it out of range", async ({ page }) => {
  await openView(page, 420, "?fanChildren=140", false);
  await stack(page, "fan").locator("[data-stack-toggle]").click(); await settle(page);
  const target = page.locator(`[data-node-key="${await key(page, "fan-1")}"]`);
  const box = (await target.boundingBox())!;
  // Press, drag outside the tile and release: the tile takes focus but nothing is selected.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height + 400); await page.mouse.up();
  await page.getByTestId("trace-view").evaluate((view) => { view.scrollTop = view.scrollHeight; });
  await settle(page);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null)).not.toBeNull();
  await expect(tabStops(page)).toHaveCount(1);
  expect(await uncaught(page)).toEqual([]);
});

test("arrowing into a closed in-place-edit stack selects its cover revision, as clicking it does", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  const ordinary = page.locator("[data-grid-cell]:not([data-stack-key]) [data-entry-path]").first();
  await ordinary.focus();
  const heading = page.locator("[data-stack-toggle]");
  const stackX = (await heading.boundingBox())!.x, ordinaryX = (await ordinary.boundingBox())!.x;
  await page.keyboard.press(stackX < ordinaryX ? "ArrowLeft" : "ArrowRight"); await settle(page);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node-key"))).toBe("a:1");
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
});

test("an in-place edit's stack hangs from its root revision, inside the view and joined to the edit by a route", async ({ page }) => {
  await openView(page, 420, "?grouping=in-place-edit", false);
  await page.locator("[data-stack-toggle]").click(); await settle(page);
  const root = page.locator('[data-tile-key="a:1"]'), edit = page.locator('[data-tile-key="o:5:0"]');
  await expect(root).toBeVisible(); await expect(edit).toBeVisible();
  const [r, e] = [(await root.boundingBox())!, (await edit.boundingBox())!];
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(e.y).toBeGreaterThan(r.y + r.height);
  await expect(page.locator('path[data-from="node:a:1"][data-to="node:o:5:0"]')).toHaveCount(1);
  // The root is the earlier revision: it previews as such rather than selecting the file the edit now holds.
  await root.click(); await settle(page);
  expect((await state(page)).target).toMatchObject({ id: "trace:a:1", badge: "Earlier revision" });
  expect(await uncaught(page)).toEqual([]);
});

test("an unsaved cover that is not the component's namesake selects itself as the AI input", async ({ page }) => {
  // The unsaved draft is the cover; the component is named after the later source it merged with.
  await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
  await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
  await expect(page.locator('[data-tile-key="o:10:0"]')).toBeVisible();
  expect((await state(page)).inputs).toEqual(["/managed/draft.png"]);
  expect((await state(page)).selected).not.toContain("/pictures/source.png");
  expect(await uncaught(page)).toEqual([]);
});

test("saving an unsaved cover through its Save button moves no cell, even while the index lags the listing", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
  await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
  const cells = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => {
    const rect = cell.getBoundingClientRect();
    return [cell.dataset.gridCell!, [Math.round(rect.x), Math.round(rect.y)]];
  })));
  const before = await cells();
  const backend = (fn: string) => page.evaluate((fn) => (window as any).trace.backend[fn](), fn);
  // The host lists the saved file while Trace's index read is still outstanding.
  await backend("holdFolderReads");
  const cover = page.locator('[data-tile-key="o:10:0"]');
  await cover.hover();
  await cover.getByRole("button", { name: "Save image permanently" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).trace.listing().some((entry: { path: string }) => entry.path === "/pictures/draft.png"))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("save_generated_image").length)).toBeGreaterThan(0);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  expect(await cells()).toEqual(before);
  await backend("releaseFolderReads"); await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  expect(await cells()).toEqual(before);
  expect(await uncaught(page)).toEqual([]);
});

test("#50 a save from another pane moves no column while the listing precedes the index", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
  const before = await gridBoxes(page);
  await page.evaluate(() => {
    const backend = (window as any).trace.backend;
    backend.holdFolderReads();
    // Updates the host listing and emits invalidation without invoking this view's saved callback.
    backend.saveGeneration("draft");
  });
  await expect.poll(() => page.evaluate(() => (window as any).trace.listing().some((entry: { path: string }) => entry.path === "/pictures/draft.png"))).toBe(true);
  await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  sameColumns(before, await gridBoxes(page));
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  await settle(page);
  await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
  sameColumns(before, await gridBoxes(page));
  expect(await uncaught(page)).toEqual([]);
});

test("#51 a cold activation follows its revision after merging into an older lineage", async ({ page }) => {
  await openView(page, 420, "?draftStack=1", false);
  await page.locator('[data-entry-path="/pictures/notes.txt"]').click();
  const clicked = await key(page, "draft");
  const oldId = await stack(page, "draft").getAttribute("data-component");
  await page.evaluate(() => (window as any).trace.backend.holdNodeReads());
  await stack(page, "draft").locator("[data-stack-toggle]").click();
  await expect.poll(() => page.evaluate((id) => (window as any).trace.backend.calls("trace_component_nodes").some((call: { params: { componentId: string } }) => call.params.componentId === id), oldId)).toBe(true);
  // Only nodes are held: the new index overtakes the clicked stack's node load. The requested open
  // is a dependency of the refresh, so the committed scene stays until its data is complete.
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["village", "draft"], "joined"));
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.heldNodeReads().length)).toBeGreaterThan(1);
  await expect(page.locator(`section[data-component="${oldId}"]`)).toHaveCount(1);
  await page.evaluate(() => (window as any).trace.backend.releaseNodeReads());
  await expect.poll(async () => (await state(page)).target).toMatchObject({ id: `trace:${clicked}` });
  await settle(page);
  await expect(page.locator(`section[data-component="${oldId}"]`)).toHaveCount(0);
  await expect(stack(page, "village")).toBeVisible();
  // The clicked unsaved image is now neither a cover nor a folder member.
  expect(await stack(page, "village").locator(".cover-press").getAttribute("data-node-key")).toBe(await key(page, "village"));
  const after = await state(page);
  expect(after.selected).toEqual([]);
  expect(after.inputs).toEqual(["/managed/draft.png"]);
  expect(await uncaught(page)).toEqual([]);
});

test("a cover whose band is virtualised renders from fresh node data after the draft is saved elsewhere", async ({ page }) => {
  // Wide enough for one row: the fan's tall band, opened second, pushes the draft's band out of the mounted window while its cover stays.
  await openView(page, 1000, "?draftStack=1&fanChildren=200", false);
  await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
  const draft = await key(page, "draft"), cover = page.locator(`[data-tile-key="${draft}"]`);
  const card = cover.locator("[data-node-key]");
  await expect(card).toHaveAttribute("aria-label", /unsaved/);
  await stack(page, "fan").locator("[data-stack-toggle]").click(); await settle(page);
  await expect(stack(page, "draft").locator("[data-grid-band] .tile")).toHaveCount(0);
  await expect(cover).toBeVisible();
  await page.evaluate(() => (window as any).trace.backend.saveGeneration("draft")); await settle(page);
  await expect(card).not.toHaveAttribute("aria-label", /unsaved/);
  await cover.hover();
  await expect(cover.getByRole("button", { name: "Save image permanently" })).toHaveCount(0);
  await expect(cover.getByRole("button", { name: "Delete image" })).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

test("a refresh that merges the stack during activation still selects the clicked cover", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-and-placeholder", false);
  const backend = (fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as any).trace.backend[fn as string](...(args as unknown[])), [fn, args] as const);
  await backend("holdFolderReads");
  // An unsaved cover is not a listed file, so pressing it loads its component before selecting.
  await stack(page, "out").locator("[data-stack-toggle]").click();
  await backend("joinGeneration", ["o:10:0", "out"], "joined");
  await backend("releaseFolderReads");
  await settle(page);
  await expect.poll(async () => (await state(page)).target).toMatchObject({ id: "trace:o:11:0" });
  expect(await uncaught(page)).toEqual([]);
});

for (const outcome of ["delayed", "failed"] as const) {
  test(`a stack whose data is ${outcome} can be closed again`, async ({ page }) => {
    await openView(page, 420, "?grouping=two-chains", false);
    const backend = (fn: string, ...args: unknown[]) => page.evaluate(([fn, args]) => (window as any).trace.backend[fn as string](...(args as unknown[])), [fn, args] as const);
    if (outcome === "delayed") await backend("holdFolderReads"); else await backend("failNodeReads", 1);
    const heading = stack(page, "photo-a").locator("[data-stack-toggle]");
    await heading.click();
    // Nothing is committed while the open is pending or after it failed: the disclosure reports the
    // committed scene and cancels the pending open, or dismisses the failure.
    if (outcome === "delayed") await expect(heading).toHaveAttribute("aria-label", "Cancel opening stack");
    else await expect(stack(page, "photo-a").locator("[data-cover-error]")).toBeVisible();
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await heading.click();
    await expect(heading).toHaveAttribute("aria-label", "Expand stack");
    await expect(heading).toHaveAttribute("aria-expanded", "false");
    await expect(stack(page, "photo-a").locator("[data-cover-progress], [data-cover-error]")).toHaveCount(0);
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    if (outcome === "delayed") await backend("releaseFolderReads");
    await settle(page);
    // Still closed once the data arrives, and openable again.
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(0);
    await heading.click(); await settle(page);
    await expect(stack(page, "photo-a").locator("[data-grid-band]")).toHaveCount(1);
  });
}

test("a delayed activation does not undo an explicit close", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-and-placeholder", false);
  const backend = (fn: string) => page.evaluate((fn) => (window as any).trace.backend[fn](), fn);
  const before = await state(page);
  await backend("holdFolderReads");
  // An unsaved cover is not a listed file: pressing it loads its component before selecting it.
  const heading = stack(page, "out").locator("[data-stack-toggle]");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-label", "Cancel opening stack");
  await heading.click();
  await expect(heading).toHaveAttribute("aria-label", "Expand stack");
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await backend("releaseFolderReads"); await settle(page);
  await expect(stack(page, "out").locator("[data-grid-band]")).toHaveCount(0);
  const after = await state(page);
  expect([after.selected, after.inputs, after.target]).toEqual([before.selected, before.inputs, before.target]);
  expect(await uncaught(page)).toEqual([]);
});

test("a context click on a cold unsaved stack resolves its image", async ({ page }) => {
  await openView(page, 420, "?grouping=unsaved-and-placeholder", false);
  expect((await state(page)).target).toBeNull();
  await stack(page, "out").locator(".cover-press").click({ button: "right" });
  await expect.poll(async () => (await state(page)).target).toMatchObject({ id: "trace:o:11:0" });
  expect(await uncaught(page)).toEqual([]);
});

test("a closed stack shows that an edit is generating, and clears when it finishes", async ({ page }) => {
  await openView(page, 900, "", false);
  const village = stack(page, "village");
  await expect(village.locator("[data-stack-toggle]")).toBeVisible();
  const generating = village.locator(".image").getByRole("status", { name: "Generating" });
  await expect(generating).toHaveCount(0);
  const thumbnail = village.locator(".image img");
  await expect(thumbnail).toBeVisible();
  await page.evaluate(() => (window as any).trace.backend.startGeneration("village", "pending-edit"));
  await expect(generating).toHaveCount(1);
  await expect(thumbnail).toBeVisible();
  await page.evaluate(() => (window as any).trace.backend.completeGeneration("pending-edit"));
  await expect(generating).toHaveCount(0);
  expect(await uncaught(page)).toEqual([]);
});

/** Columns of every grid cell, and whether the saved file shows as an ordinary tile. */
const gridCells = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-grid-cell]")].map((cell) => {
  const rect = cell.getBoundingClientRect();
  return [cell.dataset.gridCell!, [Math.round(rect.x), Math.round(rect.y)]];
})));
const backendCall = (page: Page, fn: string) => page.evaluate((fn) => (window as any).trace.backend[fn](), fn);

test.describe("a save that outlives the control that started it still claims its file", () => {
  async function finishWhileIndexLags(page: Page, before: Record<string, number[]>) {
    await backendCall(page, "holdFolderReads");
    await backendCall(page, "releaseSaves");
    await expect.poll(() => page.evaluate(() => (window as any).trace.listing().some((entry: { path: string }) => entry.path === "/pictures/draft.png"))).toBe(true);
    await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
    expect(await gridCells(page)).toEqual(before);
    await backendCall(page, "releaseFolderReads"); await settle(page);
    await expect(page.locator('[data-entry-path="/pictures/draft.png"]')).toHaveCount(0);
    expect(await gridCells(page)).toEqual(before);
    expect(await uncaught(page)).toEqual([]);
  }

  test("closing the stack while saving", async ({ page }) => {
    await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
    await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
    await backendCall(page, "holdSaves");
    const cover = page.locator('[data-tile-key="o:10:0"]');
    await cover.hover();
    await cover.getByRole("button", { name: "Save image permanently" }).click();
    await stack(page, "draft").getByRole("button", { name: "Collapse stack" }).click(); await settle(page);
    await expect(stack(page, "draft").locator("[data-grid-band]")).toHaveCount(0);
    await finishWhileIndexLags(page, await gridCells(page));
  });

  test("saving from Preview, then selecting something else", async ({ page }) => {
    await openView(page, 420, "?grouping=unsaved-root-joined-with-source", false);
    await stack(page, "draft").locator("[data-stack-toggle]").click(); await settle(page);
    await page.locator('[data-tile-key="o:10:0"] [data-node-key]').click(); await settle(page);
    await backendCall(page, "holdSaves");
    await page.getByRole("complementary", { name: "Preview" }).getByRole("button", { name: "Save", exact: true }).click();
    await page.locator('[data-entry-path="/pictures/notes.txt"]').click(); await settle(page);
    await finishWhileIndexLags(page, await gridCells(page));
  });
});

/** Grid navigation stops; the stop's own stack disclosure is a secondary control reached by Tab. */
const tabStops = (page: Page) => page.locator('[role="grid"] [tabindex="0"]:not([data-stack-toggle])');

test("keyboard alone collapses and re-expands an open stack through its disclosure", async ({ page }) => {
  await openView(page, 900, "", false);
  const village = stack(page, "village");
  await village.locator("[data-stack-toggle]").click(); await settle(page);
  await expect(village.locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await village.locator(".cover-press").focus();
  // Only the stop's own disclosure is tabbable; other stacks' disclosures stay out of the tab order.
  await expect(page.locator('[data-stack-toggle][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("Tab");
  const toggle = village.locator("[data-stack-toggle]");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter"); await settle(page);
  await expect(village.locator("[data-grid-band]")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await village.locator(".cover-press").focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Space"); await settle(page);
  await expect(village.locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await uncaught(page)).toEqual([]);
});
const focusIsInGrid = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('[role="grid"]'));

test("deselecting the focused band tile leaves one tab stop and keeps the keyboard working", async ({ page }) => {
  await openView(page, 900, "", false);
  await stack(page, "village").locator("[data-stack-toggle]").click(); await settle(page);
  for (const name of ["warm", "rain", "quiet"]) { await page.locator(`[data-node-key="${await key(page, name)}"]`).click(); await settle(page); }
  await page.locator(`[data-node-key="${await key(page, "quiet")}"]`).click({ modifiers: ["Control"] }); await settle(page);
  await expect(tabStops(page)).toHaveCount(1);
  expect(await focusIsInGrid(page)).toBe(true);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-node-key") ?? null);
  const before = await focused();
  expect(before).not.toBeNull();
  await page.keyboard.press("ArrowDown"); await settle(page);
  const after = await focused();
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);
  expect(await uncaught(page)).toEqual([]);
});

test("merging the focused child's stack into another keeps one tab stop and focus in the grid", async ({ page }) => {
  await openView(page, 900, "?grouping=two-chains", false);
  for (const name of ["photo-a", "photo-b"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  await page.locator(`[data-node-key="${await key(page, "photo-b-edit")}"]`).click(); await settle(page);
  await page.evaluate(() => (window as any).trace.backend.joinGeneration(["photo-a-edit", "photo-b-edit"], "joined"));
  await expect(page.locator("section[data-component]")).toHaveCount(1);
  await settle(page);
  await expect(tabStops(page)).toHaveCount(1);
  expect(await focusIsInGrid(page)).toBe(true);
  expect(await uncaught(page)).toEqual([]);
});

for (const worker of [false, true]) test(`#56 cold open keeps the committed grid through ${worker ? "node reads and worker layout" : "node reads"}, then commits the band and following row together`, async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 4000 });
  await openView(page, 420, worker ? "?fanChildren=45" : "?gym=1&fileTile=1&tileSize=small", false);
  const samples = await page.evaluate(async ({ name, worker }) => {
    const w = window as any, backend = w.trace.backend;
    backend.holdNodeReads();
    if (worker) w.trace.holdLayoutReplies();
    const heldReplies = (): number => worker ? w.trace.heldLayoutReplies().length : 0;
    const section = document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
    const cover = section.querySelector<HTMLElement>("[data-grid-cell]")!;
    // A real following cell receives grid motion; measuring grid height alone misses a row reversal.
    const following = [...document.querySelectorAll<HTMLElement>("[data-grid-motion]")]
      .find((cell) => cell.getBoundingClientRect().top > cover.getBoundingClientRect().top + 2)!;
    const view = document.querySelector<HTMLElement>('[data-testid="trace-view"]')!;
    const baseline = following.getBoundingClientRect().top + view.scrollTop;
    const coverBefore = JSON.stringify(cover.getBoundingClientRect());
    const samples: Array<{ time: number; top: number; computedTop: number; band: boolean; bandBottom: number; content: boolean; progress: boolean; busy: boolean; coverMoved: boolean; workerHeld: boolean }> = [];
    const start = performance.now();
    let readsReleased = false, workerReleased = !worker, workerAt: number | null = null, stable = 0;
    try {
      section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
      while (stable < 4 && performance.now() - start < 10_000) {
        await new Promise(requestAnimationFrame);
        const time = performance.now() - start;
        const band = section.querySelector<HTMLElement>("[data-grid-band]");
        const background = band && document.querySelector<HTMLElement>(`[data-grid-row-band="${band.dataset.gridBandRow}"]`);
        const grid = following.closest<HTMLElement>('[role="grid"]')!;
        samples.push({ time, top: following.getBoundingClientRect().top + view.scrollTop,
          computedTop: parseFloat(getComputedStyle(following).top) + grid.getBoundingClientRect().top + view.scrollTop,
          band: !!band, bandBottom: background ? background.getBoundingClientRect().bottom + view.scrollTop : 0,
          content: !!band && band.querySelectorAll("[data-tile-key]").length > 0,
          progress: !!section.querySelector("[data-cover-progress]"), busy: !!section.querySelector('[aria-busy="true"]'),
          coverMoved: JSON.stringify(cover.getBoundingClientRect()) !== coverBefore, workerHeld: heldReplies() > 0 });
        if (!readsReleased && time >= 500) { backend.releaseNodeReads(); readsReleased = true; }
        if (heldReplies() && workerAt === null) workerAt = time;
        if (workerAt !== null && time - workerAt >= 500 && !workerReleased) {
          w.trace.releaseLayoutReplies(); workerReleased = true;
        }
        const moving = document.getAnimations().some((animation) => animation.playState === "running");
        stable = samples.at(-1)!.content && readsReleased && workerReleased && !moving && !w.trace.layoutsPending() ? stable + 1 : 0;
      }
      return { baseline, samples, settled: stable >= 4 };
    } finally {
      backend.releaseNodeReads(); w.trace.releaseLayoutReplies();
    }
  }, { name: worker ? "fan" : "gym", worker });
  await test.info().attach('cold-opening-frames', { body: JSON.stringify(samples), contentType: 'application/json' });
  expect(samples.settled).toBe(true);
  // Until the complete commit, the committed grid stays exactly as it was: no band, no reserved
  // space, the cover and the following row in place. Progress is on the cover, busy at once.
  const pending = samples.samples.filter((sample) => !sample.band);
  expect(pending.length).toBeGreaterThan(5);
  expect(pending.at(-1)!.time).toBeGreaterThanOrEqual(500);
  if (worker) expect(pending.filter((sample) => sample.workerHeld).at(-1)!.time).toBeGreaterThan(900);
  for (const sample of pending) {
    expect(Math.abs(sample.top - samples.baseline), JSON.stringify(sample)).toBeLessThan(.5);
    expect(sample.coverMoved, JSON.stringify(sample)).toBe(false);
    expect(sample.progress && sample.busy, JSON.stringify(sample)).toBe(true);
  }
  // The band commits complete, in one frame with its content and the following row's new place.
  const committed = samples.samples.slice(pending.length);
  expect(committed.length).toBeGreaterThan(0);
  expect(committed.every((sample) => sample.band && sample.content && !sample.progress && !sample.busy)).toBe(true);
  for (const sample of committed) expect(sample.computedTop, JSON.stringify(sample)).toBeGreaterThanOrEqual(sample.bandBottom - .5);
  // One coordinated move down to the final row: never back up, then steady.
  let previous = samples.baseline;
  for (const sample of committed) { expect(sample.top, JSON.stringify(sample)).toBeGreaterThanOrEqual(previous - .5); previous = sample.top; }
  const end = committed.at(-1)!;
  expect(end.top - samples.baseline).toBeGreaterThan(40);
  for (const sample of committed.filter((sample) => sample.time >= end.time - 40)) expect(sample.top).toBeCloseTo(end.top, 0);
  await expect(stack(page, worker ? "fan" : "gym").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  expect(await uncaught(page)).toEqual([]);
});

for (const worker of [false, true]) test(`cold children reveal from their accepted layout without a second ${worker ? "worker round trip" : "entrance"}`, async ({ page }) => {
  await openView(page, 840, worker ? "?fanChildren=45" : "?gym=1&fileTile=1&tileSize=small", false);
  const result = await page.evaluate(async ({ worker }) => {
    const section = document.querySelector<HTMLElement>(`section[aria-label="${worker ? "fan" : "gym"}"]`)!;
    const originalPost = Worker.prototype.postMessage, originalAnimate = Element.prototype.animate;
    let requests = 0, frame = 0, arrived: number | null = null, mounted: number | null = null, visible: number | null = null;
    const entrances: Animation[] = [];
    Worker.prototype.postMessage = function (message, options) {
      requests++;
      this.addEventListener("message", () => { arrived ??= frame; }, { once: true });
      return originalPost.call(this, message, options as any);
    };
    Element.prototype.animate = function (frames, options) {
      const animation = originalAnimate.call(this, frames, options);
      if (this.matches("[data-grid-band] [data-tile-key]") && Array.isArray(frames) && frames[0]?.opacity === 0) entrances.push(animation);
      return animation;
    };
    try {
      section.querySelector<HTMLElement>("[data-stack-toggle]")!.click();
      for (; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const children = [...section.querySelectorAll<HTMLElement>("[data-grid-band] [data-tile-key]")];
        if (children.length) mounted ??= frame;
        const band = section.querySelector<HTMLElement>("[data-grid-band]");
        const view = document.querySelector<HTMLElement>('[data-testid="trace-view"]')!.getBoundingClientRect();
        const background = band && document.querySelector(`[data-grid-row-band="${band.dataset.gridBandRow}"]`)!.getBoundingClientRect();
        const bounds = band?.getBoundingClientRect();
        const insets = band ? getComputedStyle(band).clipPath.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [] : [];
        const bottom = bounds ? bounds.bottom - (insets[2] ?? insets[0] ?? 0) : 0;
        if (bounds && background && children.some((child) => {
          const box = child.getBoundingClientRect();
          return Number(getComputedStyle(child).opacity) > 0 && box.right > view.left && box.left < view.right
            && box.bottom > Math.max(view.top, background.top, bounds.top + (insets[0] ?? 0))
            && box.top < Math.min(view.bottom, bottom);
        })) visible ??= frame;
        if (visible !== null && frame - visible >= 12 && !(window as any).trace.layoutsPending()) break;
      }
      const children = section.querySelectorAll("[data-grid-band] [data-tile-key]").length;
      return { requests, arrived, mounted, visible, children, entrances: entrances.length, cancelledEntrances: entrances.filter((animation) => animation.playState === "idle").length };
    } finally { Worker.prototype.postMessage = originalPost; Element.prototype.animate = originalAnimate; }
  }, { worker });
  expect(result.children).toBeGreaterThan(0);
  expect(result.mounted).not.toBeNull(); expect(result.visible).not.toBeNull();
  if (worker) expect(result.arrived).not.toBeNull();
  // Presence now waits for tile/connector attachment within the 160 ms reflow.
  // Twelve frames allow that arrival and scheduling slack; the #63 regression replayed ~20 frames.
  expect(result.visible! - (worker ? result.arrived! : result.mounted!)).toBeLessThanOrEqual(12);
  expect(result.entrances).toBe(result.children);
  expect(result.cancelledEntrances).toBe(0);
  expect(result.requests).toBe(worker ? 1 : 0);
  await settle(page);
  await expect(stack(page, worker ? "fan" : "gym").locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
  expect(await uncaught(page)).toEqual([]);
});

for (const host of ["", "&fileTile=1&tileSize=medium"]) test(`closed explorer covers dim without filtering their stacked thumbnail (${host ? "host" : "fallback"})`, async ({ page }) => {
  await openView(page, 620, `?grouping=two-chains${host}`, false);
  await stack(page, "photo-a").locator("[data-stack-toggle]").click(); await settle(page);
  const other = stack(page, "photo-b");
  await expect(other.locator("[data-grid-band]")).toHaveCount(0);
  const style = await other.locator(".tile").evaluate((tile) => ({
    filter: getComputedStyle(tile.querySelector(".image")!).filter,
    opacity: Number(getComputedStyle(tile.querySelector(".card")!).opacity),
  }));
  expect(style.filter).toBe("none");
  expect(style.opacity).toBeGreaterThan(0); expect(style.opacity).toBeLessThan(1);
});

test("opening a later row preserves an unchanged band's attachment motion", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 1600 });
  await openView(page, 420, "?deeper=1&fanChildren=2", false);
  for (const name of ["village", "forest"]) { await stack(page, name).locator("[data-stack-toggle]").click(); await settle(page); }
  const warm = await key(page, "warm"), mist = await key(page, "forest-mist");
  await page.locator(`[data-node-key="${warm}"]`).click(); await settle(page);
  await holdScriptedAnimations(page);
  let result: { before: number; at80: number; after: number; continued: number; end: number };
  try {
    // A data change is a reflow; focus-only selection would now snap.
    await page.evaluate(() => (window as any).trace.backend.startGeneration("warm", "carry-new")); await awaitAnimationsCreated(page);
    result = await page.evaluate(async (mist) => {
      const w = window as any, originals = [...w.__heldAnimations] as Animation[];
      const frame = () => new Promise(requestAnimationFrame);
      const y = () => document.querySelector<HTMLElement>(`[data-tile-key="${mist}"]`)!.getBoundingClientRect().y;
      const seek = async (animations: Animation[], time: number) => { for (const animation of animations) if (animation.playState === "running") animation.currentTime = time; await frame(); };
      // The original trajectory ahead of the interruption, then back to where it is interrupted.
      await seek(originals, 80);
      const at80 = y();
      await seek(originals, 40);
      const before = y();
      w.trace.setSelection([...w.trace.state().selected, "/pictures/fan.png"], "/pictures/warm.png");
      for (let i = 0; i < 12; i++) await frame();
      const after = y();
      // The interruption's epoch restarts the clock where the original motion was (40 ms in).
      const current = (w.__heldAnimations as Animation[]).filter((animation) => !originals.includes(animation));
      await seek(current, 40);
      const continued = y();
      await seek(current, 120);
      return { before, at80, after, continued, end: y() };
    }, mist);
  } finally { await releaseScriptedAnimations(page); }
  await settle(page);
  const settled = await page.locator(`[data-tile-key="${mist}"]`).evaluate((element) => element.getBoundingClientRect().y);
  // The unchanged band keeps travelling exactly as before: no jump at the interruption, the same
  // position 40 ms later as the original motion would have shown, and the original destination.
  expect(result.after).toBeCloseTo(result.before, 1);
  expect(Math.abs(settled - result.before)).toBeGreaterThan(2);
  expect(Math.abs(result.continued - result.at80)).toBeLessThanOrEqual(.5);
  expect(Math.abs(result.end - settled)).toBeLessThanOrEqual(.5);
  expect(await uncaught(page)).toEqual([]);
});

for (const host of ['', '&fileTile=1&tileSize=small']) for (const filename of ['long', 'wrapped']) test(`#68 a ${filename} name keeps its disclosure on the last line (${host || 'fallback'})`, async ({ page }) => {
  await openView(page, 420, `?grouping=two-chains&stackName=${filename}${host}`, false);
  const section = page.locator('section[data-component]').first();
  const text = section.locator('.text').first(), caret = section.locator('[data-stack-toggle]');
  const measure = async () => {
    const box = (await text.boundingBox())!, button = (await caret.boundingBox())!;
    const line = await text.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
    expect(box.height).toBeCloseTo(line * 2, 0);
    expect(button.x).toBeGreaterThanOrEqual(box.x + box.width);
    if (filename === 'wrapped') {
      const last = await text.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const lines = [...range.getClientRects()]; return lines.at(-1)!.right;
      });
      expect(button.x - last).toBeLessThanOrEqual(3);
    }
    expect(button.y + button.height / 2).toBeCloseTo(box.y + box.height - line / 2, 0);
    const tile = (await section.locator('[data-grid-cell]').boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(tile.x + tile.width);
    expect(button.y + button.height).toBeLessThanOrEqual(tile.y + tile.height);
  };
  await measure();
  await caret.click(); await settle(page);
  await expect(section.locator('[data-grid-band] [data-tile-key]').first()).toBeVisible();
  await measure();
  const selected = (await state(page)).selected;
  // A press and drag on disclosure must not start marquee or select any other tile.
  const box = (await caret.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 80, { steps: 4 });
  await expect(page.locator('.marquee-rect')).toHaveCount(0);
  await page.mouse.up(); await settle(page);
  expect((await state(page)).selected).toEqual(selected);
  await caret.focus(); await page.keyboard.press('Enter'); await settle(page);
  await expect(section.locator('[data-grid-band]')).toHaveCount(0);
  expect((await state(page)).selected).toEqual(selected);
});

for (const theme of ["light", "dark"]) for (const preset of [null, "small", "medium", "large", "xlarge"]) {
  test(`#69 fanned cards stay inside the tile and keep the cover aligned (${theme}, ${preset ?? "fallback"})`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await openView(page, 840, `?grouping=two-chains&theme=${theme}${preset ? `&fileTile=1&tileSize=${preset}` : ""}`, false);
    const first = stack(page, "photo-a"), second = stack(page, "photo-b");
    const cover = first.locator(".image").first();
    const original = (await cover.boundingBox())!;
    const caption = (await first.locator(".label").first().boundingBox())!;
    const verify = async (section: ReturnType<typeof stack>, count: number) => {
      const tile = (await section.locator("[data-grid-cell] .tile").boundingBox())!;
      const sheets = section.locator("[data-grid-cell] .stack-sheet");
      await expect(sheets).toHaveCount(count);
      const image = (await section.locator(".image").first().boundingBox())!;
      const angles: number[] = [];
      for (const sheet of await sheets.all()) {
        const box = (await sheet.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(tile.x);
        expect(box.y).toBeGreaterThanOrEqual(tile.y);
        expect(box.x + box.width).toBeLessThanOrEqual(tile.x + tile.width);
        expect(box.y + box.height).toBeLessThanOrEqual(tile.y + tile.height);
        const style = await sheet.evaluate((element) => {
          const style = getComputedStyle(element), matrix = new DOMMatrixReadOnly(style.transform);
          return { angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI, border: style.borderTopWidth,
            filter: style.filter, backdrop: style.backdropFilter, shadow: style.boxShadow };
        });
        angles.push(style.angle);
        expect(style.border).toBe("1px"); expect(style.filter).toBe("none");
        expect(style.backdrop).toBe("none"); expect(style.shadow).toBe("none"); // shadows stall the host's software renderer
      }
      expect(angles[0]).toBeLessThanOrEqual(-6); expect(angles[0]).toBeGreaterThanOrEqual(-8.1);
      if (count === 2) {
        expect(angles[1]).toBeGreaterThanOrEqual(6); expect(angles[1]).toBeLessThanOrEqual(8);
        expect(Math.abs(angles[0])).toBeGreaterThan(angles[1]);
      }
      // Enough exposed paper to read as a pile at normal size, scaling with the cover.
      const back = (await sheets.first().boundingBox())!;
      expect(image.x - back.x).toBeGreaterThan(image.height * .05);
      expect(image.y - back.y).toBeGreaterThan(image.height * .03);
      if (count === 2) {
        const front = (await sheets.last().boundingBox())!;
        expect(front.x + front.width - image.x - image.width).toBeGreaterThan(image.height * .05);
      }
      const contrast = await sheets.first().evaluate((element) => {
        const style = getComputedStyle(element), card = getComputedStyle(element.closest(".card")!);
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const pane = getComputedStyle(document.documentElement).getPropertyValue("--background-solid");
        const sample = (...layers: string[]) => {
          context.clearRect(0, 0, 1, 1);
          for (const color of layers) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const background = sample(pane, card.backgroundColor);
        const distance = (color: string) => Math.hypot(...sample(pane, card.backgroundColor, color).map((channel, i) => channel - background[i]));
        return { surface: distance(style.backgroundColor), edge: distance(style.borderTopColor) };
      });
      expect(contrast.surface).toBeGreaterThan(20); expect(contrast.edge).toBeGreaterThan(80);
      const ordinary = page.locator('[data-entry-path="/pictures/plain.png"]');
      const ordinaryImage = (await ordinary.locator(".icon").boundingBox())!;
      expect(image.y).toBeCloseTo(ordinaryImage.y, 1);
      expect(image.width).toBeCloseTo(ordinaryImage.width, 1);
      expect(image.height).toBeCloseTo(ordinaryImage.height, 1);
      const label = (await section.locator(".label").first().boundingBox())!;
      expect(label.y).toBeCloseTo((await ordinary.locator(".name").boundingBox())!.y, 1);
      // Paint order keeps the cover and its status marks ahead of the sheets.
      await expect(section.locator(".image img").first()).toBeVisible();
      await expect(section.locator(".count-badge").first()).toBeVisible();
    };
    await verify(first, 1); await verify(second, 1);
    await page.evaluate(() => {
      const backend = (window as any).trace.backend;
      backend.startGeneration("photo-b", "third-photo"); backend.completeGeneration("third-photo");
    });
    await settle(page); await verify(second, 2);
    await expect(second.locator(".cover-unsaved-dot")).toBeVisible();
    await second.locator(".cover-press").hover(); await settle(page); await verify(second, 2);
    await page.mouse.move(1, 1);
    await first.locator("[data-stack-toggle]").click(); await settle(page);
    await expect(first.locator("[data-grid-band] [data-tile-key]").first()).toBeVisible();
    await verify(first, 1); await verify(second, 2);
    const after = (await cover.boundingBox())!;
    expect(after.x).toBeCloseTo(original.x, 1); expect(after.y).toBeCloseTo(original.y, 1);
    expect((await first.locator(".label").first().boundingBox())!.y).toBeCloseTo(caption.y, 1);
    expect(await uncaught(page)).toEqual([]);
  });
}
