import { test, expect, type Page } from "@playwright/test";
import { openView, click, key, tile, card, state, uncaught, settle, rendered } from "./support";

const previewTitle = (page: Page) => page.getByTestId("preview-title");
const preview = (page: Page) => page.getByRole("complementary", { name: "Preview" });
const trace = (page: Page) => preview(page).getByRole("region", { name: "Trace" });
const detailsToggle = (page: Page) => trace(page).getByRole("button", { name: "Trace details" });

async function openDetails(page: Page) {
  await detailsToggle(page).click();
  await expect(detailsToggle(page)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
}

/**
 * Records, every frame, the top of the Preview image and the height of the
 * info sections while `act` runs and the backend answers.
 */
async function framesDuring(page: Page, act: () => Promise<void>, settleMs: number) {
  await page.evaluate(() => {
    const samples: Array<{ image: number; sections: number }> = [];
    (window as any).frames = samples;
    (window as any).sampling = true;
    const tick = () => {
      const image = document.querySelector("[data-testid=preview-image]")?.getBoundingClientRect().top ?? -1;
      const sections = document.querySelector("aside .sections")?.getBoundingClientRect().height ?? -1;
      samples.push({ image: Math.round(image), sections: Math.round(sections) });
      if ((window as any).sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  await page.waitForTimeout(settleMs);
  await settle(page);
  return page.evaluate(() => { (window as any).sampling = false; return (window as any).frames as Array<{ image: number; sections: number }>; });
}

/** Consecutive distinct values: a jump that snaps back shows up as an extra value. */
const changes = (values: number[]) => values.filter((value, index) => index === 0 || value !== values[index - 1]);

/** Opens the temporary `merge` output in Preview (it renders once `warm` is focused). */
async function previewMerge(page: Page) {
  await openView(page);
  await click(page, "warm");
  await click(page, "merge");
  await expect(previewTitle(page)).toHaveText("merge.png");
}

test.describe("references and unsaved outputs open in Preview without navigating", () => {
  test("a temporary output shows an Unsaved Preview and does not touch Explorer", async ({ page }) => {
    await previewMerge(page);
    await expect(page.getByTestId("preview-badge")).toHaveText("Unsaved");
    const after = await state(page);
    expect(after.navigations).toEqual([]);
    expect(after.selected).toEqual([]);
    expect(after.target?.badge).toBe("Unsaved");
    await expect(await card(page, "merge")).toHaveAttribute("aria-pressed", "true");
    expect(await rendered(page, "tone", "focus")).toEqual(["merge"]);
  });

  for (const [name, title] of [["lantern", "lantern.png"], ["mist", "mist.png"]] as const) {
    test(`the ${name} reference opens in Preview without navigating or selecting`, async ({ page }) => {
      await openView(page);
      await click(page, "warm");
      await click(page, name);
      await expect(previewTitle(page)).toHaveText(title);
      const after = await state(page);
      expect(after.navigations).toEqual([]);
      expect(after.selected).toEqual([]);
      expect(await rendered(page, "tone", "focus")).toEqual([name]);
    });
  }
});

test.describe("Preview info", () => {
  test("shows the prompt without a section title, and the details collapsed", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await expect(trace(page).getByTestId("trace-prompt")).toHaveText("warm prompt");
    await expect(trace(page).getByRole("heading")).toHaveCount(0);
    await expect(trace(page)).not.toContainText(/^Trace$/m);
    await expect(detailsToggle(page)).toHaveAttribute("aria-expanded", "false");
    for (const hidden of ["Operation", "Resolution", "Aspect ratio", "Actual size", "Inputs", "Raw"]) {
      await expect(trace(page).getByText(hidden, { exact: true })).toBeHidden();
    }
    // Collapsed content cannot be reached with the keyboard.
    await expect(trace(page).getByRole("button", { name: /Preview input/ })).toHaveCount(0);
  });

  test("opening Trace details shows the settings, inputs and Raw, and stays open for the next image", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const panel = trace(page).getByTestId("trace-details");
    const closed = (await panel.boundingBox())!.height;
    await openDetails(page);
    expect((await panel.boundingBox())!.height).toBeGreaterThan(closed + 100);
    await expect(trace(page).getByText("Aspect ratio", { exact: true })).toBeVisible();
    await expect(trace(page).locator("summary", { hasText: "Raw" })).toBeVisible();
    await click(page, "rain");
    await expect(trace(page).getByTestId("trace-prompt")).toHaveText("rain prompt");
    await expect(detailsToggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(trace(page).getByText("Resolution", { exact: true })).toBeVisible();
    await detailsToggle(page).click();
    await settle(page);
    await expect(detailsToggle(page)).toHaveAttribute("aria-expanded", "false");
    expect((await panel.boundingBox())!.height).toBe(closed);
    await expect(trace(page).getByText("Resolution", { exact: true })).toBeHidden();
  });

  test("opening and closing Trace details animates over a short time", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const panel = trace(page).getByTestId("trace-details");
    const heights = await page.evaluate(async () => {
      const element = document.querySelector<HTMLElement>("[data-testid=trace-details]")!;
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Trace details")!;
      const samples: Array<[number, number]> = [];
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => {
        const tick = () => { samples.push([performance.now() - start, element.getBoundingClientRect().height]); if (performance.now() - start < 600) requestAnimationFrame(tick); else resolve(); };
        requestAnimationFrame(tick);
      });
      return samples;
    });
    const final = heights.at(-1)![1];
    const intermediate = heights.filter(([, height]) => height > 1 && height < final - 1);
    expect(intermediate.length, "the panel passes through intermediate heights").toBeGreaterThan(0);
    const opened = heights.find(([, height]) => Math.abs(height - final) < 0.5)![0];
    expect(opened, "and is fully open quickly").toBeLessThan(350);
    await expect(panel).toBeVisible();
  });

  test("rows line up with the host's own info rows", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await openDetails(page);
    const host = page.getByTestId("host-info").locator(".info-row").first();
    const row = trace(page).locator(".row").first();
    const [hostLabel, hostValue, label, value] = await Promise.all([
      host.locator(".info-label").boundingBox(), host.locator(".info-value").boundingBox(),
      row.locator("dt").boundingBox(), row.locator("dd").boundingBox(),
    ]);
    const promptText = await trace(page).getByTestId("trace-prompt").evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects()[0].left; });
    expect(label!.x).toBeCloseTo(hostLabel!.x, 0);
    expect(promptText).toBeCloseTo(hostLabel!.x, 0);
    expect(value!.x + value!.width).toBeCloseTo(hostValue!.x + hostValue!.width, 0);
    const styles = (selector: string) => page.locator(selector).first().evaluate((element) => { const style = getComputedStyle(element); return [style.color, style.fontSize]; });
    expect(await styles("aside [data-testid=host-info] .info-label")).toEqual(await styles("aside section[aria-label=Trace] dt"));
    expect(await styles("aside [data-testid=host-info] .info-value")).toEqual(await styles("aside section[aria-label=Trace] dd"));
  });

  for (const open of [false, true]) {
    test(`selecting another image does not move the preview while its trace loads (details ${open ? "open" : "closed"})`, async ({ page }) => {
      await openView(page);
      await page.evaluate(() => (window as any).trace.backend.setPreviewLatency(120));
      await click(page, "warm");
      await page.waitForTimeout(200);
      if (open) await openDetails(page);
      // `rain` has the same settings and one input where `warm` has four.
      const frames = await framesDuring(page, () => click(page, "rain"), 300);
      await expect(trace(page).getByTestId("trace-prompt")).toHaveText("rain prompt");
      expect(frames.length).toBeGreaterThan(5);
      expect(changes(frames.map((frame) => frame.sections)).length, `section heights ${JSON.stringify(changes(frames.map((frame) => frame.sections)))}`).toBeLessThanOrEqual(open ? 2 : 1);
      expect(changes(frames.map((frame) => frame.image)).length, `image tops ${JSON.stringify(changes(frames.map((frame) => frame.image)))}`).toBeLessThanOrEqual(open ? 2 : 1);
    });
  }

  test("aspect ratio kept from the input reads Keep", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await openDetails(page);
    await expect(trace(page).locator(".row", { hasText: "Aspect ratio" }).locator("dd")).toHaveText("Keep");
  });

  test("shows the prompt, parameters and actual size", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await expect(trace(page).getByTestId("trace-prompt")).toHaveText("warm prompt");
    await openDetails(page);
    const settings = trace(page).locator("dl");
    await expect(settings).toContainText("Resolution");
    await expect(settings).toContainText("2K");
    await expect(settings).toContainText("Seed");
    await expect(settings).toContainText("7");
    await expect(settings).toContainText("Actual size");
    await expect(settings).toContainText("1024 × 768 px");
  });

  test("lists inputs with their scope and focusing an input focuses it in the graph", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await openDetails(page);
    const inputs = trace(page).locator("ul.inputs li");
    await expect(inputs).toHaveCount(4);
    await expect(inputs.filter({ hasText: "village" })).toContainText("This folder");
    await expect(inputs.filter({ hasText: "mist" })).toContainText("Subfolder");
    await expect(inputs.filter({ hasText: "lantern" })).toContainText("External");
    await trace(page).getByRole("button", { name: /Preview input .*palette/ }).click();
    await settle(page);
    await expect(await tile(page, "palette")).toHaveAttribute("data-tone", "focus");
    expect(await rendered(page, "tone", "focus")).toEqual(["palette"]);
    await expect(previewTitle(page)).toHaveText("palette.png");
    // An outside input opens as a Preview target without navigating.
    await click(page, "warm");
    await trace(page).getByRole("button", { name: /Preview input .*lantern/ }).click();
    await settle(page);
    await expect(await tile(page, "lantern")).toHaveAttribute("data-tone", "focus");
    expect((await state(page)).navigations).toEqual([]);
  });

  test("raw data is collapsed until opened", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await openDetails(page);
    const raw = trace(page).locator("details");
    await expect(raw).not.toHaveAttribute("open", "");
    await expect(raw.locator("pre")).not.toBeVisible();
    await raw.locator("summary").click();
    await expect(raw).toHaveAttribute("open", "");
    await expect(raw.locator("pre")).toContainText("warm prompt");
  });
});

