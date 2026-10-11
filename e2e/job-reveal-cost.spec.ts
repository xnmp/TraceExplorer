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
  const section = page.locator("section.component").filter({ has: page.locator(".heading .name", { hasText: /^village$/ }) });
  await expect(section.locator(".heading")).toHaveAttribute("aria-expanded", "true");
  await section.locator(".heading").click();
  await settle(page);
  await page.evaluate(() => (window as any).trace.showJob(71));
  await expect(section.locator(".heading")).toHaveAttribute("aria-expanded", "true");
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

test("Show image loads an offscreen component and omits cost when unavailable", async ({ page }) => {
  await openView(page, undefined, "?many=25");
  await generated(page, "m24", false);
  await expect(await tile(page, "revealed")).toHaveCount(0);
  await page.evaluate(() => (window as any).trace.showJob(71));
  await expect(page.getByTestId("preview-title")).toHaveText("revealed.png");
  await expect(await tile(page, "revealed")).toHaveAttribute("data-tone", "focus");
  await expect(await card(page, "revealed")).toBeFocused();
  await expect(await tile(page, "revealed")).toBeInViewport();
  await page.getByRole("button", { name: "Trace details", exact: true }).click();
  await expect(page.getByText("Cost", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
});

test("aborting during loading preserves the existing focus and expansion", async ({ page }) => {
  await openView(page);
  await generated(page);
  await click(page, "warm");
  const before = await state(page);
  const expanded = await page.locator(".heading[aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")));
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
  expect(await page.locator(".heading[aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")))).toEqual(expanded);
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
    const section = page.locator("section.component").filter({ has: page.locator(".heading .name", { hasText: /^village$/ }) });
    await section.locator(".heading").click();
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
    const expansion = await page.locator(".heading[aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")));
    expect(chosen.inputs.length).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).trace.backend.releaseFolderReads());
    expect(await page.evaluate(() => (window as any).revealResult)).toBe("AbortError");
    await settle(page);
    expect(await state(page)).toEqual(chosen);
    expect(await page.locator(".heading[aria-expanded]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-expanded")))).toEqual(expansion);
    await expect(section.locator(".heading")).toHaveAttribute("aria-expanded", "false");
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
    const section = page.locator("section.component").filter({ has: page.locator(".heading .name", { hasText: /^fan$/ }) });
    if (await section.locator(".heading").getAttribute("aria-expanded") === "true") await section.locator(".heading").click();
    await settle(page);
    await generated(page, "fan", false);
    await page.evaluate(() => {
      const w = window as any;
      const original = Worker.prototype.postMessage;
      w.originalWorkerPostMessage = original;
      w.heldLayouts = [];
      Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
        w.heldLayouts.push(() => original.apply(this, args));
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
  const section = page.locator("section.component").filter({ has: page.locator(".heading .name", { hasText: /^fan$/ }) });
  if (await section.locator(".heading").getAttribute("aria-expanded") === "true") await section.locator(".heading").click();
  await settle(page);
  await generated(page, "fan", false);
  await page.evaluate(() => {
    const w = window as any;
    const original = Worker.prototype.postMessage;
    w.heldLayouts = [];
    Worker.prototype.postMessage = function (...args: Parameters<Worker["postMessage"]>) {
      w.heldLayouts.push(() => original.apply(this, args));
    };
    w.revealResult = w.trace.showJob(71).then(() => "completed", (error: Error) => error.message);
  });
  await expect.poll(() => page.evaluate(() => (window as any).heldLayouts.length)).toBeGreaterThan(0);
  await expect(section.locator(".heading")).toHaveAttribute("aria-expanded", "true");
  await section.locator(".heading").click();
  expect(await page.evaluate(() => (window as any).revealResult)).toContain("superseded");
  await page.evaluate(() => { for (const release of (window as any).heldLayouts) release(); });
  await settle(page);
  await expect(section.locator(".heading")).toHaveAttribute("aria-expanded", "false");
  await expect(await tile(page, "revealed")).toHaveCount(0);
});
