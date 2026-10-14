import "./svelte-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneController, type SceneCause, type SceneController } from "$lib/plugins/trace/view/scene-controller.svelte";
import { installSceneInstrumentation } from "$lib/plugins/trace/view/scene-instrumentation";
import type { ComponentLease } from "$lib/plugins/trace/view/folder-session.svelte";
import type { SceneIntent } from "$lib/plugins/trace/view/scene-inputs";
import type { Publication } from "$lib/plugins/trace/view/presentation";
import { engines, type FolderLayout, type FolderLayoutInput } from "$lib/domain/trace-graph/folder-layout";
import { fallbackGridMetrics } from "$lib/domain/trace-graph/folder-grid";
import { tileMetrics } from "$lib/domain/trace-graph/metrics";
import { projectDag } from "$lib/domain/trace-graph/projection";
import type { ComponentData, FolderIndex } from "$lib/domain/trace-graph/folder-data";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { FileEntry } from "$lib/domain/file";

// ── Fixture: two stacks (a: a1→a2→a3, b: b1→b2) and a plain file ─────────────
const node = (key: string, order: number, parents: string[] = []): TraceNode => ({
  key, artifactId: order, runId: null, parents, path: `/f/${key}.png`, scope: "current", location: `./${key}.png`,
  state: "present", temporary: false, discarded: false, earlierRevision: false, order, prompt: "",
});
const STACKS: Record<string, TraceNode[]> = {
  ca: [node("a1", 1), node("a2", 2, ["a1"]), node("a3", 3, ["a2"])],
  cb: [node("b1", 4), node("b2", 5, ["b1"])],
};
const COVERS: Record<string, string> = { ca: "a1", cb: "b1" };
const entry = (name: string): FileEntry => ({ name, path: `/f/${name}`, kind: "file", size: 1, modified: "2026-10-01" });
const LISTING = [entry("a1.png"), entry("b1.png"), entry("notes.txt")];

function indexFor(token: string, ids = Object.keys(STACKS)): FolderIndex {
  return {
    directory: "/f", token,
    components: ids.map((id) => ({ id, title: id, cover: { path: `/f/${COVERS[id]}.png`, present: true }, coverKey: COVERS[id], imageCount: STACKS[id].length, nodeCount: STACKS[id].length, active: false, unsaved: false })),
    members: new Map(ids.flatMap((id) => STACKS[id].map((n) => [n.path!, { componentId: id, key: n.key }] as const))),
  };
}
let versions = 0;
const componentData = (id: string, token: string): ComponentData =>
  ({ directory: "/f", token, version: ++versions, nodes: STACKS[id], dag: projectDag(STACKS[id]), members: STACKS[id].map((n) => n.key) });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** A folder session stand-in: complete component reads are held until the test delivers them. */
function fakeSource(token = "t1") {
  const reads: { id: string; token: string; released: boolean; reply: ReturnType<typeof deferred<ReadonlyMap<string, ComponentData>>> }[] = [];
  const source = {
    index: indexFor(token) as FolderIndex | null,
    components: new Map<string, ComponentData>() as ReadonlyMap<string, ComponentData>,
    isStale: (_id: string) => false,
    acquireComponents(ids: readonly string[], readToken: string): ComponentLease {
      const reply = deferred<ReadonlyMap<string, ComponentData>>();
      const read = { id: ids[0], token: readToken, released: false, reply };
      reads.push(read);
      return { results: reply.promise, release: () => { read.released = true; reply.reject(new DOMException("released", "AbortError")); } };
    },
  };
  /** Completes the newest unreleased read of `id`: the session stores the data, then the lease resolves. */
  const deliver = (id: string) => {
    const read = [...reads].reverse().find((candidate) => candidate.id === id && !candidate.released);
    if (!read) throw new Error(`no pending read of ${id}`);
    const data = componentData(id, read.token);
    source.components = new Map(source.components).set(id, data);
    read.reply.resolve(new Map([[id, data]]));
  };
  const fail = (id: string, error: Error) => reads.filter((read) => read.id === id && !read.released).at(-1)!.reply.reject(error);
  return { source, reads, deliver, fail, pending: (id: string) => reads.filter((read) => read.id === id && !read.released) };
}

