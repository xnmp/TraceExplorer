import { test, expect } from "@playwright/test";
import { openView, state, tile, card, settle, click } from "./support";

const estimated = { amount: "0.04", currency: "USD", estimated: true, source: "ratecard:fixture" };

async function generated(page: import("@playwright/test").Page, parent = "warm", cost = true) {
  return page.evaluate(({ parent, cost, estimated }) => {
    const b = (window as any).trace.backend;
    b.startGeneration(parent, "revealed");
    b.completeGeneration("revealed");
    b.registerJob("revealed", 71, cost ? estimated : undefined);
    return b.node("revealed").artifactId;
  }, { parent, cost, estimated });
}

test("Show image expands a collapsed component and focuses an unsaved Preview with cost", async ({ page }) => {
  await openView(page);
  const artifact = await generated(page);
  const section = page.locator('section.component[aria-label="village"]');
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  await section.locator("[data-stack-toggle]").click();
  await settle(page);
  await page.evaluate(() => (window as any).trace.showJob(71));
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
  await expect(page.getByTestId("preview-badge")).toHaveText("Unsaved");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as…", exact: true })).toBeVisible();
  await expect(await tile(page, "revealed")).toHaveAttribute("data-tone", "focus");
  await expect(await card(page, "revealed")).toBeFocused();
  await page.getByRole("button", { name: "Trace details", exact: true }).click();
  await expect(page.locator(".row").filter({ has: page.getByText("Cost", { exact: true }) })).toHaveText("Cost≈US$0.04");
  const snapshot = await page.evaluate(() => (window as any).trace.backend.jobStatus(71));
  expect(snapshot.reveal).toEqual({ kind: "view", viewId: "trace.view", directory: "/pictures", targetId: `artifact:${artifact}` });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await (window as any).trace.backend.jobStatus(71)).reveal)).toEqual({ kind: "file", path: "/pictures/revealed.png" });
  await page.evaluate(() => (window as any).trace.showJob(71));
  expect((await state(page)).selected).toEqual(["/pictures/revealed.png"]);
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
});

test("revealing the already focused image keeps displayed band tiles still", async ({ page }) => {
  await openView(page);
  await generated(page);
  await page.evaluate(() => (window as any).trace.showJob(71)); await settle(page);
  const image = await tile(page, "revealed"), before = (await image.boundingBox())!;
  const original = await page.evaluate(() => {
    const w = window as any, original = Element.prototype.animate;
    w.revealAnimations = [];
    Element.prototype.animate = function (...args: Parameters<Element["animate"]>) {
      w.revealAnimations.push({ target: this, frames: args[0] });
      return original.apply(this, args);
    };
    w.restoreRevealAnimate = () => Element.prototype.animate = original;
    return true;
  });
  expect(original).toBe(true);
  try {
    await page.evaluate(() => (window as any).trace.showJob(71)); await settle(page);
    const after = (await image.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 1); expect(after.y).toBeCloseTo(before.y, 1);
    expect(await page.evaluate(() => (window as any).revealAnimations.filter((call: { target: Element; frames: Keyframe[] }) =>
      call.target.matches('[data-tile-key]') && Array.isArray(call.frames) && call.frames.some((frame) => "transform" in frame)).length)).toBe(0);
    await expect(await card(page, "revealed")).toBeFocused();
  } finally { await page.evaluate(() => (window as any).restoreRevealAnimate()); }
});

