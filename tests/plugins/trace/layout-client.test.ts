import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LayoutRequest } from "$lib/domain/trace-graph/layout";

const sdk = vi.hoisted(() => ({ allow: false }));
vi.mock("../../../src/sdk", () => ({ hostAllowsBlobWorkers: () => sdk.allow }));
const created = vi.hoisted(() => ({ count: 0, last: null as null | { posted: Array<{ id: number; request: LayoutRequest }>; onmessage: ((event: { data: unknown }) => void) | null } }));
vi.mock("$lib/plugins/trace/view/layout.worker.ts?worker&inline", () => ({
  default: class {
    posted: Array<{ id: number; request: LayoutRequest }> = [];
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    constructor() { created.count++; created.last = this; }
    terminate() {}
    postMessage(message: { id: number; request: LayoutRequest }) {
      if (message.request?.items.some((item) => item.key === "unclonable")) throw new DOMException("could not clone", "DataCloneError");
      this.posted.push(message);
    }
  },
}));

const request = (n = 0, width = 800): LayoutRequest => ({
  maxWidth: width,
  items: [
    { key: `a${n}`, width: 100, height: 60, order: 0, parents: [] },
    { key: `b${n}`, width: 100, height: 60, order: 1, parents: [`a${n}`] },
  ],
});

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

describe("layout client (main-thread fallback)", () => {
  it("computes on the main thread when no Worker exists", async () => {
    sdk.allow = true;
    const client = await load();
    const layout = await client.computeLayout(request());
    expect([...layout.nodes.keys()].sort()).toEqual(["a0", "b0"]);
    expect(created.count).toBe(0);
  });

  it("does not create a worker when the host forbids blob workers", async () => {
    vi.stubGlobal("Worker", class {});
    sdk.allow = false;
    const client = await load();
    await client.computeLayout(request());
    expect(created.count).toBe(0);
  });

  it("returns the identical cached object for an identical request and exposes it via cachedLayout", async () => {
    const client = await load();
    expect(client.cachedLayout(request())).toBeNull();
    const first = await client.computeLayout(request());
    const second = await client.computeLayout(request());
    expect(second).toBe(first);
    expect(client.cachedLayout(request())).toBe(first);
    expect(client.cachedLayout(request(1))).toBeNull();
  });

  it("keeps pinned cover positions and obstacles in the cache contract", async () => {
    const client = await load();
    const at = (x: number, obstacles: readonly { x: number; width: number }[] = []): LayoutRequest => ({ ...request(), pinned: { key: "a0", x, obstacles } });
    const left = client.layoutNow(at(100));
    expect(client.cachedLayout(at(650))).toBeNull();
    const right = client.layoutNow(at(650));
    expect(left.nodes.get("a0")!.x + 50).toBe(100);
    expect(right.nodes.get("a0")!.x + 50).toBe(650);
    expect(client.cachedLayout(at(100, [{ x: 200, width: 100 }]))).toBeNull();
    expect(client.cachedLayout(at(100))).toBe(left);
  });

  it("a different width is a different cache entry", async () => {
    const client = await load();
    const narrow = await client.computeLayout(request(0, 300));
    expect(client.cachedLayout(request(0, 800))).toBeNull();
    expect(client.cachedLayout(request(0, 300))).toBe(narrow);
  });

  it("a different tile size is a different cache entry, even for items of the same size", async () => {
    const client = await load();
    const sized = { ...request(0), tileWidth: 172 };
    const large = await client.computeLayout(sized);
    expect(client.cachedLayout(request(0))).toBeNull();
    expect(client.cachedLayout({ ...request(0), tileWidth: 92 })).toBeNull();
    expect(client.cachedLayout({ ...request(0), tileWidth: 172 })).toBe(large);
    // Spacing follows the tile size, so the layouts really differ.
    expect((await client.computeLayout(request(0))).height).not.toBe(large.height);
  });

  it("reuses a left-to-right layout at any width: running right, generations never wrap", async () => {
    const client = await load();
    const sideways = (width: number): LayoutRequest => ({ ...request(0, width), orientation: "right" });
    const wide = await client.computeLayout(sideways(800));
    expect(wide.orientation).toBe("right");
    for (const width of [300, 1600, Number.NaN]) expect(client.cachedLayout(sideways(width)), String(width)).toBe(wide);
    // The same items running down are a different layout.
    expect(client.cachedLayout(request(0, 800))).toBeNull();
  });

  it("layoutNow computes synchronously and caches", async () => {
    const client = await load();
    const now = client.layoutNow(request());
    expect(client.layoutNow(request())).toBe(now);
    expect(client.cachedLayout(request())).toBe(now);
    expect(await client.computeLayout(request())).toBe(now);
  });

  it("handles an empty request", async () => {
    const client = await load();
    const layout = await client.computeLayout({ items: [], maxWidth: 500 });
    expect(layout.nodes.size).toBe(0);
  });

  it("disposeLayouts clears the cache", async () => {
    const client = await load();
    const first = await client.computeLayout(request());
    client.disposeLayouts();
    expect(client.cachedLayout(request())).toBeNull();
    const again = await client.computeLayout(request());
    expect(again).not.toBe(first);
  });

  it("bounds the cache: the 49th distinct request evicts the oldest", async () => {
    const client = await load();
    for (let i = 0; i < 49; i++) client.layoutNow(request(i));
    expect(client.cachedLayout(request(0))).toBeNull();
    expect(client.cachedLayout(request(1))).not.toBeNull();
    expect(client.cachedLayout(request(48))).not.toBeNull();
  });

  it("recently reused entries survive eviction", async () => {
    const client = await load();
    for (let i = 0; i < 48; i++) client.layoutNow(request(i));
    client.layoutNow(request(0)); // touch the oldest
    client.layoutNow(request(48));
    expect(client.cachedLayout(request(0))).not.toBeNull();
    expect(client.cachedLayout(request(1))).toBeNull();
  });
});