const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const tile = tileMetrics(96);

function harness(options: { inline?: (input: FolderLayoutInput) => boolean; token?: string } = {}) {
  const fake = fakeSource(options.token);
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const layouts: { input: FolderLayoutInput; signal: AbortSignal; reply: ReturnType<typeof deferred<FolderLayout>> }[] = [];
  const engine = vi.fn(engines.default);
  const published: Publication[] = [];
  const failures: string[] = [];
  const work = { held: 0 };
  let controller!: SceneController;
  const restore = installSceneInstrumentation({
    geometryPublication: () => published.push(controller.published!),
    failure: (event) => failures.push(event.message),
  });
  controller = createSceneController({
    paneId: "p", data: fake.source, engine, inline: options.inline ?? (() => true),
    runLayout: (input, signal) => { const reply = deferred<FolderLayout>(); layouts.push({ input, signal, reply }); return reply.promise; },
    tick: () => Promise.resolve(),
    setTimer: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
    holdWork: () => { work.held++; let held = true; return () => { if (held) { held = false; work.held--; } }; },
  });
  let intent: SceneIntent = {
    directory: "/f", listing: LISTING, claimed: new Set(), open: new Set(), focus: null, selectedKeys: new Set(), selectedPaths: new Set(),
    badgeHover: null, width: 900, tile, grid: fallbackGridMetrics(tile), cover: { imagePx: null, small: false }, hostChoice: "[]",
  };
  /** The view's intake: the current intent and the session's data revision. */
  const offer = (change: Partial<SceneIntent> = {}) => {
    intent = { ...intent, ...change };
    controller.offer(intent, { index: fake.source.index, components: fake.source.components });
  };
  /** Delivers a read and lets the view's intake see the new session data. */
  const deliver = (id: string) => { fake.deliver(id); offer(); };
  const act = <T>(cause: SceneCause["kind"], op: () => T) => controller.action({ kind: cause, target: null, anchor: "none" }, op);
  const openGraphs = () => [...(controller.published?.scene.graphs.keys() ?? [])].sort();
  const fire = (ms: number) => { for (const timer of timers.filter((candidate) => candidate.ms === ms && !candidate.cancelled)) { timer.cancelled = true; timer.run(); } };
  return { controller, fake, engine, layouts, published, failures, timers, work, offer, deliver, act, openGraphs, fire, restore, get intent() { return intent; } };
}

let active: ReturnType<typeof harness> | null = null;
const setup = (options?: Parameters<typeof harness>[0]) => (active = harness(options));
afterEach(() => { active?.controller.dispose(); active?.restore(); active = null; });
beforeEach(() => { versions = 0; });

/** Every published open graph has complete data for every member: nothing partial. */
function expectComplete(publication: Publication) {
  for (const [id, graph] of publication.scene.graphs) {
    const stack = publication.scene.inputs.layoutInput.open.get(id)!;
    expect(stack.members.length, `members of ${id}`).toBe(Object.values(STACKS).find((nodes) => nodes[0].key === id)!.length);
    expect(graph.attached.nodes.size).toBeGreaterThan(0);
  }
}