test("Show image loads an offscreen component and omits cost when unavailable", async ({ page }) => {
  await openView(page, 220, "?many=240", false);
  await page.evaluate(() => (window as any).trace.selectPath("/pictures/m24.png"));
  await settle(page);
  await page.getByRole("region", { name: "m24", exact: true }).locator("[data-node-key]").first().scrollIntoViewIfNeeded();
  await settle(page);
  await page.getByTestId("trace-view").click({ position: { x: 2, y: 2 } });
  await settle(page);
  await generated(page, "m24", false);
  const section = page.getByRole("region", { name: "m24", exact: true });
  const componentId = await section.getAttribute("data-component");
  expect(componentId).not.toBeNull();
  await expect(await tile(page, "revealed")).toHaveCount(1);
  // Grid order follows the folder listing. Scroll away from the loaded band
  // so Show image must mount it again and bring its target into the viewport.
  await page.getByTestId("trace-view").evaluate((element) => { element.scrollTop = 0; });
  await settle(page);
  await expect(section).not.toBeInViewport();
  await expect(await tile(page, "revealed")).toHaveCount(0);
  const nodeReads = () => page.evaluate((id) => (window as any).trace.backend.calls("trace_component_nodes")
    .filter((call: { params: { componentId: string } }) => call.params.componentId === id).length, componentId);
  const before = await nodeReads();
  await page.evaluate(() => (window as any).trace.showJob(71));
  await expect.poll(nodeReads).toBeGreaterThan(before);
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
  await expect(await tile(page, "revealed")).toHaveAttribute("data-tone", "focus");
  await expect(await card(page, "revealed")).toBeFocused();
  await expect(await tile(page, "revealed")).toBeInViewport();
  await page.getByRole("button", { name: "Trace details", exact: true }).click();
  await expect(page.getByText("Cost", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});

test("Show image first-loads an unseen component published while Trace is closed", async ({ page }) => {
  await openView(page, 220, "?many=240", false);
  const section = page.getByRole("region", { name: "m24", exact: true });
  const componentId = await page.evaluate(() => `c:${(window as any).trace.backend.key("m24")}`);
  await expect(section).toHaveCount(0);
  const nodeReads = () => page.evaluate((id) => (window as any).trace.backend.calls("trace_component_nodes")
    .filter((call: { params: { componentId: string } }) => call.params.componentId === id).length, componentId);
  expect(await nodeReads()).toBe(0);
  // Publish with Trace closed to exercise the first-ever node read on reveal.
  await page.evaluate(() => (window as any).trace.toggle());
  await expect(page.getByTestId("trace-view")).toHaveCount(0);
  await generated(page, "m24", false);
  expect(await nodeReads()).toBe(0);
  await page.evaluate(() => (window as any).trace.showJob(71));
  await expect.poll(nodeReads).toBeGreaterThan(0);
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
  await expect(await tile(page, "revealed")).toHaveAttribute("data-tone", "focus");
  await expect(await card(page, "revealed")).toBeFocused();
  await expect(await tile(page, "revealed")).toBeInViewport();
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "true");
});

test("aborting during loading preserves the existing focus and expansion", async ({ page }) => {
  await openView(page);
  await generated(page);
  await click(page, "warm");
  const before = await state(page);
  const expanded = await page.locator("[data-stack-toggle][aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")));
  const count = await page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length);
  await page.evaluate(() => {
    const w = window as any;
    w.revealController = new AbortController();
    w.trace.backend.setFolderLatency(150);
    w.revealResult = w.trace.showJob(71, w.revealController.signal).then(() => "completed", (e: Error) => e.name);
  });
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length)).toBeGreaterThan(count);
  const result = await page.evaluate(async () => { const w = window as any; w.revealController.abort(); return w.revealResult; });
  expect(result).toBe("AbortError");
  expect(await state(page)).toEqual(before);
  expect(await page.locator("[data-stack-toggle][aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")))).toEqual(expanded);
  await expect(page.getByTestId("preview-title")).toHaveText("warm.png");
});

test("a disappeared target rejects without replacing the current Preview", async ({ page }) => {
  await openView(page);
  await click(page, "warm");
  const result = await page.evaluate(async () => {
    try { await (window as any).trace.revealTarget("artifact:999999"); return "completed"; }
    catch (e) { return (e as Error).message; }
  });
  expect(result).toContain("no longer exists");
  await expect(page.getByTestId("preview-title")).toHaveText("warm.png");
});

