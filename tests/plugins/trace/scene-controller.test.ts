import "./svelte-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneController, type SceneCause, type SceneController } from "$lib/plugins/trace/view/scene-controller.svelte";
import { installSceneInstrumentation } from "$lib/plugins/trace/view/scene-instrumentation";
import type { ComponentLease } from "$lib/plugins/trace/view/folder-session.svelte";
import type { SceneIntent } from "$lib/plugins/trace/view/scene-inputs";
import { samplePresentation, type Publication } from "$lib/plugins/trace/view/presentation";
import { createSceneStore, type SceneStore } from "$lib/plugins/trace/view/folder-snapshots";
import { estimateSavedSceneBytes, type SavedScene } from "$lib/plugins/trace/view/scene-snapshots";
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

function harness(options: { inline?: (input: FolderLayoutInput) => boolean; token?: string; scenes?: SceneStore<SavedScene>; paneId?: string; tick?: () => Promise<void> } = {}) {
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
    paneId: options.paneId ?? "p", data: fake.source, engine, inline: options.inline ?? (() => true), scenes: options.scenes,
    runLayout: (input, signal) => { const reply = deferred<FolderLayout>(); layouts.push({ input, signal, reply }); return reply.promise; },
    tick: options.tick ?? (() => Promise.resolve()),
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

describe("scene controller: lifetime", () => {
  it("enter() ends the folder's lifetime at once: preparation and waiters aborted, nothing of it published later", async () => {
    const h = setup();
    h.offer(); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1"]) }));
    const id = h.controller.transaction!.id;
    const presented = h.controller.whenPresented(id, "a2"), settled = h.controller.whenSettled(id);
    await flush();
    const read = h.fake.pending("ca")[0];
    expect(read).toBeDefined();
    h.controller.enter("/elsewhere");
    // Synchronously: no scene, no notices, the read released, the waiters rejected.
    expect(h.controller.published).toBeNull();
    expect(h.controller.notices.size).toBe(0);
    expect(read.released).toBe(true);
    await expect(presented).rejects.toMatchObject({ name: "AbortError" });
    await expect(settled).rejects.toMatchObject({ name: "AbortError" });
    // The old folder's late data and intent publish nothing.
    const publications = h.published.length;
    read.reply.resolve(new Map([["ca", componentData("ca", "t1")]]));
    await flush();
    expect(h.published).toHaveLength(publications);
    expect(h.controller.published).toBeNull();
  });

  it("enter() snaps the running motion and reports the presentation idle", async () => {
    const h = setup();
    const settle = deferred<boolean>();
    const snaps = { count: 0 };
    h.controller.attachMotion({
      reduced: () => false, viewport: () => null,
      sample: (presentation) => ({ presentation, at: 0, poses: new Map() }),
      start: () => ({ started: true, settled: settle.promise }),
      snap: () => { snaps.count++; },
    });
    h.offer(); await flush();
    h.act("collapse", () => h.offer({ width: 400 }));
    await flush();
    expect(h.controller.moving).toBe(true);
    let idle = false;
    void h.controller.whenIdle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);
    const before = snaps.count;
    h.controller.enter("/elsewhere");
    expect(snaps.count).toBe(before + 1);
    expect(h.controller.moving).toBe(false);
    await flush();
    expect(idle).toBe(true);
    // The old epoch settling later changes nothing.
    settle.resolve(true);
    await flush();
    expect(h.controller.published).toBeNull();
  });

  it("reports motion from its start until its effects settle", async () => {
    const h = setup();
    const settle = deferred<boolean>();
    h.controller.attachMotion({ reduced: () => false, sample: (presentation) => ({ presentation, at: 0, poses: new Map() }), start: () => ({ started: true, settled: settle.promise }), snap: () => undefined });
    h.offer(); await flush();
    expect(h.controller.moving).toBe(true);
    let idle = false;
    void h.controller.whenIdle().then(() => { idle = true; });
    await flush();
    expect(idle).toBe(false);
    settle.resolve(true);
    await flush();
    expect(h.controller.moving).toBe(false);
    expect(idle).toBe(true);
    await expect(h.controller.whenIdle()).resolves.toBeUndefined();
  });
});