describe("scene controller", () => {
  it("publishes the first complete scene once, with every grid item", async () => {
    const h = setup();
    h.offer();
    await flush();
    expect(h.published).toHaveLength(1);
    expect(h.controller.published!.scene.cells.map((cell) => cell.id)).toEqual(["a1", "b1", "/f/notes.txt"]);
    expect(h.openGraphs()).toEqual([]);
  });

  it("publishes nothing before the pane is measured or the index is known", async () => {
    const h = setup();
    h.offer({ width: 0 });
    await flush();
    h.fake.source.index = null;
    h.offer({ width: 900 });
    await flush();
    expect(h.controller.published).toBeNull();
    expect(h.published).toHaveLength(0);
  });

  it("keeps the committed scene through a cold open and commits the complete band once", async () => {
    const h = setup();
    h.offer(); await flush();
    const before = h.controller.published;
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    expect(h.controller.published).toBe(before);
    expect(h.fake.pending("ca")).toHaveLength(1);
    expect(h.controller.notices.get("a1")?.phase).toBe("loading");
    h.deliver("ca");
    await flush();
    expect(h.published).toHaveLength(2);
    expect(h.openGraphs()).toEqual(["a1"]);
    expectComplete(h.controller.published!);
    expect(h.controller.notices.size).toBe(0);
  });

  it("coalesces two cold opens in one action: no scene with only the first band", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) }));
    await flush();
    h.deliver("ca");
    await flush();
    expect(h.published).toHaveLength(1);
    h.deliver("cb");
    await flush();
    expect(h.published).toHaveLength(2);
    expect(h.openGraphs()).toEqual(["a1", "b1"]);
    for (const publication of h.published) expectComplete(publication);
  });

  it("publishes only the newer action when the superseded one's data arrives last", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    h.act("expand", () => h.offer({ open: new Set(["b1"]) }));
    await flush();
    expect(h.fake.pending("ca")).toHaveLength(0); // A's lease was released
    h.deliver("cb");
    await flush();
    expect(h.openGraphs()).toEqual(["b1"]);
    // A's late read publishes nothing.
    const read = h.fake.reads.find((candidate) => candidate.id === "ca")!;
    read.reply.resolve(new Map([["ca", componentData("ca", "t1")]]));
    await flush();
    expect(h.published).toHaveLength(2);
    expect(h.openGraphs()).toEqual(["b1"]);
  });

  it("closing a pending open cancels it: notice cleared, lease released, nothing published", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    h.act("collapse", () => h.offer({ open: new Set() }));
    expect(h.controller.notices.size).toBe(0);
    await flush();
    expect(h.fake.pending("ca")).toHaveLength(0);
    expect(h.published).toHaveLength(1);
    expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  });

  it("times a cold open out into an in-cover failure; late data never opens it; Retry does", async () => {
    const h = setup();
    h.offer(); await flush();
    let shown!: Promise<void>;
    h.act("expand", () => {
      h.offer({ open: new Set(["a1"]), focus: { key: "a2", componentId: "ca" } });
      return undefined;
    });
    const id = h.controller.transaction!.id;
    shown = h.controller.whenPresented(id, "a2");
    const outcome = shown.then(() => "shown", (error: Error) => error.message);
    await flush();
    h.fire(5000);
    await flush();
    expect(h.controller.notices.get("a1")).toMatchObject({ phase: "failed", message: expect.stringMatching(/too long/) });
    expect(h.failures.some((text) => /too long/.test(text))).toBe(true);
    expect(await outcome).toMatch(/too long/);
    expect(h.controller.failure).toBeNull(); // a cover failure, not a view failure
    // The held read completes late: still closed.
    const late = h.fake.reads.find((read) => read.id === "ca")!;
    late.reply.resolve(new Map([["ca", componentData("ca", "t1")]]));
    h.offer();
    await flush();
    expect(h.openGraphs()).toEqual([]);
    expect(h.published).toHaveLength(1);
    // Retry by the stable cover key reads again and opens.
    h.act("retry", () => { h.controller.clearFailure("a1"); h.offer(); });
    await flush();
    expect(h.controller.notices.get("a1")?.phase).toBe("loading");
    h.fake.source.components = new Map(); // what the late read stored is not what Retry waits for
    h.deliver("ca");
    await flush();
    expect(h.openGraphs()).toEqual(["a1"]);
  });

  it("reports a failed read of a cold stack on its cover, not as a view failure", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    h.fake.fail("ca", new Error("disk on fire"));
    await flush();
    expect(h.controller.notices.get("a1")).toMatchObject({ phase: "failed", message: "disk on fire" });
    expect(h.controller.failure).toBeNull();
    expect(h.published).toHaveLength(1);
  });

  it("a styling-only change restyles without laying out or publishing geometry", async () => {
    const h = setup();
    h.offer({ open: new Set(["a1"]) });
    await flush();
    h.deliver("ca"); await flush();
    const calls = h.engine.mock.calls.length, version = h.controller.published!.geometryVersion;
    h.act("selection", () => h.offer({ selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "[\"/f/notes.txt\"]" }));
    await flush();
    expect(h.engine.mock.calls.length).toBe(calls);
    expect(h.controller.published!.geometryVersion).toBe(version);
    expect(h.controller.published!.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
    expect(h.published).toHaveLength(1); // the startup with its open stack; the restyle is not a geometry publication
  });

  it("sends a large layout to the worker once, holds the scene until it replies, and drops a superseded reply", async () => {
    const h = setup({ inline: (input) => input.open.size === 0 });
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    h.deliver("ca"); await flush();
    expect(h.layouts).toHaveLength(1);
    expect(h.layouts[0].input.open.has("a1")).toBe(true);
    expect(h.controller.notices.get("a1")?.phase).toBe("arranging");
    expect(h.published).toHaveLength(1);
    // A newer action supersedes the run: its signal aborts and its late reply publishes nothing.
    h.act("collapse", () => h.offer({ open: new Set() }));
    await flush();
    expect(h.layouts[0].signal.aborted).toBe(true);
    h.layouts[0].reply.resolve(engines.default(h.layouts[0].input));
    await flush();
    expect(h.openGraphs()).toEqual([]);
    expect(h.published).toHaveLength(1);
    // Reopening asks once and commits the reply.
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    expect(h.layouts).toHaveLength(2);
    h.layouts[1].reply.resolve(engines.default(h.layouts[1].input));
    await flush();
    expect(h.openGraphs()).toEqual(["a1"]);
  });

  it("lays out from committed history only", async () => {
    const h = setup({ inline: (input) => input.open.size < 2 });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    const committed = h.controller.published!.scene.layout;
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) }));
    await flush();
    h.deliver("cb"); await flush();
    expect(h.layouts.at(-1)!.input.previous).toBe(committed);
    h.act("collapse", () => h.offer({ open: new Set(["b1"]) }));
    await flush();
    // The superseded worker layout was never committed, so it is never history.
    expect(h.engine.mock.calls.at(-1)![0].previous).toBe(committed);
  });

  it("lets a selection commit on the committed snapshot while a refresh is reading", async () => {
    const h = setup();
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    // A refresh: a new index whose open stack must be read again.
    h.fake.source.index = indexFor("t2");
    h.offer();
    await flush();
    expect(h.fake.pending("ca").some((read) => read.token === "t2")).toBe(true);
    const before = h.published.length;
    h.act("selection", () => h.offer({ focus: { key: "a3", componentId: "ca" }, selectedKeys: new Set(["a3"]), hostChoice: "[\"/f/a3.png\"]" }));
    await flush();
    expect(h.published.length).toBe(before + 1);
    expect(h.controller.committedIndex!.token).toBe("t1"); // never an old graph with the new index
    h.deliver("ca"); await flush();
    expect(h.controller.committedIndex!.token).toBe("t2");
    expect(h.openGraphs()).toEqual(["a1"]);
    expect(h.controller.published!.scene.inputs.styling.focus).toBe("a3");
  });

  it("resolves whenPresented for a shown key and rejects it when superseded", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    const first = h.controller.whenPresented(h.controller.transaction!.id, "a2");
    await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) }));
    const second = h.controller.whenPresented(h.controller.transaction!.id, "b2");
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    h.deliver("ca"); h.deliver("cb");
    await flush();
    await expect(second).resolves.toBeUndefined();
  });

  it("forgets everything of the previous folder", async () => {
    const h = setup();
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.offer({ directory: "/elsewhere" });
    expect(h.controller.published).toBeNull();
    expect(h.controller.notices.size).toBe(0);
    expect(h.fake.pending("ca")).toHaveLength(0);
  });
});

