import { expect, test } from "@playwright/test";
import { click, openView } from "./support";

for (const theme of ["light", "dark"]) {
  test(`the AI dialog covers the underlying pane from its first frame (${theme})`, async ({ page }) => {
    await openView(page, 1400, `?ai=1&theme=${theme}`);
    await click(page, "warm");
    const compositedEntrances = await page.evaluate(async () => {
      // A vivid pane beneath the modal makes opening transparency observable in captured pixels.
      const pane = document.createElement("div");
      pane.style.cssText = "position:fixed;inset:0;z-index:999;background:rgb(255,0,255)";
      document.body.append(pane);
      await (window as any).trace.command("plugin.openai-image.edit");
      await new Promise(requestAnimationFrame);
      const composited: string[] = [];
      for (const animation of document.getAnimations()) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (target instanceof Element && (target.matches(".dialog-overlay") || target.matches(".plugin-dialog"))) {
          const frames = (animation.effect as KeyframeEffect).getKeyframes();
          if (frames.some((frame) => ["opacity", "transform", "translate", "scale", "rotate", "filter", "backdropFilter"].some((property) => property in frame))) composited.push(target.className);
          animation.pause();
          animation.currentTime = 0;
        }
      }
      return composited;
    });
    // Chromium cannot reproduce WebKitGTK's layer teardown glitch. Pin the entrance
    // contract that avoids it as well as the user-visible opening pixels below.
    expect(compositedEntrances).toEqual([]);

    const dialog = page.getByRole("dialog", { name: "Edit with AI" });
    await expect(dialog.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused();
    const pixels: Buffer[] = [];
    for (const time of [0, 75, 150]) {
      await page.evaluate((time) => {
        for (const animation of document.getAnimations()) {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          if (target instanceof Element && (target.matches(".dialog-overlay") || target.matches(".plugin-dialog"))) animation.currentTime = time;
        }
      }, time);
      const box = (await dialog.locator(".dialog-header").boundingBox())!;
      // An empty header patch avoids asynchronous form contents and text antialiasing.
      pixels.push(await page.screenshot({ animations: "allow", clip: { x: Math.round(box.x + box.width - 80), y: Math.round(box.y + 20), width: 4, height: 4 } }));
    }
    expect(pixels[0].equals(pixels[2]), "The first frame must cover the pane as fully as the settled dialog").toBe(true);
    expect(pixels[1].equals(pixels[2]), "The pane must stay covered during opening").toBe(true);
    await expect(dialog).toHaveCSS("backdrop-filter", "blur(4px)");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).trace.errors)).toEqual([]);
  });
}