test.describe("saving and deleting unsaved outputs", () => {
  test("Save from Preview keeps the tile identity and selects the saved file", async ({ page }) => {
    await previewMerge(page);
    const merge = await tile(page, "merge");
    await expect(merge.locator(".unsaved-dot")).toHaveCount(1);
    const identity = await key(page, "merge");
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
    await settle(page);
    await expect(page.locator(`[data-tile-key="${identity}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-tile-key="${identity}"] .unsaved-dot`)).toHaveCount(0);
    await expect(page.getByTestId("preview-badge")).toHaveCount(0);
    await expect(page.locator("section.component .heading .unsaved")).toHaveCount(0);
    expect((await state(page)).navigations).toEqual([]);
    expect(await uncaught(page)).toEqual([]);
  });

  test("the tile's hover save button saves under the same identity", async ({ page }) => {
    await previewMerge(page);
    const merge = await tile(page, "merge");
    await merge.hover();
    await merge.getByRole("button", { name: "Save image permanently" }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
    await settle(page);
    await expect(merge).toHaveCount(1);
    await expect(merge.locator(".unsaved-dot")).toHaveCount(0);
  });

  test("hover-saving an output that is not focused selects it when the selection did not change meanwhile", async ({ page }) => {
    await openView(page);
    await (await card(page, "warm")).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/warm.png"]);
    await settle(page);
    const merge = await tile(page, "merge");
    await merge.hover();
    await merge.getByRole("button", { name: "Save image permanently" }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
    await expect(merge.locator(".unsaved-dot")).toHaveCount(0);
  });

  test("Save as… saves to the picked path", async ({ page }) => {
    await previewMerge(page);
    await preview(page).getByRole("button", { name: "Save as…" }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/picked.png"]);
    const calls = await page.evaluate(() => (window as any).trace.backend.calls("save_generated_image"));
    expect(calls.map((call: any) => call.params.target)).toEqual(["/pictures/picked.png"]);
  });

  test("cancelling the Save as… picker writes nothing and keeps the output unsaved", async ({ page }) => {
    await previewMerge(page);
    await page.evaluate(() => (window as any).trace.backend.setPicker(null));
    await preview(page).getByRole("button", { name: "Save as…" }).click();
    await expect(preview(page).getByRole("button", { name: "Save as…" })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).trace.backend.calls("save_generated_image"))).toEqual([]);
    await expect(page.getByTestId("preview-badge")).toHaveText("Unsaved");
    expect((await state(page)).selected).toEqual([]);
  });

  test("a failed save reports the error and leaves the output unsaved", async ({ page }) => {
    await previewMerge(page);
    await page.evaluate(() => (window as any).trace.backend.failNextSave("A file named merge.png already exists"));
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");
    await expect(page.getByTestId("preview-badge")).toHaveText("Unsaved");
    expect((await state(page)).selected).toEqual([]);
    // The action is available again and a retry succeeds.
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await state(page)).selected).toEqual(["/pictures/merge.png"]);
  });

  test("Delete marks the output deleted and keeps its parents", async ({ page }) => {
    await previewMerge(page);
    await preview(page).getByRole("button", { name: /^Delete/ }).click();
    await expect(page.getByTestId("preview-badge")).toHaveText("Deleted");
    await settle(page);
    await expect(await card(page, "merge")).toHaveAttribute("aria-label", /Deleted/);
    await expect((await tile(page, "merge")).locator(".unsaved-dot")).toHaveCount(0);
    await expect(await tile(page, "warm")).toHaveCount(1);
    await expect(await tile(page, "daylight")).toHaveCount(1);
    expect((await state(page)).navigations).toEqual([]);
  });

  test("a delayed save cannot steal a newer selection", async ({ page }) => {
    await previewMerge(page);
    await page.evaluate(() => (window as any).trace.backend.holdSaves());
    await preview(page).getByRole("button", { name: "Save", exact: true }).click();
    await click(page, "warm");
    expect((await state(page)).selected).toEqual(["/pictures/warm.png"]);
    await page.evaluate(() => (window as any).trace.backend.releaseSaves());
    await expect.poll(async () => (await page.evaluate(() => (window as any).trace.backend.node("merge"))).temporary).toBe(false);
    await settle(page);
    await page.waitForTimeout(300);
    expect((await state(page)).selected).toEqual(["/pictures/warm.png"]);
    expect(await rendered(page, "tone", "focus")).toEqual(["warm"]);
  });
});

