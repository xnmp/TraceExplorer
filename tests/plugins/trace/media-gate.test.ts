import { describe, expect, it, vi } from "vitest";
import { createThumbnailCache } from "$lib/domain/thumbnail-cache";
import { createMediaGate } from "$lib/plugins/trace/view/media-gate";

const DEADLINE = 400;
type Result = { ok: true; data: string } | { ok: false; error: string };

/**
 * A gate over a real thumbnail cache that keeps no idle image (so an image is drawable only while
 * something pins it), with loads, the render barrier and the deadline timer settled by hand.
 */
function fixture() {
  const loads = new Map<string, (result: Result) => void>();
  const cache = createThumbnailCache((path) => new Promise<Result>((resolve) => loads.set(path, resolve)), () => undefined, 0);
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (run: () => void, ms: number) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
  let render: () => void = () => undefined;
  const rendered = vi.fn(() => new Promise<void>((resolve) => { render = resolve; }));
  const gate = createMediaGate({ hold: cache.hold, rendered, setTimer, deadline: DEADLINE });
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  return {
    cache, gate, timers, rendered,
    load: async (path: string, result: Result = { ok: true, data: `blob:${path}` }) => { loads.get(path)!(result); await flush(); },
    rendered_: async () => { render(); await flush(); },
    expire: async () => { for (const timer of timers.filter((candidate) => !candidate.cancelled)) { timer.cancelled = true; timer.run(); } await flush(); },
    flush,
    /** Makes `paths` drawable, then lets them go idle but cached (pinned by a view). */
    warm: async (...paths: string[]) => {
      const views = paths.map((path) => cache.subscribe(path, 1, () => undefined));
      for (const path of paths) loads.get(path)!({ ok: true, data: `blob:${path}` });
      await flush();
      return () => views.forEach((release) => release());
    },
  };
}

describe("a change that waits for the images it draws", () => {
  it("applies at once, without a microtask, when every image is drawable, and keeps them until the change rendered", async () => {
    const f = fixture();
    const unmount = await f.warm("/a.png", "/b.png");
    const apply = vi.fn(() => {
      // What the change draws is drawable in the frame it applies.
      expect(f.cache.peek("/a.png")).toBe("blob:/a.png");
      expect(f.cache.peek("/b.png")).toBe("blob:/b.png");
    });
    f.gate.request(["/a.png", "/b.png"], 1, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(f.timers, "no deadline for a ready change").toEqual([]);
    unmount();
    await f.flush();
    expect(f.cache.peek("/a.png"), "pinned until the change rendered").toBe("blob:/a.png");
    await f.rendered_();
    expect(f.cache.peek("/a.png"), "released once rendered").toBe("");
    expect(f.gate.cancel(), "nothing pending").toBe(false);
  });

  it("applies with no images at all at once", () => {
    const f = fixture();
    const apply = vi.fn();
    f.gate.request([], 1, apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("waits for images still loading, then applies once all of them are drawable", async () => {
    const f = fixture();
    const unmount = await f.warm("/a.png");
    const apply = vi.fn(() => { expect(f.cache.peek("/b.png")).toBe("blob:/b.png"); expect(f.cache.peek("/c.png")).toBe("blob:/c.png"); });
    f.gate.request(["/a.png", "/b.png", "/c.png"], 1, apply);
    unmount();
    expect(f.timers.map((timer) => timer.ms)).toEqual([DEADLINE]);
    await f.load("/b.png");
    expect(apply, "one image still loading").not.toHaveBeenCalled();
    await f.load("/c.png");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(f.cache.peek("/a.png"), "the cached image stayed pinned during the wait").toBe("blob:/a.png");
    expect(f.timers.every((timer) => timer.cancelled), "the deadline stops").toBe(true);
    await f.rendered_();
    expect(f.cache.peek("/b.png")).toBe("");
  });

  it("an image the host fails to load does not hold the change back", async () => {
    const f = fixture();
    const apply = vi.fn();
    f.gate.request(["/missing.png"], 1, apply);
    await f.load("/missing.png", { ok: false, error: "not found" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("applies at the deadline when an image is slower, once", async () => {
    const f = fixture();
    const apply = vi.fn();
    f.gate.request(["/slow.png"], 1, apply);
    await f.flush();
    expect(apply).not.toHaveBeenCalled();
    await f.expire();
    expect(apply).toHaveBeenCalledTimes(1);
    await f.load("/slow.png");
    expect(apply, "the late image does not apply it again").toHaveBeenCalledTimes(1);
    expect(f.gate.cancel(), "nothing pending after the deadline").toBe(false);
  });

  it("cancel withdraws a pending change: it never applies, its deadline stops and its images are released", async () => {
    const f = fixture();
    const apply = vi.fn();
    f.gate.request(["/slow.png"], 1, apply);
    expect(f.gate.cancel()).toBe(true);
    expect(f.gate.cancel(), "only once").toBe(false);
    expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
    await f.load("/slow.png");
    await f.expire();
    expect(apply).not.toHaveBeenCalled();
    expect(f.cache.peek("/slow.png"), "not pinned any more: the idle cache drops it").toBe("");
    expect(f.rendered).not.toHaveBeenCalled();
  });

  it("a newer request replaces a pending one", async () => {
    const f = fixture();
    const first = vi.fn(), second = vi.fn();
    f.gate.request(["/a.png"], 1, first);
    f.gate.request(["/b.png"], 1, second);
    await f.load("/a.png");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    await f.load("/b.png");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("releases its images when applying throws", async () => {
    const f = fixture();
    const unmount = await f.warm("/a.png");
    expect(() => f.gate.request(["/a.png"], 1, () => { throw new Error("boom"); })).toThrow("boom");
    unmount();
    await f.rendered_();
    expect(f.cache.peek("/a.png")).toBe("");
  });
});
