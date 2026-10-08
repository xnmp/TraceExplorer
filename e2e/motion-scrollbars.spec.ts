import { test, expect } from "@playwright/test";
import { clickThroughGym } from "./motion-support";

// Real scrollbars, styled as the host does (classic bars that take layout space).
// Headless Chromium hides them by default, so this file runs in a browser of its own.
test.use({
  viewport: { width: 1100, height: 900 },
  launchOptions: { ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), ignoreDefaultArgs: ["--hide-scrollbars"] },
});

test("a scrollbar appearing while a graph grows moves no tile that keeps its place", async ({ page }) => {
  // Narrow enough that the gym runs top to bottom, so revealing generations makes it taller.
  const { scrolled } = await clickThroughGym(page, "", 380);
  // Some click made the view scroll, with a scrollbar that takes space.
  expect(scrolled).toBe(true);
});