describe("scene controller: failures never block the folder", () => {
  const cellIds = (h: ReturnType<typeof harness>) => h.controller.published!.scene.cells.map((cell) => cell.id);
  const liveTimers = (h: ReturnType<typeof harness>) => h.timers.filter((timer) => !timer.cancelled);
  /** Opens a1 and commits it, then publishes a new index whose open stack must be read again. */
  async function refreshWithOpenStack(h: ReturnType<typeof harness>, change: Partial<SceneIntent> = {}) {
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    expect(h.openGraphs()).toEqual(["a1"]);
    h.fake.source.index = indexFor("t2");
    h.offer(change); await flush();
    expect(h.fake.pending("ca").some((read) => read.token === "t2")).toBe(true);
  }

  it("a failed re-read of an open stack fails in its cover; the rest of the folder commits on the new index", async () => {
    const h = setup();
    await refreshWithOpenStack(h, { listing: [...LISTING, entry("new.txt")] });
    // Revalidating an open stack is silent: no progress on its cover, the scene stays as drawn.
    expect(h.controller.notices.size).toBe(0);
    expect(h.controller.committedIndex!.token).toBe("t1");
    h.fake.fail("ca", new Error("disk on fire"));
    await flush();
    expect(h.controller.failure).toBeNull();
    expect(h.controller.committedIndex!.token).toBe("t2");
    expect(cellIds(h)).toContain("/f/new.txt");
    // Never an old graph with the new index: the failed stack is drawn closed, with its error and Retry.
    expect(h.openGraphs()).toEqual([]);
    expect(h.controller.notices.get("a1")).toMatchObject({ phase: "failed", message: "disk on fire" });
    expect(h.controller.transaction?.status).toBe("committed");
    // Later changes keep committing.
    h.offer({ listing: LISTING }); await flush();
    expect(cellIds(h)).not.toContain("/f/new.txt");
    expect(h.work.held).toBe(0);
    // The stack is still requested open: Retry reads it again and reopens it.
    h.act("retry", () => { h.controller.clearFailure("a1"); h.offer(); });
    await flush();
    h.deliver("ca"); await flush();
    expect(h.openGraphs()).toEqual(["a1"]);
    expectComplete(h.controller.published!);
    expect(h.controller.notices.size).toBe(0);
  });

  it("a newer index reads a stack whose re-read failed again and reopens it", async () => {
    const h = setup();
    await refreshWithOpenStack(h);
    h.fake.fail("ca", new Error("transient")); await flush();
    expect(h.openGraphs()).toEqual([]);
    // A late reply for the failed attempt does not reopen it.
    h.fake.source.components = new Map(h.fake.source.components).set("ca", componentData("ca", "t2"));
    h.offer(); await flush();
    expect(h.openGraphs()).toEqual([]);
    h.fake.source.index = indexFor("t3");
    h.offer(); await flush();
    expect(h.fake.pending("ca").some((read) => read.token === "t3")).toBe(true);
    h.deliver("ca"); await flush();
    expect(h.controller.committedIndex!.token).toBe("t3");
    expect(h.openGraphs()).toEqual(["a1"]);
    expect(h.controller.notices.size).toBe(0);
  });

  it("a hung re-read of an open stack times out in its cover; the rest commits and work is released", async () => {
    const h = setup();
    await refreshWithOpenStack(h);
    h.offer({ listing: [...LISTING, entry("new.txt")] }); await flush();
    expect(h.controller.transaction?.status).toBe("preparing-data");
    expect(h.work.held).toBe(1);
    h.fire(5000); await flush();
    expect(cellIds(h)).toContain("/f/new.txt");
    expect(h.controller.committedIndex!.token).toBe("t2");
    expect(h.openGraphs()).toEqual([]);
    expect(h.controller.notices.get("a1")).toMatchObject({ phase: "failed", message: expect.stringMatching(/too long/) });
    expect(h.controller.failure).toBeNull();
    expect(h.work.held).toBe(0);
    expect(h.fake.pending("ca")).toHaveLength(0);
    expect(liveTimers(h)).toHaveLength(0);
  });

  it("a later commit on a newer index clears a view failure", async () => {
    const h = setup({ inline: (input) => input.open.size === 0 });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    h.layouts[0].reply.resolve(engines.default(h.layouts[0].input)); await flush();
    h.fake.source.index = indexFor("t2");
    h.offer(); await flush();
    h.deliver("ca"); await flush();
    h.layouts.at(-1)!.reply.reject(new Error("layout broke")); await flush();
    expect(h.controller.failure).toBe("layout broke");
    // A selection on the committed (older) snapshot does not resolve it.
    h.act("selection", () => h.offer({ selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "[\"/f/notes.txt\"]" })); await flush();
    h.layouts.at(-1)!.reply.reject(new Error("layout broke")); await flush();
    expect(h.controller.failure).toBe("layout broke");
    h.fake.source.index = indexFor("t3");
    h.offer(); await flush();
    h.deliver("ca"); await flush();
    h.layouts.at(-1)!.reply.resolve(engines.default(h.layouts.at(-1)!.input)); await flush();
    expect(h.controller.committedIndex!.token).toBe("t3");
    expect(h.controller.failure).toBeNull();
  });

  it("an operation that throws fails its transaction with the error; later changes still commit", async () => {
    const h = setup();
    h.offer(); await flush();
    expect(() => h.act("selection", () => { throw new Error("host threw"); })).toThrow("host threw");
    expect(h.controller.transaction).toMatchObject({ status: "failed", error: "host threw" });
    expect(h.failures).toContain("host threw");
    h.offer({ listing: [...LISTING, entry("new.txt")] }); await flush();
    expect(cellIds(h)).toContain("/f/new.txt");
  });

  it("an operation's writes before it threw still commit", async () => {
    const h = setup();
    h.offer(); await flush();
    expect(() => h.act("selection", () => { h.offer({ selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "[\"/f/notes.txt\"]" }); throw new Error("host threw"); })).toThrow();
    await flush();
    expect(h.controller.published!.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
  });

  it("an operation that never settles stops holding the scene after the bound", async () => {
    const h = setup();
    h.offer(); await flush();
    let settle!: () => void;
    const operation = h.act("selection", () => new Promise<void>((resolve) => { settle = resolve; }));
    await flush();
    h.offer({ listing: [...LISTING, entry("new.txt")] }); await flush();
    expect(cellIds(h)).not.toContain("/f/new.txt"); // the action still owns the scene
    h.fire(5000); await flush();
    expect(cellIds(h)).toContain("/f/new.txt");
    settle(); await operation; await flush();
    expect(liveTimers(h)).toHaveLength(0);
  });

  it("a cover deadline aborts the running worker layout it no longer needs", async () => {
    const h = setup({ inline: (input) => input.open.size === 0 });
    h.offer({ open: new Set(["b1"]) }); await flush();
    h.deliver("cb"); await flush();
    h.layouts[0].reply.resolve(engines.default(h.layouts[0].input)); await flush();
    const committed = h.controller.published;
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) }));
    await flush();
    h.deliver("ca"); await flush();
    expect(h.layouts).toHaveLength(2);
    h.fire(5000); await flush();
    expect(h.layouts[1].signal.aborted).toBe(true);
    // Without the failed stack the folder is laid out as committed: nothing is asked again.
    expect(h.layouts).toHaveLength(2);
    expect(h.openGraphs()).toEqual(["b1"]);
    expect(h.controller.published!.scene.layout).toBe(committed!.scene.layout);
    expect(h.controller.notices.get("a1")?.phase).toBe("failed");
    expect(h.work.held).toBe(0);
  });

  it("new data while a worker layout runs aborts it and asks once for the layout with the data", async () => {
    const h = setup({ inline: (input) => input.open.size === 0 });
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    await flush();
    h.deliver("ca"); await flush();
    expect(h.layouts).toHaveLength(1);
    // The same action coalesces another open before the layout replies.
    h.controller.derive(() => h.offer({ open: new Set(["a1", "b1"]) }));
    await flush();
    expect(h.layouts[0].signal.aborted).toBe(true);
    h.deliver("cb"); await flush();
    expect(h.layouts).toHaveLength(2);
    expect([...h.layouts[1].input.open.keys()].sort()).toEqual(["a1", "b1"]);
    h.layouts[1].reply.resolve(engines.default(h.layouts[1].input)); await flush();
    expect(h.openGraphs()).toEqual(["a1", "b1"]);
    expect(h.published).toHaveLength(2);
  });
});