describe("layout client (worker)", () => {
  beforeEach(() => { sdk.allow = true; vi.stubGlobal("Worker", class {}); });

  it("gives the worker one job at a time and drops requests aborted while they wait", async () => {
    const { computeLayout } = await load();
    const { layoutGraph } = await import("$lib/domain/trace-graph/layout");
    const first = computeLayout(request(1));
    const stale = new AbortController();
    const second = computeLayout(request(2), stale.signal);
    const third = computeLayout(request(3));
    const worker = created.last!;
    expect(worker.posted.map((job) => job.request.items[0].key)).toEqual(["a1"]);
    stale.abort();
    const reply = (index: number) => {
      const job = worker.posted[index];
      worker.onmessage!({ data: { id: job.id, layout: layoutGraph(job.request) } });
    };
    reply(0);
    await expect(first).resolves.toMatchObject({ nodes: expect.any(Map) });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    // The aborted request never reached the worker; the next one did.
    expect(worker.posted.map((job) => job.request.items[0].key)).toEqual(["a1", "a3"]);
    reply(1);
    expect((await third).nodes.has("a3")).toBe(true);
  });

  it("finishes a job that was already running when it is aborted, and caches it", async () => {
    const { computeLayout, cachedLayout } = await load();
    const { layoutGraph } = await import("$lib/domain/trace-graph/layout");
    const late = new AbortController();
    const result = computeLayout(request(4), late.signal);
    const worker = created.last!;
    late.abort();
    const job = worker.posted[0];
    worker.onmessage!({ data: { id: job.id, layout: layoutGraph(job.request) } });
    await result;
    expect(cachedLayout(request(4))).not.toBeNull();
  });

  it("answers a queued request from the cache when an identical one finished meanwhile", async () => {
    const { computeLayout } = await load();
    const { layoutGraph } = await import("$lib/domain/trace-graph/layout");
    const first = computeLayout(request(5));
    const again = computeLayout(request(5));
    const worker = created.last!;
    const job = worker.posted[0];
    worker.onmessage!({ data: { id: job.id, layout: layoutGraph(job.request) } });
    await first;
    await again;
    expect(worker.posted).toHaveLength(1);
  });

  it("keeps working after a request cannot be sent to the worker", async () => {
    const { computeLayout } = await load();
    const broken = computeLayout({ maxWidth: 400, items: [{ key: "unclonable", width: 10, height: 10, order: 0, parents: [] }] });
    const next = computeLayout(request(6));
    await expect(broken).rejects.toMatchObject({ name: "DataCloneError" });
    expect(created.last!.posted.map((job) => job.request.items[0].key)).toEqual(["a6"]);
    void next;
  });

  it("settles a waiting request as soon as it is aborted", async () => {
    const { computeLayout } = await load();
    void computeLayout(request(7));
    const stale = new AbortController();
    const waiting = computeLayout(request(8), stale.signal);
    stale.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not cache a result that arrives after disposal", async () => {
    const { computeLayout, cachedLayout, disposeLayouts } = await load();
    const { layoutGraph } = await import("$lib/domain/trace-graph/layout");
    const result = computeLayout(request(9));
    const worker = created.last!;
    const job = worker.posted[0];
    worker.onmessage!({ data: { id: job.id, layout: layoutGraph(job.request) } });
    disposeLayouts();
    await result;
    expect(cachedLayout(request(9))).toBeNull();
  });
});

