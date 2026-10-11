import "./svelte-host";
import { afterEach, expect, it } from "vitest";
import { tracePanes, type TracePaneView } from "../../../src/lib/plugins/trace/view/pane-registry.svelte";
const view: TracePaneView = { directory: "/f", active: true, node: () => null, nodeForPath: () => null,
  focus: () => {}, reveal: async () => {}, inputs: () => [], hasUnusableTarget: () => false };
afterEach(() => tracePanes.clear());
it("waits for the target pane to mount and ignores other panes", async () => {
  const task = tracePanes.waitFor("target", "/f", new AbortController().signal);
  tracePanes.set("other", view);
  tracePanes.set("target", view);
  expect(await task).toBe(view);
});
it("cancels before the view mounts", async () => {
  const controller = new AbortController();
  const task = tracePanes.waitFor("target", "/f", controller.signal);
  controller.abort();
  await expect(task).rejects.toMatchObject({ name: "AbortError" });
  tracePanes.set("target", view);
});
it("rejects waiting reveals when the plugin is disabled", async () => {
  const task = tracePanes.waitFor("target", "/f", new AbortController().signal);
  tracePanes.clear();
  await expect(task).rejects.toThrow("Trace view is no longer available");
});