test.describe("generation", () => {
  test("a running generation shows a spinner child that completes in place", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    const identity = await page.evaluate(() => (window as any).trace.backend.startGeneration("warm", "gen") as string);
    const generated = page.locator(`[data-tile-key="${identity}"]`);
    await expect(generated.getByRole("status", { name: "Generating" })).toBeVisible();
    await expect(generated.locator("img")).toHaveCount(0);
    // It is drawn as a child of warm.
    await expect(page.locator(`svg path[data-route][data-to="node:${identity}"]`)).toHaveCount(1);
    await expect(page.locator(`svg path[data-route][data-to="node:${identity}"]`)).toHaveAttribute("data-from", new RegExp(`node:${await key(page, "warm")}|junction`));
    await settle(page);
    await page.evaluate(() => (window as any).trace.backend.completeGeneration("gen"));
    await expect(page.locator(`[data-tile-key="${identity}"] img`)).toBeVisible();
    await expect(page.locator(`[data-tile-key="${identity}"]`)).toHaveCount(1);
    await expect(generated.getByRole("status", { name: "Generating" })).toHaveCount(0);
    await expect(generated.locator(".unsaved-dot")).toHaveCount(1);
    expect(await uncaught(page)).toEqual([]);
  });
});

test.describe("titles", () => {
  test("unconfigured titles show the prompt with no spinner and no model request", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await expect((await tile(page, "warm")).locator(".text")).toHaveText("warm prompt");
    await expect((await tile(page, "warm")).locator(".text")).toHaveCSS("text-overflow", "ellipsis");
    await expect(page.getByRole("status", { name: "Generating title" })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).trace.backend.titles.calls())).toEqual([]);
  });

  test("configured titles show a spinner beside the prompt, then the generated title", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await page.evaluate(async () => { (window as any).trace.backend.titles.connect(true); await (window as any).trace.configureTitles({}); });
    // A data refresh (a new generation) makes the view request titles for the loaded runs.
    await page.evaluate(() => (window as any).trace.backend.startGeneration("forest", "gen"));
    const warm = await tile(page, "warm");
    await expect(warm.getByRole("status", { name: "Generating title" })).toBeVisible();
    await expect(warm.locator(".text")).toHaveText("warm prompt");
    await page.evaluate(async () => {
      const b = (window as any).trace.backend; const target = b.runId("warm"); const done = new Set<number>();
      for (let i = 0; i < 300 && !done.has(target); i++) {
        for (const id of b.titles.calls()) if (!done.has(id)) { done.add(id); b.titles.finish(id, id === target ? "Warm edit" : `Title ${id}`); }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    await expect(warm.locator(".text")).toHaveText("Warm edit");
    await expect(warm.getByRole("status", { name: "Generating title" })).toHaveCount(0);
    await expect(await card(page, "warm")).toHaveAttribute("title", "warm prompt");
    await page.evaluate(async () => await (window as any).trace.configureTitles({ titleGenerator: "disabled" }));
    await expect(page.getByRole("status", { name: "Generating title" })).toHaveCount(0);
  });
});