describe("layout client (whole folder runs)", () => {
  const folderInput = (width = 640) => ({ items: [], open: new Map(), width, tile: { width: 120, image: 96 } as never, grid: { cellWidth: 120, cellHeight: 150, gap: 8 }, previous: null });
  const folderLayout = (width: number) => ({ width }) as never;
  type Posted = { id: number; folder?: { width: number }; request?: LayoutRequest };

  it("runs the fallback engine on the main thread when no worker exists", async () => {
    sdk.allow = true;
    const { computeFolderLayout } = await load();
    const engine = vi.fn((input: { width: number }) => folderLayout(input.width));
    await expect(computeFolderLayout(folderInput(), engine as never)).resolves.toEqual({ width: 640 });
    expect(engine).toHaveBeenCalledTimes(1);
    expect(created.count).toBe(0);
  });

  describe("with a worker", () => {
    beforeEach(() => { sdk.allow = true; vi.stubGlobal("Worker", class {}); });

    it("sends the whole input as one folder message and resolves with its reply", async () => {
      const { computeFolderLayout, layoutsPending } = await load();
      const engine = vi.fn();
      const result = computeFolderLayout(folderInput(700), engine as never);
      const worker = created.last!, job = worker.posted[0] as unknown as Posted;
      expect(job.folder).toMatchObject({ width: 700 });
      expect(job.request).toBeUndefined();
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

describe("layout client (requests)", () => {
  it("skips a main-thread request aborted before its frame", async () => {
    const { computeLayout, cachedLayout } = await load();
    const stale = new AbortController();
    const result = computeLayout(request(10), stale.signal);
    stale.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cachedLayout(request(10))).toBeNull();
  });

  it("treats widths the engine rounds alike as one cache entry, and others as distinct", async () => {
    const { layoutSignature } = await load();
    expect(layoutSignature(request(0, 811.2))).toBe(layoutSignature(request(0, 811.9)));
    expect(layoutSignature(request(0, 811.6))).not.toBe(layoutSignature(request(0, 812.4)));
  });
});


describe("band history scheduling and caching", () => {
  it("keys exact band widths and both committed embeddings, independently of selection styles", async () => {
    const { layoutSignature, layoutNow, cachedLayout, canLayoutInline } = await load();
    const { bandHistorySignature } = await import("$lib/domain/trace-graph/band-layout");
    const { attachSingleBand } = await import("$lib/domain/trace-graph/band-geometry");
    const base = { ...request(), maxWidth: 454.1, pinned: { key: "a0", x: 300 }, band: { key: "a0", items: request().items } };
    const layout = layoutNow(base), placed = attachSingleBand(layout, base);
    const next = { ...base, anchorKey: "b0", history: { signature: bandHistorySignature(base), layout, placed } };
    expect(layoutSignature(next)).not.toBe(layoutSignature({ ...next, maxWidth: 454.9 }));
    expect(layoutSignature({ ...next, maxWidth: 100001 })).not.toBe(layoutSignature({ ...next, maxWidth: 100002 }));
    expect(layoutSignature({ ...next, maxWidth: 0 })).not.toBe(layoutSignature({ ...next, maxWidth: -1 }));
    const translated = { ...placed, nodes: new Map([...placed.nodes].map(([id, n]) => [id, { ...n, x: n.x + 1 }])) };
    expect(layoutSignature(next)).not.toBe(layoutSignature({ ...next, history: { ...next.history, placed: translated } }));
    layoutNow(next);
    expect(cachedLayout({ ...next, history: { ...next.history, placed: translated } })).toBeNull();
    expect(canLayoutInline({ ...base, band: { key: "a0", items: Array.from({ length: 200 }, (_, i) => ({ ...base.items[0], key: `hidden${i}` })) } })).toBe(true);
    expect(canLayoutInline({ ...base, items: Array.from({ length: 31 }, (_, i) => ({ ...base.items[0], key: `visible${i}` })) })).toBe(false);
    expect(canLayoutInline({ ...base, items: base.items.map(n => ({ ...n, parents: Array(30).fill("a0") })) })).toBe(false);
    const largeHistory = { ...layout, nodes: new Map(Array.from({ length: 29 }, (_, i) => [`old${i}`, { ...layout.nodes.get("a0")!, key: `old${i}` }])) };
    expect(canLayoutInline({ ...next, history: { ...next.history, layout: largeHistory } })).toBe(false);
    const denseHistory = { ...layout, routes: Array(40).fill(layout.routes[0]) };
    expect(canLayoutInline({ ...next, history: { ...next.history, layout: denseHistory } })).toBe(false);
  });
  it("sends committed history through the worker with Maps intact and returns the same domain outcome", async () => {
    sdk.allow = true; vi.stubGlobal("Worker", class {});
    const { computeLayout } = await load();
    const { layoutGraph } = await import("$lib/domain/trace-graph/layout");
    const { bandHistorySignature } = await import("$lib/domain/trace-graph/band-layout");
    const { attachSingleBand } = await import("$lib/domain/trace-graph/band-geometry");
    const base = { ...request(), pinned: { key: "a0", x: 300 }, band: { key: "a0", items: request().items } };
    const layout = layoutGraph(base), placed = attachSingleBand(layout, base);
    const next = { ...base, anchorKey: "b0", history: { signature: bandHistorySignature(base), layout, placed } };
    const pending = computeLayout(next), worker = created.last!, job = structuredClone(worker.posted[0]);
    expect(job.request.history!.placed.nodes).toBeInstanceOf(Map);
    const result = layoutGraph(job.request);
    worker.onmessage!({ data: { id: job.id, layout: result } });
    expect(await pending).toEqual(layoutGraph(next));
  });
});
