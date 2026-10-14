import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sdk = vi.hoisted(() => ({ allow: false }));
vi.mock("../../../src/sdk", () => ({ hostAllowsBlobWorkers: () => sdk.allow }));
const created = vi.hoisted(() => ({ count: 0, last: null as null | { posted: Array<{ id: number; folder: unknown }>; onmessage: ((event: { data: unknown }) => void) | null; terminated: boolean } }));
vi.mock("$lib/plugins/trace/view/layout.worker.ts?worker&inline", () => ({
  default: class {
    posted: Array<{ id: number; folder: unknown }> = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    terminated = false;
    constructor() { created.count++; created.last = this; }
    terminate() { this.terminated = true; }
    postMessage(message: { id: number; folder: { width: number } }) {
      if (message.folder.width === 13) throw new DOMException("could not clone", "DataCloneError");
      this.posted.push(message);
    }
  },
}));

async function load() {
  vi.resetModules();
  return import("$lib/plugins/trace/view/layout-client");
}

beforeEach(() => {
  created.count = 0;
  sdk.allow = false;
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { queueMicrotask(cb); return 0; });
});
afterEach(() => vi.unstubAllGlobals());

describe("layout client (whole folder runs)", () => {
  const folderInput = (width = 640) => ({ items: [], open: new Map(), width, tile: { width: 120, image: 96 } as never, grid: { cellWidth: 120, cellHeight: 150, gap: 8 }, previous: null });
  const folderLayout = (width: number) => ({ width }) as never;
  type Posted = { id: number; folder?: { width: number } };

  it("runs the fallback engine on the main thread when no worker exists", async () => {
    sdk.allow = true;
    const { computeFolderLayout } = await load();
    const engine = vi.fn((input: { width: number }) => folderLayout(input.width));
    await expect(computeFolderLayout(folderInput(), engine as never)).resolves.toEqual({ width: 640 });
    expect(engine).toHaveBeenCalledTimes(1);
    expect(created.count).toBe(0);
  });

  it("does not create a worker when the host forbids blob workers", async () => {
    vi.stubGlobal("Worker", class {});
    sdk.allow = false;
    const { computeFolderLayout } = await load();
    await computeFolderLayout(folderInput(), vi.fn((input: { width: number }) => folderLayout(input.width)) as never);
    expect(created.count).toBe(0);
  });

  it("skips a main-thread run aborted before its frame", async () => {
    const { computeFolderLayout } = await load();
    const engine = vi.fn(), stale = new AbortController();
    const result = computeFolderLayout(folderInput(), engine as never, stale.signal);
    stale.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(engine).not.toHaveBeenCalled();
  });

  describe("with a worker", () => {
    beforeEach(() => { sdk.allow = true; vi.stubGlobal("Worker", class {}); });

    it("gives the worker one job at a time and drops one aborted while it waits", async () => {
      const { computeFolderLayout } = await load();
      const first = computeFolderLayout(folderInput(100), vi.fn() as never);
      const stale = new AbortController();
      const second = computeFolderLayout(folderInput(200), vi.fn() as never, stale.signal);
      const third = computeFolderLayout(folderInput(300), vi.fn() as never);
      const worker = created.last!;
      const widths = () => worker.posted.map((job) => (job as unknown as Posted).folder!.width);
      expect(widths()).toEqual([100]);
      stale.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      worker.onmessage!({ data: { id: worker.posted[0].id, folder: folderLayout(100) } });
      await expect(first).resolves.toEqual({ width: 100 });
      expect(widths()).toEqual([100, 300]);
      worker.onmessage!({ data: { id: worker.posted[1].id, folder: folderLayout(300) } });
      await expect(third).resolves.toEqual({ width: 300 });
    });

    it("keeps working after an input cannot be sent to the worker", async () => {
      const { computeFolderLayout } = await load();
      const broken = computeFolderLayout(folderInput(13), vi.fn() as never);
      const next = computeFolderLayout(folderInput(14), vi.fn() as never);
      await expect(broken).rejects.toMatchObject({ name: "DataCloneError" });
      expect(created.last!.posted.map((job) => (job as unknown as Posted).folder!.width)).toEqual([14]);
      void next;
    });

    it("completes queued runs on the main thread, one per frame, when the worker fails to load", async () => {
      const frames: (() => void)[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => { frames.push(cb); return frames.length; });
      const { computeFolderLayout } = await load();
      const engine = vi.fn((input: { width: number }) => folderLayout(input.width));
      const first = computeFolderLayout(folderInput(100), engine as never);
      const second = computeFolderLayout(folderInput(200), engine as never);
      const worker = created.last! as unknown as { onerror: (event: { preventDefault(): void }) => void };
      worker.onerror({ preventDefault() {} });
      expect(engine).not.toHaveBeenCalled();
      frames.shift()!();
      expect(engine).toHaveBeenCalledTimes(1);
      frames.shift()!();
      await expect(first).resolves.toEqual({ width: 100 });
      await expect(second).resolves.toEqual({ width: 200 });
    });

    it("sends the whole input as one folder message and resolves with its reply", async () => {
      const { computeFolderLayout, layoutsPending } = await load();
      const engine = vi.fn();
      const result = computeFolderLayout(folderInput(700), engine as never);
      const worker = created.last!, job = worker.posted[0] as unknown as Posted;
      expect(job.folder).toMatchObject({ width: 700 });
      expect(layoutsPending()).toBe(1);
      worker.onmessage!({ data: { id: job.id, folder: folderLayout(700) } });
      await expect(result).resolves.toEqual({ width: 700 });
      expect(engine).not.toHaveBeenCalled();
      expect(layoutsPending()).toBe(0);
    });

    it("rejects at once when aborted while running, drops the late reply, and serves the next job", async () => {
      const { computeFolderLayout, layoutsPending } = await load();
      const stale = new AbortController();
      const first = computeFolderLayout(folderInput(500), vi.fn() as never, stale.signal);
      const second = computeFolderLayout(folderInput(600), vi.fn() as never);
      const worker = created.last!;
      const running = worker.posted[0] as unknown as Posted;
      stale.abort();
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      worker.onmessage!({ data: { id: running.id, folder: folderLayout(500) } });
      await Promise.resolve();
      const next = worker.posted.at(-1) as unknown as Posted;
      expect(next.folder).toMatchObject({ width: 600 });
      worker.onmessage!({ data: { id: next.id, folder: folderLayout(600) } });
      await expect(second).resolves.toEqual({ width: 600 });
      expect(layoutsPending()).toBe(0);
    });

    it("rejects an input already aborted without posting it", async () => {
      const { computeFolderLayout } = await load();
      created.last = null;
      const stale = new AbortController();
      stale.abort();
      await expect(computeFolderLayout(folderInput(), vi.fn() as never, stale.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(created.last?.posted ?? []).toHaveLength(0);
    });
  });

  it("holdLayoutWork counts as pending until released, once", async () => {
    const { holdLayoutWork, layoutsPending } = await load();
    const release = holdLayoutWork();
    expect(layoutsPending()).toBe(1);
    release(); release();
    expect(layoutsPending()).toBe(0);
  });
});