test.describe("thumbnails", () => {
  const srcs = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-tile-key]")]
    .map((element) => [element.dataset.tileKey!, element.querySelector("img")?.getAttribute("src") ?? null])));

  test("changing selection reuses loaded thumbnails without placeholders", async ({ page }) => {
    await openView(page);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".graph img")].every((image) => image.complete && image.naturalWidth > 0));
    const before = await srcs(page);
    expect(Object.values(before).some(Boolean)).toBe(true);
    await page.evaluate(() => {
      (window as any).placeholders = [];
      const known = new Set([...document.querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => element.dataset.tileKey));
      new MutationObserver(() => {
        for (const element of document.querySelectorAll<HTMLElement>("[data-tile-key]")) {
          if (known.has(element.dataset.tileKey) && element.querySelector(".placeholder")) (window as any).placeholders.push(element.dataset.tileKey);
        }
      }).observe(document.querySelector(".trace-view")!, { childList: true, subtree: true });
    });
    await click(page, "warm");
    await click(page, "rain");
    const after = await srcs(page);
    for (const [tileKey, source] of Object.entries(before)) if (source && after[tileKey]) expect(after[tileKey]).toBe(source);
    expect(await page.evaluate(() => (window as any).placeholders)).toEqual([]);
  });

  test("a data refresh keeps images visible and tile geometry unchanged", async ({ page }) => {
    await openView(page);
    await click(page, "warm");
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".graph img")].every((image) => image.complete && image.naturalWidth > 0));
    const geometry = () => page.evaluate(() => [...document.querySelectorAll("section.component")[0].querySelectorAll<HTMLElement>("[data-tile-key]")].map((element) => [element.dataset.tileKey, element.style.left, element.style.top, element.style.width, element.style.height]));
    const before = await geometry();
    const images = await page.locator(".graph img").count();
    await page.evaluate(() => (window as any).trace.backend.startGeneration("forest", "gen"));
    await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_component_nodes").length)).toBeGreaterThan(3);
    await settle(page);
    expect(await page.locator(".graph .placeholder").count()).toBe(0);
    expect(await page.locator(".graph img").count()).toBeGreaterThanOrEqual(images);
    const after = await geometry();
    for (const row of before) expect(after).toContainEqual(row);
  });
});