for (const choice of ["tile", "host", "extra"] as const) {
  test(`a ${choice} selection supersedes a reveal still loading`, async ({ page }) => {
    await openView(page);
    await generated(page);
    if (choice === "extra") {
      await page.evaluate(() => {
        const b = (window as any).trace.backend;
        b.startGeneration("forest", "extra");
        b.completeGeneration("extra");
      });
      await settle(page);
    }
    await click(page, "warm");
    const section = page.locator('section.component[aria-label="village"]');
    await section.locator("[data-stack-toggle]").click();
    await settle(page);
    const reads = await page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length);
    await page.evaluate(() => {
      const w = window as any;
      w.trace.backend.holdFolderReads();
      w.revealResult = w.trace.showJob(71).then(() => "completed", (error: Error) => error.name);
    });
    await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length)).toBeGreaterThan(reads);
    if (choice === "host") await page.evaluate(() => (window as any).trace.selectPath("/pictures/forest.png"));
    else if (choice === "extra") await click(page, "extra", { modifiers: ["Control"] });
    else await click(page, "forest");
    const chosen = await state(page);
    const expansion = await page.locator("[data-stack-toggle][aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")));
    expect(chosen.inputs.length).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
    expect(await page.evaluate(() => (window as any).revealResult)).toBe("AbortError");
    await settle(page);
    expect(await state(page)).toEqual(chosen);
    expect(await page.locator("[data-stack-toggle][aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")))).toEqual(expansion);
    await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("preview-title")).toHaveText(choice === "extra" ? "warm.png" : "forest.png");
  });
}

test("a newer reveal supersedes an older loading request", async ({ page }) => {
  await openView(page);
  await generated(page);
  const reads = await page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length);
  await page.evaluate(() => {
    const w = window as any;
    w.trace.backend.holdFolderReads();
    w.revealResult = w.trace.showJob(71).then(() => "completed", (error: Error) => error.name);
  });
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length)).toBeGreaterThan(reads);
  await page.evaluate(() => {
    const w = window as any;
    w.newReveal = w.trace.revealTarget(`artifact:${w.trace.backend.node("forest").artifactId}`);
    w.trace.backend.releaseFolderReads();
  });
  expect(await page.evaluate(() => (window as any).revealResult)).toBe("AbortError");
  await page.evaluate(() => (window as any).newReveal);
  await expect(page.getByTestId("preview-title")).toHaveText("forest.png");
  expect((await state(page)).inputs).toEqual(["/pictures/forest.png"]);
  await expect(await card(page, "forest")).toBeFocused();
});

test("changing primary focus within the same host selection supersedes loading", async ({ page }) => {
  await openView(page);
  await generated(page);
  const paths = ["/pictures/warm.png", "/pictures/forest.png"];
  await page.evaluate((paths) => (window as any).trace.setSelection(paths, paths[0]), paths);
  await settle(page);
  const reads = await page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length);
  await page.evaluate(() => {
    const w = window as any;
    w.trace.backend.holdFolderReads();
    w.revealResult = w.trace.showJob(71).then(() => "completed", (error: Error) => error.name);
  });
  await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_folder_components").length)).toBeGreaterThan(reads);
  await page.evaluate((paths) => (window as any).trace.setSelection(paths, paths[1]), paths);
  const chosen = await state(page);
  await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
  expect(await page.evaluate(() => (window as any).revealResult)).toBe("AbortError");
  await settle(page);
  expect(await state(page)).toEqual(chosen);
  await expect(await tile(page, "forest")).toHaveAttribute("data-tone", "focus");
});