describe("scene controller: restoration", () => {
  const store = () => createSceneStore<SavedScene>(estimateSavedSceneBytes);

  /** A first mount that commits `a1` open, then unmounts. */
  async function previousMount(scenes: SceneStore<SavedScene>) {
    const h = harness({ scenes });
    h.offer({ open: new Set(["a1"]) });
    await flush();
    h.deliver("ca");
    await flush();
    const shown = h.controller.published!;
    const data = { index: h.fake.source.index, components: h.fake.source.components };
    h.controller.dispose(); h.restore();
    return { shown, data };
  }

  it("shows this pane's committed scene at once when the width and metrics match, then revalidates without a layout", async () => {
    const scenes = store();
    const { shown, data } = await previousMount(scenes);
    const h = setup({ scenes });
    // The session's folder snapshot provides the same data.
    h.fake.source.index = data.index; h.fake.source.components = data.components;
    h.offer({ open: new Set(["a1"]) });
    // Synchronously, before any layout or read.
    const restored = h.controller.published!;
    expect(restored).not.toBeNull();
    expect(h.engine).not.toHaveBeenCalled();
    expect(restored.scene.cells).toEqual(shown.scene.cells);
    expect([...restored.scene.records.keys()]).toEqual([...shown.scene.records.keys()]);
    expect([...restored.scene.records.values()].map((record) => record.rect)).toEqual([...shown.scene.records.values()].map((record) => record.rect));
    // An empty presentation, in this pane's new lifetime.
    expect(restored.presentation.duration).toBe(0);
    expect(restored.presentation.retiring.size).toBe(0);
    expect(restored.scene.scope).not.toBe(shown.scene.scope);
    expect(restored.scene.scope).toEqual({ paneId: "p", directory: "/f", generation: expect.any(Number) });
    await flush();
    expect(h.engine).not.toHaveBeenCalled();
    expect(h.published).toHaveLength(1);
    expect(h.fake.reads).toHaveLength(0);
  });

  it("lays the saved data out again at a new width, before the index is read, and snaps", async () => {
    const scenes = store();
    const { shown } = await previousMount(scenes);
    const h = setup({ scenes });
    h.fake.source.index = null;
    h.offer({ open: new Set(["a1"]), width: 480 });
    await flush();
    const scene = h.controller.published!.scene;
    expect(h.engine).toHaveBeenCalledTimes(1);
    expect(scene.inputs.layoutInput.width).not.toBe(shown.scene.inputs.layoutInput.width);
    expect([...scene.graphs.keys()]).toEqual(["a1"]);
    expect(h.controller.published!.presentation.duration).toBe(0);
    expectComplete(h.controller.published!);
  });

  it("never restores another folder's scene, even with the same component ids", async () => {
    const scenes = store();
    await previousMount(scenes);
    const h = setup({ scenes });
    h.fake.source.index = { ...indexFor("t1"), directory: "/g" };
    h.offer({ directory: "/g" });
    expect(h.controller.published).toBeNull();
    await flush();
    expect(h.controller.published!.scene.scope.directory).toBe("/g");
    expect(h.engine).toHaveBeenCalled();
    expect(h.openGraphs()).toEqual([]);
  });

  it("never restores another pane's scene", async () => {
    const scenes = store();
    await previousMount(scenes);
    const h = setup({ scenes, paneId: "other" });
    h.fake.source.index = null;
    h.offer({ open: new Set(["a1"]) });
    await flush();
    expect(h.controller.published).toBeNull();
  });

  it("restores nothing once the store was cleared after the pane began", async () => {
    const scenes = store();
    const h = setup({ scenes });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    expect(scenes.recall("p", "/f")).toBeDefined();
    scenes.clear();
    h.offer({ open: new Set(["a1"]), selectedPaths: new Set(["/f/notes.txt"]) }); await flush();
    expect(scenes.recall("p", "/f")).toBeUndefined();
  });

  it("keeps the newest committed scene, without request history", async () => {
    const scenes = store();
    const h = setup({ scenes });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]), focus: { key: "a2", componentId: "ca" } })); await flush();
    h.deliver("cb"); await flush();
    const saved = scenes.recall("p", "/f")!;
    expect([...saved.scene.graphs.keys()].sort()).toEqual(["a1", "b1"]);
    for (const graph of [...saved.scene.graphs.values(), ...saved.scene.layout.graphs.values()]) expect(graph.plan.request.history).toBeUndefined();
    // The published scene itself is unchanged.
    expect([...h.controller.published!.scene.graphs.values()].some((graph) => graph.plan.request.history !== undefined)).toBe(true);
  });
});

