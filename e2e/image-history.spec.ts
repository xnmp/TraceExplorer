import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.ROUND4_SHOTS;

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/image.html${query}`);
  await page.waitForFunction(() => !!(window as any).image);
}
const fixture = (page: Page) => page.evaluate(async () => {
  const module = await import("/image-fixture.ts" as string);
  return { reply: module.REPLY as string, panel: module.PANEL_MESSAGE as string, inputs: module.INPUTS as { path: string; digest: string }[], prompt: module.PROMPT as string };
});

test("a failed Codex edit shows Codex's reply, with the full text on expand", async ({ page }) => {
  await open(page);
  const { reply } = await fixture(page);
  const entry = page.locator('li[data-run-id="87"]');
  const explanation = entry.getByTestId("codex-explanation");
  await expect(explanation).toContainText("Codex reply:");
  await expect(explanation).toContainText("I can’t make that edit: it depicts copyrighted characters");
  // A bounded excerpt first: the end of the reply is hidden.
  await expect(explanation).not.toContainText("adjust the request in another way?");
  await expect(explanation).toContainText("…");
  if (SHOTS) await page.locator(".plugin-dialog").screenshot({ path: `${SHOTS}/history-after-collapsed.png` });
  await entry.getByRole("button", { name: "Show full reply" }).click();
  await expect(entry.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
  await expect(explanation).toContainText(reply);
  if (SHOTS) await page.locator(".plugin-dialog").screenshot({ path: `${SHOTS}/history-after-expanded.png` });
  // The full reply is also in the run's raw record.
  await entry.locator("summary").click();
  await expect(entry.locator("pre")).toContainText("\"codex_reply\"");
  // A succeeded run offers neither an explanation nor a retry.
  const succeeded = page.locator('li[data-run-id="86"]');
  await expect(succeeded.getByTestId("codex-explanation")).toHaveCount(0);
  await expect(succeeded.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).image.errors)).toEqual([]);
});

test("Retry starts a new job with the same ordered inputs, prompt and settings", async ({ page }) => {
  await open(page);
  const { inputs, prompt } = await fixture(page);
  await page.getByRole("button", { name: "Retry run #87" }).click();
  await expect(page.locator('li[data-run-id="87"]').getByRole("status")).toHaveText("Retry started as a new job");
  const started = await page.evaluate(() => (window as any).image.started());
  expect(started).toEqual([{ kind: "openai-image", apiKey: "", request: {
    sourcePath: inputs[0].path, expectedSourceDigest: inputs[0].digest,
    referencePaths: inputs.slice(1).map((input) => input.path), expectedReferenceDigests: inputs.slice(1).map((input) => input.digest),
    prompt, outputDir: "/pictures", outputFilename: "img-20260923-160059_edit_edit.png", backend: "codex", codexPath: "/opt/codex/bin/codex",
    model: "gpt-image-2", size: "2048x1536", resolution: "2k", aspectRatio: "keep", quality: "auto", background: "auto", retryOf: 87,
  } }]);
  // The host registers it as a new image job, labelled like any other edit.
  const panel = page.getByRole("region", { name: "Image generation" });
  await expect(panel).toContainText("img-20260923-160059_edit_edit.png");
  await expect(panel).toContainText(prompt);
  expect(await page.evaluate(() => (window as any).image.jobs())).toMatchObject([{ id: 500, status: "running" }]);
});

test("the Image generation panel wraps the bounded Codex reply", async ({ page }) => {
  await open(page, "?panel=new");
  const { panel } = await fixture(page);
  const status = page.getByRole("region", { name: "Image generation" }).getByRole("status");
  await expect(status).toHaveText(panel);
  expect(Array.from(panel.split("“")[1]).length).toBeLessThanOrEqual(302);
  const box = (await status.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(420);
  if (SHOTS) {
    await page.getByRole("region", { name: "Image generation" }).screenshot({ path: `${SHOTS}/panel-after.png` });
    await open(page, "?panel=old");
    await page.getByRole("region", { name: "Image generation" }).screenshot({ path: `${SHOTS}/panel-before.png` });
  }
});

test("on hosts with jobRetry, a failed job's Retry in the Image generation panel resubmits the same request as a new job", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Retry run #87" }).click();
  const panel = page.getByRole("region", { name: "Image generation" });
  const label = "img-20260923-160059_edit_edit.png";
  await expect(panel.locator("[data-job-id='500']")).toContainText(label);
  // A running job offers no Retry; a failed one does.
  await expect(panel.getByRole("button", { name: `Retry ${label}` })).toHaveCount(0);
  const { panel: message } = await fixture(page);
  await page.evaluate((error) => (window as any).image.fail(500, error), message);
  await expect(panel.locator("[data-job-id='500']").getByRole("status")).toHaveText(message);
  await panel.getByRole("button", { name: `Retry ${label}` }).click();
  // The failed entry is replaced by the new job.
  await expect(panel.locator("[data-job-id='500']")).toHaveCount(0);
  await expect(panel.locator("[data-job-id='501']")).toContainText(label);
  const started = await page.evaluate(() => (window as any).image.started());
  expect(started).toHaveLength(2);
  // Same ordered, pinned inputs, prompt and settings; it records the failed job's run.
  const { retryOf: first, ...original } = started[0].request;
  const { retryOf: second, ...again } = started[1].request;
  expect(again).toEqual(original);
  expect(first).toBe(87);
  expect(second).toBe(200);
  expect(await page.evaluate(() => (window as any).image.errors)).toEqual([]);
});