for (const change of ["refresh", "new reveal"] as const) {
  test(`a stale worker scene cannot settle a reveal after ${change}`, async ({ page }) => {
    await openView(page, undefined, "?revealLarge=1");
    const section = page.locator('section.component[aria-label="fan"]');
    if (await section.locator("[data-stack-toggle]").getAttribute("aria-expanded") === "true") await section.locator("[data-stack-toggle]").click();
    await settle(page);
    await generated(page, "fan", false);
    await page.evaluate(() => {
      const w = window as any;
      const original = Worker.prototype.postMessage;
      w.originalWorkerPostMessage = original;
      w.heldLayouts = [];
      Worker.prototype.postMessage = function (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        w.heldLayouts.push(() => Reflect.apply(original, this, [message, transferOrOptions]));
      };
      w.revealOutcome = "pending";
      w.revealResult = w.trace.showJob(71).then(() => w.revealOutcome = "completed", (error: Error) => w.revealOutcome = error.name);
    });
    await expect.poll(() => page.evaluate(() => (window as any).heldLayouts.length)).toBeGreaterThan(0);
    const nodeReads = await page.evaluate(() => (window as any).trace.backend.calls("trace_component_nodes").length);
    await page.evaluate((change) => {
      const w = window as any;
      w.trace.backend.startGeneration("revealed", "replacement");
      w.trace.backend.completeGeneration("replacement");
      if (change === "new reveal") {
        w.newOutcome = "pending";
        w.newReveal = w.trace.revealTarget(`artifact:${w.trace.backend.node("replacement").artifactId}`)
          .then(() => w.newOutcome = "completed", (error: Error) => w.newOutcome = error.name);
      }
    }, change);
    await expect(page.getByTestId("preview-title")).toHaveText(change === "refresh" ? "revealed.png" : "replacement.png");
    await expect.poll(() => page.evaluate(() => (window as any).trace.backend.calls("trace_component_nodes").length)).toBeGreaterThan(nodeReads);
    // Release just the stale layout; the worker then receives the newer scene.
    await page.evaluate(() => { for (const release of (window as any).heldLayouts.splice(0)) release(); });
    await expect.poll(() => page.evaluate(() => (window as any).heldLayouts.length)).toBeGreaterThan(0);
    expect(await page.evaluate((change) => {
      const w = window as any;
      return change === "refresh" ? w.revealOutcome : w.newOutcome;
    }, change)).toBe("pending");
    // Subsequent jobs may queue behind that scene; release them as they arrive.
    await page.evaluate(() => {
      const w = window as any;
      Worker.prototype.postMessage = w.originalWorkerPostMessage;
      for (const release of w.heldLayouts.splice(0)) release();
    });
    const result = await page.evaluate((change) => change === "refresh" ? (window as any).revealResult : (window as any).newReveal, change);
    expect(result).toBe("completed");
    if (change === "new reveal") expect(await page.evaluate(() => (window as any).revealResult)).toBe("AbortError");
    const name = change === "refresh" ? "revealed" : "replacement";
    await expect(await card(page, name)).toBeFocused();
    await expect(await tile(page, name)).toBeInViewport();
  });
}


test("Show image waits for an uncached worker layout to display and focus the tile", async ({ page }) => {
  await openView(page, undefined, "?revealLarge=1");
  await generated(page, "fan", false);
  const snapshot = await page.evaluate(() => (window as any).trace.backend.jobStatus(71));
  expect(snapshot.operationId).toMatch(/^[a-f0-9]{32}$/);
  await page.evaluate(() => (window as any).trace.showJob(71));
  // The operation has resolved: assert immediately, with no polling grace period.
  const visibleAtCompletion = await page.evaluate(() => {
    const w = window as any;
    const key = w.trace.backend.key("revealed");
    const button = document.querySelector<HTMLElement>(`[data-node-key="${key}"]`);
    if (!button || document.activeElement !== button) return false;
    const bounds = button.getBoundingClientRect();
    const view = document.querySelector(".trace-view")!.getBoundingClientRect();
    return bounds.top >= view.top && bounds.bottom <= view.bottom && bounds.left >= view.left && bounds.right <= view.right;
  });
  expect(visibleAtCompletion).toBe(true);
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
  const reads = await page.evaluate(() => (window as any).trace.backend.calls("jobs.status"));
  expect(reads.at(-1).params.operationId).toBe(snapshot.operationId);
});

test("collapsing the target cancels a reveal waiting for worker layout", async ({ page }) => {
  await openView(page, undefined, "?revealLarge=1");
  const section = page.locator('section.component[aria-label="fan"]');
  if (await section.locator("[data-stack-toggle]").getAttribute("aria-expanded") === "true") await section.locator("[data-stack-toggle]").click();
  await settle(page);
  await generated(page, "fan", false);
  await page.evaluate(() => {
    const w = window as any;
    const original = Worker.prototype.postMessage;
    w.heldLayouts = [];
    Worker.prototype.postMessage = function (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
      w.heldLayouts.push(() => Reflect.apply(original, this, [message, transferOrOptions]));
    };
    w.revealResult = w.trace.showJob(71).then(() => "completed", (error: Error) => error.message);
  });
  await expect.poll(() => page.evaluate(() => (window as any).heldLayouts.length)).toBeGreaterThan(0);
  // The open is pending: nothing is committed, and the disclosure cancels it.
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-label", "Cancel opening stack");
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
  await section.locator("[data-stack-toggle]").click();
  expect(await page.evaluate(() => (window as any).revealResult)).toContain("superseded");
  await page.evaluate(() => { for (const release of (window as any).heldLayouts) release(); });
  await settle(page);
  await expect(section.locator("[data-stack-toggle]")).toHaveAttribute("aria-expanded", "false");
  await expect(await tile(page, "revealed")).toHaveCount(0);
});