describe("scene controller: review fixes (099e72f)", () => {
  const store = () => createSceneStore<SavedScene>(estimateSavedSceneBytes);
  /** A first mount that commits `a1` open with the closed stack `b1` selected, then unmounts. */
  async function previousMount(scenes: SceneStore<SavedScene>) {
    const h = harness({ scenes });
    h.offer({ open: new Set(["a1"]), selectedKeys: new Set(["b1"]), focus: { key: "b1", componentId: "cb" } });
    await flush();
    h.deliver("ca");
    await flush();
    const data = { index: h.fake.source.index, components: h.fake.source.components };
    h.controller.dispose(); h.restore();
    return data;
  }
  const remount = async (scenes: SceneStore<SavedScene>, options: Parameters<typeof harness>[0] = {}) => {
    const data = await previousMount(scenes);
    const h = setup({ scenes, ...options });
    h.fake.source.index = data.index; h.fake.source.components = data.components;
    return h;
  };
  const selectedTiles = (publication: Publication) => [...publication.scene.tiles.values()].filter((record) => record.selected).map((record) => record.tile.key).sort();

  it("a returning pane's first scene shows the selection it has now, not the one it saved", async () => {
    const h = await remount(store());
    h.offer({ open: new Set(["a1"]), selectedPaths: new Set(["/f/notes.txt"]) });
    // Synchronously: the saved layout fits (no open stack's focus changed), styled as the pane is now.
    const first = h.controller.published!;
    expect(h.engine).not.toHaveBeenCalled();
    expect(selectedTiles(first)).toEqual([]);
    expect(first.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
    expect(first.scene.inputs.styling.focus).toBeNull();
    expect(first.presentation.duration).toBe(0);
    await flush();
    expect(h.engine).not.toHaveBeenCalled();
    for (const publication of [...h.published, h.controller.published!]) {
      expect(selectedTiles(publication)).toEqual([]);
      expect(publication.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
    }
  });

  it("a focus that changes an open stack's layout is laid out before the first frame and snaps", async () => {
    const h = await remount(store());
    h.offer({ open: new Set(["a1"]), selectedKeys: new Set(["a3"]), focus: { key: "a3", componentId: "ca" } });
    const first = h.controller.published!;
    expect(h.engine).toHaveBeenCalledTimes(1);
    expect(first.scene.graphs.get("a1")!.plan.lineage.focus).toBe("a3");
    expect(selectedTiles(first)).toEqual(["a3"]);
    expect(first.presentation.duration).toBe(0);
    await flush();
    expect(h.published.map((publication) => publication.scene.inputs.styling.focus)).toEqual(["a3"]);
  });

  // Review 8d257bf: a return that needed the worker was blank, then "Loading Trace…".
  it("a layout too large to run inline shows the saved scene, styled as now, until the current scene is ready, then snaps to it", async () => {
    const h = await remount(store(), { inline: () => false });
    h.offer({ open: new Set(["a1"]), selectedKeys: new Set(["a3"]), focus: { key: "a3", componentId: "ca" } });
    // Synchronously: the saved layout, with the selection the pane has now.
    const saved = h.controller.published!;
    expect(saved).not.toBeNull();
    expect(saved.scene.graphs.get("a1")!.plan.lineage.focus).not.toBe("a3");
    expect(saved.scene.inputs.styling.selectedKeys).toEqual(new Set(["a3"]));
    expect(selectedTiles(saved), "not the selection it was saved with").not.toContain("b1");
    expect(saved.presentation.duration).toBe(0);
    await flush();
    expect(h.controller.published!.scene.layout).toBe(saved.scene.layout);
    expect(h.layouts).toHaveLength(1);
    h.layouts[0].reply.resolve(engines.default(h.layouts[0].input));
    await flush();
    const current = h.controller.published!;
    expect(current.scene.graphs.get("a1")!.plan.lineage.focus).toBe("a3");
    expect(current.presentation.duration).toBe(0);
    expect(h.published).toHaveLength(2);
  });

  // Review 8d257bf: a return after the folder's index moved on was blank, then "Loading Trace…".
  it("a saved scene older than the index the session knows is shown at once, and the newer index snaps in after it", async () => {
    const h = await remount(store());
    h.fake.source.index = indexFor("t2");
    h.offer({ open: new Set(["a1"]), selectedKeys: new Set(["b1"]), focus: { key: "b1", componentId: "cb" } });
    const first = h.controller.published!;
    expect(first).not.toBeNull();
    expect(h.controller.committedIndex!.token).toBe("t1");
    await flush();
    expect(h.controller.published!.scene.layout).toBe(first.scene.layout);
    h.deliver("ca"); await flush();
    const current = h.controller.published!;
    expect(current.scene.graphs.get("a1")!.componentId).toBe("ca");
    expect(h.controller.committedIndex!.token).toBe("t2");
    expect(current.presentation.duration).toBe(0);
  });

  // Review 8d257bf: a throw building the restored scene, inside the intake, left its transaction
  // operating for ever, so every later offer was swallowed.
  it("a return whose first scene cannot be built fails it and recovers on the next offers", async () => {
    const h = await remount(store());
    let poisoned = true;
    h.engine.mockImplementation((input: FolderLayoutInput) => {
      const layout = engines.default(input);
      if (!poisoned) return layout;
      poisoned = false;
      // A NaN graph origin: the scene rejects it.
      return { ...layout, graphs: new Map([...layout.graphs].map(([id, graph]) => [id, { ...graph, origin: { x: NaN, y: 0 } }])) };
    });
    // The focus changes an open stack's layout, so the return lays it out (inline) and builds it.
    expect(() => h.offer({ open: new Set(["a1"]), selectedKeys: new Set(["a3"]), focus: { key: "a3", componentId: "ca" } })).not.toThrow();
    expect(poisoned).toBe(false);
    expect(h.failures.length).toBeGreaterThan(0);
    await flush();
    expect(h.controller.published).not.toBeNull();
    expect(h.controller.published!.scene.graphs.get("a1")!.plan.lineage.focus).toBe("a3");
    // Data, a selection and a resize all still commit.
    h.fake.source.components = new Map(h.fake.source.components);
    h.offer({ selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "n" }); await flush();
    expect(h.controller.published!.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
    h.offer({ width: 500 }); await flush();
    expect(h.controller.published!.scene.inputs.layoutInput.width).toBeLessThan(900);
    expect(h.controller.transaction!.status).toBe("committed");
  });

  // Review 8d257bf: a pane that only restyled stopped refreshing its saved scene's recency, so other saves evicted it.
  it("a restyle keeps the saved scene the most recently used, without saving it again", async () => {
    const scenes = createSceneStore<SavedScene>(estimateSavedSceneBytes, { limit: 2 });
    const saves = vi.spyOn(scenes, "remember");
    const h = setup({ scenes });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    const after = saves.mock.calls.length;
    const other = scenes.recall("p", "/f")!;
    scenes.remember("q", "/f", other);
    // The pane restyles: its entry becomes the most recently used again.
    h.act("selection", () => h.offer({ open: new Set(["a1"]), selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "x" })); await flush();
    expect(saves.mock.calls.length).toBe(after + 1); // only the "q" save above
    scenes.remember("r", "/f", other);
    expect(scenes.recall("p", "/f")).toBeDefined();
    expect(scenes.recall("q", "/f")).toBeUndefined();
  });

  it("saves the scene for the next mount only when what a restore reuses changes", async () => {
    const scenes = store();
    const saves = vi.spyOn(scenes, "remember");
    const h = setup({ scenes });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    const after = saves.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    h.offer({ open: new Set(["a1"]), badgeHover: "a2" }); await flush();
    h.act("selection", () => h.offer({ open: new Set(["a1"]), badgeHover: null, selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "x" })); await flush();
    expect(saves.mock.calls.length).toBe(after);
    h.act("resize", () => h.offer({ width: 400 })); await flush();
    expect(saves.mock.calls.length).toBe(after + 1);
    // The next mount still starts from the current scene, styled as that pane is then.
    h.controller.dispose(); h.restore();
    const next = setup({ scenes });
    next.fake.source.index = h.fake.source.index; next.fake.source.components = h.fake.source.components;
    next.offer({ open: new Set(["a1"]), width: 400, selectedPaths: new Set(["/f/notes.txt"]) });
    expect(next.engine).not.toHaveBeenCalled();
    expect(next.controller.published!.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
  });

  it("a restyle whose publication settles before its motion setup still presents: reveal waits never hang", async () => {
    let held: (() => void)[] | null = null;
    const tick = () => held ? new Promise<void>((resolve) => held!.push(resolve)) : Promise.resolve();
    const h = setup({ tick });
    const settles: ReturnType<typeof deferred<boolean>>[] = [];
    h.controller.attachMotion({
      reduced: () => false, viewport: () => null, snap: () => undefined,
      sample: (presentation) => samplePresentation(presentation, Infinity),
      start: () => { const settle = deferred<boolean>(); settles.push(settle); return { started: true, settled: settle.promise }; },
    });
    h.offer(); await flush();
    // An expand the user made moves (a resize would snap).
    h.act("expand", () => h.offer({ open: new Set(["a1"]) })); await flush();
    h.deliver("ca"); await flush();
    expect(h.controller.published!.presentation.duration).toBeGreaterThan(0);
    const running = settles.at(-1)!;
    // A restyle commits while the epoch runs; its motion setup waits for the next tick.
    held = [];
    const before = h.controller.published;
    h.act("selection", () => h.offer({ selectedPaths: new Set(["/f/notes.txt"]), hostChoice: "y" }));
    for (let i = 0; i < 20 && h.controller.published === before; i++) { const next = held.shift(); next?.(); await Promise.resolve(); await Promise.resolve(); }
    const restyle = h.controller.published!;
    expect(restyle).not.toBe(before);
    expect(restyle.scene.entries.get("/f/notes.txt")?.selected).toBe(true);
    // Meanwhile the running epoch settles: the same publication is presented settled.
    running.resolve(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.controller.published!.transactionId).toBe(restyle.transactionId);
    expect(h.controller.published!.presentation.duration).toBe(0);
    const pending = held; held = null;
    for (const resolve of pending) resolve();
    let settled = false;
    void h.controller.whenSettled(restyle.transactionId).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(true);
  });
});

describe("scene controller: geometry motion policy (native findings)", () => {
  /** A motion stub whose epochs never settle on their own; records what each start was given. */
  function attach(h: ReturnType<typeof harness>) {
    const starts: { duration: number; started: boolean }[] = [];
    let snaps = 0;
    h.controller.attachMotion({
      reduced: () => false, viewport: () => null, snap: () => { snaps++; },
      sample: (presentation) => samplePresentation(presentation, 0),
      start: (presentation) => {
        const started = presentation.duration > 0;
        starts.push({ duration: presentation.duration, started });
        return { started, settled: new Promise<boolean>(() => undefined) };
      },
    });
    return { starts, snaps: () => snaps };
  }
  const moving = (h: ReturnType<typeof harness>) => h.controller.published!.presentation.duration > 0;

  it("animates the expand and collapse the user makes", async () => {
    const h = setup();
    h.offer({ open: new Set(["b1"]) }); await flush();
    h.deliver("cb"); await flush();
    const motion = attach(h);
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) })); await flush();
    h.deliver("ca"); await flush();
    expect(moving(h)).toBe(true);
    h.act("collapse", () => h.offer({ open: new Set(["b1"]) })); await flush();
    expect(moving(h)).toBe(true);
    expect(motion.starts.every((start) => start.started)).toBe(true);
  });

  it.each([
    ["resize", { width: 600 }],
    ["metrics", { tile: tileMetrics(160), grid: fallbackGridMetrics(tileMetrics(160)) }],
    ["listing", { listing: [LISTING[1], LISTING[0], LISTING[2]] }],
  ] as const)("snaps a geometry change by %s, ending motion still running", async (cause, change) => {
    const h = setup();
    h.offer({ open: new Set(["b1"]) }); await flush();
    h.deliver("cb"); await flush();
    const motion = attach(h);
    h.act("expand", () => h.offer({ open: new Set(["a1", "b1"]) })); await flush();
    h.deliver("ca"); await flush();
    expect(moving(h)).toBe(true);
    const before = h.published.length;
    // Not an action: the host changed the pane (a resize, a scrollbar, a tile size, a re-sort).
    h.offer(change); await flush();
    expect(h.published.length, `${cause} publishes geometry`).toBe(before + 1);
    expect(h.controller.published!.presentation.duration).toBe(0);
    expect(h.controller.published!.presentation.retiring.size).toBe(0);
    expect(motion.starts.at(-1)).toEqual({ duration: 0, started: false });
  });

  it("snaps a refresh that changes the scene", async () => {
    const h = setup();
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    attach(h);
    // The backend's new index drops stack b.
    h.fake.source.index = indexFor("t2", ["ca"]);
    h.offer(); await flush();
    h.deliver("ca"); await flush();
    expect(h.controller.committedIndex!.token).toBe("t2");
    expect(h.controller.published!.scene.cells.some((cell) => cell.id === "b1")).toBe(false);
    expect(moving(h)).toBe(false);
  });

  it("a size round trip commits the layout it had before without laying out again", async () => {
    const h = setup({ inline: () => false });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    h.layouts.at(-1)!.reply.resolve(engines.default(h.layouts.at(-1)!.input)); await flush();
    const narrow = h.controller.published!;
    expect(narrow.scene.graphs.has("a1")).toBe(true);
    // Widened under a fullscreen Preview: laid out off the main thread (the narrow scene fits meanwhile).
    h.offer({ width: 1300 }); await flush();
    expect(h.controller.published).toBe(narrow);
    const wide = h.layouts.at(-1)!;
    expect(wide.input.width).toBeGreaterThan(narrow.scene.inputs.layoutInput.width);
    wide.reply.resolve(engines.default(wide.input)); await flush();
    expect(h.controller.published!.scene.inputs.layoutInput.width).toBe(wide.input.width);
    // Narrowed again on exit: the earlier layout is committed at once, nothing is laid out.
    const asked = h.layouts.length, inlineRuns = h.engine.mock.calls.length;
    h.offer({ width: 900 });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.controller.published!.scene.layout).toBe(narrow.scene.layout);
    expect(h.layouts.length).toBe(asked);
    expect(h.engine.mock.calls.length).toBe(inlineRuns);
  });

  it("lays out at once, whatever the workload, when the scene on screen no longer fits the pane", async () => {
    const h = setup({ inline: () => false });
    h.offer({ open: new Set(["a1"]), width: 1300 }); await flush();
    h.deliver("ca"); await flush();
    h.layouts.at(-1)!.reply.resolve(engines.default(h.layouts.at(-1)!.input)); await flush();
    const wide = h.controller.published!;
    const asked = h.layouts.length;
    h.offer({ width: 500 }); await flush();
    expect(h.layouts.length, "no worker layout").toBe(asked);
    expect(h.controller.published).not.toBe(wide);
    expect(h.controller.published!.scene.layout.size.width).toBeLessThanOrEqual(h.controller.published!.scene.inputs.layoutInput.width);
  });

  it("does not reuse a layout of the same basis laid out from other data", async () => {
    const h = setup({ inline: () => false });
    h.offer({ open: new Set(["a1"]) }); await flush();
    h.deliver("ca"); await flush();
    h.layouts.at(-1)!.reply.resolve(engines.default(h.layouts.at(-1)!.input)); await flush();
    const first = h.controller.published!;
    h.offer({ width: 1300 }); await flush();
    h.layouts.at(-1)!.reply.resolve(engines.default(h.layouts.at(-1)!.input)); await flush();
    // Another data object under the same version (the basis cannot tell them apart).
    const was = h.fake.source.components.get("ca")!;
    h.fake.source.components = new Map([["ca", { ...was, dag: projectDag(STACKS.ca) }]]);
    h.offer({ width: 900 }); await flush();
    expect(h.controller.published!.scene.layout).not.toBe(first.scene.layout);
  });
});
