import "./svelte-host";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createFolderSession, forgetFolderSnapshots, StaleComponentsError } from "$lib/plugins/trace/view/folder-session.svelte";
import { createSnapshotCache } from "$lib/plugins/trace/view/folder-snapshots";
import type { TraceBackend } from "$lib/plugins/trace/view/backend";
import type { ComponentNodesPage, FolderComponentsPage, FolderMembersPage } from "$lib/api/trace";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { locateTarget } from "$lib/plugins/trace/view/target-location";
import { withNativeRequestCapacity } from "../../../e2e/harness/request-capacity";
import { MAX_UNRESOLVED_OPEN_STACKS } from "$lib/plugins/trace/view/open-stacks";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const summary = (id: string) => ({ id, title: id, cover: null, coverKey: id, imageCount: 1, nodeCount: 1, active: false, unsaved: false });
const node = (key: string, order: number, parents: string[] = []): TraceNode => ({
  key, artifactId: order, runId: null, parents, path: `/f/${key}.png`, scope: "current", location: `./${key}.png`,
  state: "present", temporary: false, discarded: false, earlierRevision: false, order, prompt: "",
});
const compPage = (token: string, ids: string[], total = ids.length, offset = 0): FolderComponentsPage => ({ token, total, offset, components: ids.map(summary) });
const memPage = (members: [string, string, string][], total = members.length, stale = false): FolderMembersPage => ({
  stale, total, offset: 0, members: members.map(([path, componentId, key]) => ({ path, componentId, key })),
});
const nodePage = (nodes: TraceNode[], total = nodes.length, stale = false): ComponentNodesPage => ({ stale, total, offset: 0, nodes: nodes as never });

function fakeBackend(over: Partial<TraceBackend> = {}) {
  const backend = {
    components: vi.fn(async (_d: string, _o: number) => compPage("t1", ["c1"])),
    members: vi.fn(async (_d: string, _t: string, _o: number) => memPage([["/f/a.png", "c1", "a"]])),
    nodes: vi.fn(async (_d: string, _t: string, _c: string, _o: number) => nodePage([node("a", 0)])),
    ...over,
  };
  return backend satisfies TraceBackend;
}

describe("folder session", () => {
  // Each case is one view's session; what earlier cases loaded must not seed it.
  beforeEach(() => forgetFolderSnapshots());

  it("concatenates component and member pages across offsets", async () => {
    const backend = fakeBackend({
      components: vi.fn(async (_d, offset) => offset === 0 ? compPage("t", ["c1", "c2"], 3) : compPage("t", ["c3"], 3, 2)),
      members: vi.fn(async (_d, _t, offset) => offset === 0 ? memPage([["/f/1.png", "c1", "1"], ["/f/2.png", "c2", "2"]], 3) : memPage([["/f/3.png", "c3", "3"]], 3)),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.status).toBe("ready");
    expect(session.index!.components.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(session.componentOf("/f/3.png")).toEqual({ componentId: "c3", key: "3" });
    expect(session.componentOf("/f/2.png")).toEqual({ componentId: "c2", key: "2" });
  });

  it("restarts collection when the token changes mid-paging", async () => {
    const calls: [string, number][] = [];
    const backend = fakeBackend({
      components: vi.fn(async (_d, offset) => {
        calls.push(["c", offset]);
        if (calls.length === 1) return compPage("old", ["x1"], 2);
        if (calls.length === 2) return compPage("new", ["n2"], 2, 1);
        return compPage("new", offset === 0 ? ["n1", "n2"] : [], 2);
      }),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.index!.token).toBe("new");
    expect(session.index!.components.map((c) => c.id)).toEqual(["n1", "n2"]);
    expect(backend.members).toHaveBeenCalledWith("/f", "new", 0);
  });

  it("gives up with an error when the token never settles while paging components", async () => {
    let call = 0;
    const backend = fakeBackend({ components: vi.fn(async (_d, offset) => compPage(`t${call++}`, offset === 0 ? ["c1"] : ["c2"], 2, offset)) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    for (let index = 0; index < 20; index++) await flush();
    expect(session.status).toBe("error");
    expect(session.error).toMatch(/kept changing/);
    expect(backend.components.mock.calls.length).toBeLessThan(10);
  });

  it("stops on an empty page even if total claims more (no infinite loop)", async () => {
    const backend = fakeBackend({ components: vi.fn(async () => compPage("t", [], 99)) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.status).toBe("ready");
    expect(session.index!.components).toEqual([]);
  });

  it("retries a stale members page and recovers", async () => {
    let n = 0;
    const backend = fakeBackend({
      members: vi.fn(async () => (++n < 3 ? memPage([], 0, true) : memPage([["/f/a.png", "c1", "a"]]))),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.status).toBe("ready");
    expect(session.componentOf("/f/a.png")).not.toBeNull();
  });

  it("gives up after 3 retries of a perpetually stale members page", async () => {
    const backend = fakeBackend({ members: vi.fn(async () => memPage([], 0, true)) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.status).toBe("error");
    expect(session.error).toMatch(/kept changing/);
    expect(backend.members).toHaveBeenCalledTimes(4);
    expect(session.index).toBeNull();
  });

  it("reports a backend rejection as an error", async () => {
    const backend = fakeBackend({ components: vi.fn(async () => { throw new Error("boom"); }) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    expect(session.status).toBe("error");
    expect(session.error).toBe("boom");
  });

  it("never shows the previous folder's data, even if its request resolves late", async () => {
    const a = deferred<FolderComponentsPage>();
    const backend = fakeBackend({
      components: vi.fn((dir: string) => dir === "/a" ? a.promise : Promise.resolve(compPage("tb", ["cb"]))),
      members: vi.fn(async (dir: string) => memPage([[`${dir}/x.png`, dir === "/a" ? "ca" : "cb", "x"]])),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/a");
    session.setDirectory("/b");
    expect(session.index).toBeNull();
    await flush();
    expect(session.index!.directory).toBe("/b");
    a.resolve(compPage("ta", ["ca"]));
    await flush();
    expect(session.index!.directory).toBe("/b");
    expect(session.componentOf("/a/x.png")).toBeNull();
    expect(session.componentOf("/b/x.png")).not.toBeNull();
  });

  it("clears data immediately when switching folders and when set to null", async () => {
    const session = createFolderSession(fakeBackend());
    session.setDirectory("/a");
    await flush();
    await session.ensure("c1");
    expect(session.components.size).toBe(1);
    session.setDirectory("/b");
    expect(session.index).toBeNull();
    expect(session.components.size).toBe(0);
    expect(session.status).toBe("loading");
    session.setDirectory(null);
    expect(session.status).toBe("idle");
  });

  it("ensure loads nodes and dedupes concurrent loads", async () => {
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    const p1 = session.ensure("c1");
    const p2 = session.ensure("c1");
    expect(p2).toBe(p1);
    gate.resolve(nodePage([node("a", 0), node("b", 1, ["a"])]));
    await Promise.all([p1, p2]);
    expect(backend.nodes).toHaveBeenCalledTimes(1);
    const data = session.components.get("c1")!;
    expect(data.members).toEqual(["a", "b"]);
    await session.ensure("c1");
    expect(backend.nodes).toHaveBeenCalledTimes(1);
  });

  it("bounds replacement searches across panes below native request capacity", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `c${i}`);
    const gate = deferred<void>();
    let active = 0, peak = 0;
    const admitted = withNativeRequestCapacity({ invoke: async <T>(_method: string, params?: Record<string, unknown>) => {
      active += 1; peak = Math.max(peak, active);
      try { await gate.promise; return nodePage([node(String(params?.id), 1)]) as T; }
      finally { active -= 1; }
    } });
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t", ids)),
      nodes: vi.fn((_d, _t, id) => admitted.invoke<ComponentNodesPage>("trace_component_nodes", { id })),
    });
    const sessions = [createFolderSession(backend), createFolderSession(backend)];
    sessions.forEach((session, i) => session.setDirectory(`/f${i}`));
    await flush();
    const search = sessions.flatMap((session) => ids.map((id) => session.ensure(id)));
    await flush();
    gate.resolve();
    await Promise.all(search);
    expect(peak).toBeLessThanOrEqual(4);
    for (const session of sessions) {
      expect(session.components.size).toBe(ids.length);
      expect(session.error).toBe("");
      expect(locateTarget("failed-placeholder", "old", {
        listed: new Set(ids), components: session.components, isStale: (id) => session.isStale(id),
      })).toBe("gone");
      session.dispose();
    }
  });

  it("clears a component read error when a later load succeeds", async () => {
    let fail = true;
    const backend = fakeBackend({ nodes: vi.fn(async () => {
      if (fail) throw new Error("Plugin request capacity reached");
      return nodePage([node("a", 1)]);
    }) });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    await session.ensure("c1");
    expect(session.error).toBe("Plugin request capacity reached");
    fail = false;
    await session.ensure("c1");
    expect(session.components.get("c1")?.members).toEqual(["a"]);
    expect(session.error).toBe("");
  });

  it("keeps a failed component's error when a concurrent component succeeds, until its own retry recovers", async () => {
    const a = deferred<ComponentNodesPage>();
    const b = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ["a", "b"])),
      nodes: vi.fn((_d, _t, id) => id === "a" ? a.promise : b.promise),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const first = session.ensure("a");
    const second = session.ensure("b");
    a.reject(new Error("A is unavailable"));
    await first;
    expect(session.error).toBe("A is unavailable");
    b.resolve(nodePage([node("b", 2)]));
    await second;
    expect(session.components.has("a")).toBe(false);
    expect(session.components.has("b")).toBe(true);
    expect(session.error).toBe("A is unavailable");
    backend.nodes.mockImplementation(async (_d, _t, id) => nodePage([node(id, 3)]));
    await session.ensure("a");
    expect(session.components.has("a")).toBe(true);
    expect(session.error).toBe("");
    session.dispose();
  });

  it("keeps stale component errors across refresh and clears only failures that recovered or disappeared", async () => {
    let ids = ["a", "b"];
    let failing = new Set<string>();
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ids)),
      nodes: vi.fn(async (_d, _t, id) => {
        if (failing.has(id)) throw new Error(`${id} unavailable`);
        return nodePage([node(id, 1)]);
      }),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    await Promise.all(ids.map((id) => session.ensure(id)));
    failing = new Set(ids);
    await session.refresh(); await flush();
    session.release("b");
    failing = new Set(["b"]);
    await session.ensure("a");
    expect(session.isStale("a")).toBe(false);
    expect(session.isStale("b")).toBe(true);
    expect(session.error).toBe("b unavailable");
    await session.refresh(); await flush();
    expect(session.error).toBe("b unavailable");
    ids = ["a"];
    await session.refresh(); await flush();
    expect(session.error).toBe("");
    session.dispose();
  });

  it("a component success does not clear an unresolved index error", async () => {
    const backend = fakeBackend();
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    backend.components.mockRejectedValueOnce(new Error("Index is unavailable"));
    await session.refresh();
    await session.ensure("c1");
    expect(session.error).toBe("Index is unavailable");
    await session.refresh(); await flush();
    expect(session.error).toBe("");
    session.dispose();
  });

  it("drops sixteen released queued reads while four wanted reads are still in flight", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ids)),
      nodes: vi.fn(() => gate.promise),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const reads = ids.map((id) => session.ensure(id));
    expect(backend.nodes.mock.calls).toHaveLength(4);
    for (const id of ids.slice(4)) session.release(id);
    gate.resolve(nodePage([node("loaded", 1)]));
    await Promise.all(reads);
    expect(backend.nodes.mock.calls.map((call) => call[2])).toEqual(ids.slice(0, 4));
    expect([...session.components.keys()]).toEqual(ids.slice(0, 4));
    expect(session.error).toBe("");
    // A released request must not block a later request for the same component.
    await session.ensure(ids[4]);
    expect(session.components.has(ids[4])).toBe(true);
    session.dispose();
  });

  it("can immediately request a released queued component again without its old task cancelling the replacement", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ids)),
      nodes: vi.fn(() => gate.promise),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const reads = ids.map((id) => session.ensure(id));
    session.release("c5");
    const replacement = session.ensure("c5");
    // Let the cancelled task clean up while its replacement is still queued.
    await flush();
    const repeated = session.ensure("c5");
    gate.resolve(nodePage([node("loaded", 1)]));
    await Promise.all([...reads, replacement, repeated]);
    expect(backend.nodes.mock.calls.map((call) => call[2])).toEqual(ids);
    expect(session.components.has("c5")).toBe(true);
    expect(session.error).toBe("");
    session.dispose();
  });

  it("stops released in-flight loads before reading another page or committing partial data", async () => {
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const reading = session.ensure("c1");
    session.release("c1");
    gate.resolve(nodePage([node("partial", 1)], 2));
    await reading;
    expect(backend.nodes).toHaveBeenCalledTimes(1);
    expect(session.components.size).toBe(0);
    expect(session.error).toBe("");
    session.dispose();
  });

  it("does not send queued component reads after the folder changes", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `old${i}`);
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(async (dir) => compPage(dir, dir === "/old" ? ids : ["new"])),
      nodes: vi.fn(() => gate.promise),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/old"); await flush();
    const loading = ids.map((id) => session.ensure(id));
    session.setDirectory("/new"); await flush();
    gate.resolve(nodePage([node("old-node", 1)]));
    await Promise.all(loading);
    expect(backend.nodes.mock.calls).toHaveLength(4);
    expect(session.index?.directory).toBe("/new");
    expect(session.components.size).toBe(0);
  });

  it("keeps reloading component data unresolved until the fresh page arrives", async () => {
    const backend = fakeBackend();
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    await session.ensure("c1");
    const gate = deferred<ComponentNodesPage>();
    backend.nodes.mockImplementation(() => gate.promise);
    await session.refresh();
    expect(session.components.get("c1")?.members).toEqual(["a"]);
    expect(session.isStale("c1")).toBe(true);
    expect(locateTarget("a", "c1", {
      listed: new Set(["c1"]), components: session.components, isStale: (id) => session.isStale(id),
    })).toBe("unknown");
    gate.resolve(nodePage([node("a", 1)]));
    await session.ensure("c1");
    expect(session.isStale("c1")).toBe(false);
  });

  it("pages component nodes", async () => {
    const backend = fakeBackend({
      nodes: vi.fn(async (_d, _t, _c, offset) => offset === 0 ? nodePage([node("a", 0), node("b", 1)], 3) : nodePage([node("c", 2)], 3)),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    await session.ensure("c1");
    expect(session.components.get("c1")!.nodes.map((n) => n.key)).toEqual(["a", "b", "c"]);
  });

  it("ensure before the index arrives loads once the index is ready", async () => {
    const gate = deferred<FolderComponentsPage>();
    const backend = fakeBackend({ components: vi.fn(() => gate.promise) });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await session.ensure("c1");
    expect(backend.nodes).not.toHaveBeenCalled();
    gate.resolve(compPage("t", ["c1"]));
    await flush();
    expect(session.components.has("c1")).toBe(true);
  });

  it("refresh: previous data stays, new index replaces it, only wanted components reload", async () => {
    let round = 0;
    const gate = deferred<FolderComponentsPage>();
    const backend = fakeBackend({
      components: vi.fn(async () => {
        round++;
        if (round === 1) return compPage("t1", ["c1", "c2", "c3"]);
        return gate.promise;
      }),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    await session.ensure("c1");
    await session.ensure("c2");
    await session.ensure("c3");
    session.release("c2");
    backend.nodes.mockClear();

    const refreshing = session.refresh();
    expect(session.index!.token).toBe("t1");
    expect(session.status).toBe("ready");
    expect([...session.components.keys()].sort()).toEqual(["c1", "c2", "c3"]);

    gate.resolve(compPage("t2", ["c1", "c2"]));
    await refreshing;
    await flush();
    expect(session.index!.token).toBe("t2");
    // c3 vanished from the index, c2 was released: only c1 is reloaded.
    expect([...session.components.keys()].sort()).toEqual(["c1", "c2"]);
    expect(backend.nodes.mock.calls.map((call) => call[2])).toEqual(["c1"]);
    expect(backend.nodes.mock.calls[0][1]).toBe("t2");
  });

  it("a released component a refresh skipped reloads when it is wanted again, keeping its old graph until then", async () => {
    let token = "t1";
    let state: TraceNode["discarded"] = false;
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(token, ["c1"])),
      nodes: vi.fn(async () => nodePage([{ ...node("a", 0), discarded: state }])),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    await session.ensure("c1");
    session.release("c1");
    // The image is discarded while its section is collapsed.
    token = "t2"; state = true;
    await session.refresh();
    await flush();
    expect(session.components.get("c1")!.nodes[0].discarded).toBe(false);
    expect(session.isStale("c1")).toBe(true);
    backend.nodes.mockClear();
    await session.ensure("c1");
    expect(backend.nodes).toHaveBeenCalledTimes(1);
    expect(session.components.get("c1")!.nodes[0].discarded).toBe(true);
    expect(session.isStale("c1")).toBe(false);
    // Fresh again: a later ensure does not reload.
    await session.ensure("c1");
    expect(backend.nodes).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh keeps the existing data and reports the error", async () => {
    let fail = false;
    const backend = fakeBackend({
      components: vi.fn(async () => { if (fail) throw new Error("later"); return compPage("t", ["c1"]); }),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    await session.ensure("c1");
    fail = true;
    await session.refresh();
    expect(session.status).toBe("ready");
    expect(session.error).toBe("later");
    expect(session.components.has("c1")).toBe(true);
  });

  it("a stale component page triggers a refresh", async () => {
    let nodeCalls = 0;
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(`t${backend.components.mock.calls.length}`, ["c1"])),
      nodes: vi.fn(async () => (++nodeCalls === 1 ? nodePage([], 0, true) : nodePage([node("a", 0)]))),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    await session.ensure("c1");
    await flush();
    expect(backend.components.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(session.components.get("c1")!.members).toEqual(["a"]);
  });

  it("dispose stops late results from applying", async () => {
    const gate = deferred<FolderComponentsPage>();
    const nodes = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ components: vi.fn(() => gate.promise) });
    const s1 = createFolderSession(backend);
    s1.setDirectory("/f");
    s1.dispose();
    gate.resolve(compPage("t", ["c1"]));
    await flush();
    expect(s1.index).toBeNull();
    expect(backend.members).not.toHaveBeenCalled();

    const b2 = fakeBackend({ nodes: vi.fn(() => nodes.promise) });
    const s2 = createFolderSession(b2);
    s2.setDirectory("/f");
    await flush();
    const loading = s2.ensure("c1");
    s2.dispose();
    nodes.resolve(nodePage([node("a", 0)]));
    await loading;
    expect(s2.components.size).toBe(0);
  });

  it("componentOf is null for unknown paths and before loading", async () => {
    const session = createFolderSession(fakeBackend());
    expect(session.componentOf("/f/a.png")).toBeNull();
    session.setDirectory("/f");
    await flush();
    expect(session.componentOf("/f/a.png")).toEqual({ componentId: "c1", key: "a" });
    expect(session.componentOf("/f/none.png")).toBeNull();
  });
});

describe("returning to a folder (a Trace tab shown again)", () => {
  beforeEach(() => forgetFolderSnapshots());

  async function loaded(dir: string) {
    const first = createFolderSession(fakeBackend());
    first.setDirectory(dir);
    await flush();
    await first.ensure("c1");
    first.dispose();
  }

  it("shows the folder's last data at once, then revalidates and replaces it", async () => {
    await loaded("/f");
    const gate = deferred<FolderComponentsPage>();
    const backend = fakeBackend({
      components: vi.fn(() => gate.promise),
      members: vi.fn(async () => memPage([["/f/a.png", "c1", "a"], ["/f/b.png", "c1", "b"]])),
      nodes: vi.fn(async () => nodePage([node("a", 0), node("b", 1, ["a"])])),
    });
    const second = createFolderSession(backend);
    second.setDirectory("/f");
    // Before any reply: no "Loading Trace…", the previous graph is shown.
    expect(second.status).toBe("ready");
    expect(second.index?.components.map((c) => c.id)).toEqual(["c1"]);
    expect(second.components.get("c1")?.nodes.map((n) => n.key)).toEqual(["a"]);
    expect(second.componentOf("/f/a.png")).toEqual({ componentId: "c1", key: "a" });
    expect(backend.components).toHaveBeenCalledTimes(1);
    // A component the view shows counts as loaded until the new index arrives.
    await second.ensure("c1");
    expect(backend.nodes).not.toHaveBeenCalled();

    gate.resolve(compPage("t2", ["c1"]));
    await flush(); await flush();
    expect(second.index?.token).toBe("t2");
    expect(second.componentOf("/f/b.png")).toEqual({ componentId: "c1", key: "b" });
    expect(second.components.get("c1")?.nodes.map((n) => n.key)).toEqual(["a", "b"]);
  });

  it("never shows one folder's data for another folder", async () => {
    await loaded("/f");
    const second = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    second.setDirectory("/g");
    expect(second.status).toBe("loading");
    expect(second.index).toBeNull();
    expect(second.components.size).toBe(0);
  });

  it("keeps the remembered data shown when revalidating fails, and reports why", async () => {
    await loaded("/f");
    const second = createFolderSession(fakeBackend({ components: vi.fn(async () => { throw new Error("backend went away"); }) }));
    second.setDirectory("/f");
    await flush();
    expect(second.status).toBe("ready");
    expect(second.error).toBe("backend went away");
    expect(second.components.get("c1")?.nodes.map((n) => n.key)).toEqual(["a"]);
  });

  it("does not remember what a disposed session loads afterwards", async () => {
    const gate = deferred<FolderComponentsPage>();
    const first = createFolderSession(fakeBackend({ components: vi.fn(() => gate.promise) }));
    first.setDirectory("/f");
    first.dispose();
    gate.resolve(compPage("t", ["c1"]));
    await flush();
    const second = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    second.setDirectory("/f");
    expect(second.status).toBe("loading");
    expect(second.index).toBeNull();
  });

  it("forgets every folder when the plugin is disabled", async () => {
    await loaded("/f");
    forgetFolderSnapshots();
    const second = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    second.setDirectory("/f");
    expect(second.status).toBe("loading");
  });

  it("keeps components that predate the folder's index marked stale across a remount", async () => {
    // Session 1 loads c1 and c2, then a refresh moves the index on while only c1 is wanted: c2 is kept but stale.
    let token = "t1";
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(token, ["c1", "c2"])),
      members: vi.fn(async () => memPage([["/f/a.png", "c1", "a"], ["/f/b.png", "c2", "b"]])),
      nodes: vi.fn(async (_d, _t, id) => nodePage([node(id === "c1" ? "a" : "b", 0)])),
    });
    const first = createFolderSession(backend);
    first.setDirectory("/f");
    await flush();
    await first.ensure("c1"); await first.ensure("c2");
    first.release("c2");
    token = "t2";
    await first.refresh(); await flush();
    expect(first.isStale("c2")).toBe(true);
    first.dispose();

    const second = createFolderSession(fakeBackend({ components: vi.fn(async () => { throw new Error("backend went away"); }) }));
    second.setDirectory("/f");
    await flush();
    // Revalidation failed, yet c2 is still known to predate the index: it is not taken as current.
    expect(second.isStale("c2")).toBe(true);
    expect(second.isStale("c1")).toBe(false);
  });

  it("restores each component's orientation, and never another folder's", async () => {
    const first = createFolderSession(fakeBackend());
    first.setDirectory("/f");
    await flush();
    await first.ensure("c1");
    first.orientations.set("c1", new Map([[92, "right"], [172, "down"]]));
    first.dispose();
    const back = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    back.setDirectory("/f");
    expect(back.orientations.get("c1")).toEqual(new Map([[92, "right"], [172, "down"]]));
    // The restored memory is this session's own: changing it does not rewrite the other's.
    back.orientations.set("c1", new Map([[92, "down"]]));
    expect(first.orientations.get("c1")).toEqual(new Map([[92, "right"], [172, "down"]]));
    const other = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    other.setDirectory("/g");
    expect(other.orientations.size).toBe(0);
  });

  it("merges what two panes on the same folder state loaded, so neither hides the other's components", async () => {
    const backend = () => fakeBackend({
      components: vi.fn(async () => compPage("t", ["c1", "c2"])),
      members: vi.fn(async () => memPage([["/f/a.png", "c1", "a"], ["/f/b.png", "c2", "b"]])),
      nodes: vi.fn(async (_d, _t, id) => nodePage([node(id === "c1" ? "a" : "b", 0)])),
    });
    const wide = createFolderSession(backend());
    const narrow = createFolderSession(backend());
    wide.setDirectory("/f"); narrow.setDirectory("/f");
    await flush();
    await wide.ensure("c1"); await wide.ensure("c2");
    await narrow.ensure("c1");
    const next = createFolderSession(fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    next.setDirectory("/f");
    expect([...next.components.keys()].sort()).toEqual(["c1", "c2"]);
  });

  it("writes nothing once the cache was cleared after the session began (the plugin was disabled)", async () => {
    const cache = createSnapshotCache<any>({ limit: 4 });
    const gate = deferred<FolderComponentsPage>();
    const session = createFolderSession(fakeBackend({ components: vi.fn(() => gate.promise) }), cache);
    session.setDirectory("/f");
    cache.clear();
    gate.resolve(compPage("t", ["c1"]));
    await flush(); await flush();
    expect(session.index?.token).toBe("t");
    expect(cache.recall("/f")).toBeUndefined();
  });

  it("never keeps a folder heavier than the memory budget", async () => {
    const cache = createSnapshotCache<any>({ limit: 4, budget: 1, weigh: () => 2 });
    const session = createFolderSession(fakeBackend(), cache);
    session.setDirectory("/f");
    await flush();
    expect(cache.recall("/f")).toBeUndefined();
  });
});

describe("artifact reveal resolution", () => {
  beforeEach(() => forgetFolderSnapshots());
  it("a reveal clears its own component's failure without clearing another unloaded component's failure", async () => {
    let failing = true;
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ["a", "b"])),
      nodes: vi.fn(async (_d, _t, id) => {
        if (failing) throw new Error(`${id} unavailable`);
        return nodePage([node(id, id === "b" ? 71 : 1)]);
      }),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    await Promise.all([session.ensure("a"), session.ensure("b")]);
    failing = false;
    const found = await session.resolveArtifact(71, new AbortController().signal);
    expect(found.componentId).toBe("b");
    expect(session.components.has("a")).toBe(false);
    expect(session.components.has("b")).toBe(true);
    expect(session.error).toBe("a unavailable");
    await session.ensure("a");
    expect(session.error).toBe("");
    session.dispose();
  });
  for (const cancellation of ["abort", "dispose", "change folder"] as const) {
    it(`settles a queued reveal promptly on ${cancellation} without waiting for occupied slots`, async () => {
      const ids = ["c1", "c2", "c3", "c4"];
      const gate = deferred<ComponentNodesPage>();
      const backend = fakeBackend({
        components: vi.fn(async () => compPage("t1", ids)),
        nodes: vi.fn(() => gate.promise),
      });
      const session = createFolderSession(backend);
      session.setDirectory("/f"); await flush();
      const reads = ids.map((id) => session.ensure(id));
      const controller = new AbortController();
      let outcome = "pending";
      const reveal = session.resolveArtifact(71, controller.signal)
        .then(() => { outcome = "completed"; }, (error: Error) => { outcome = error.name; });
      try {
        await flush();
        expect(backend.nodes).toHaveBeenCalledTimes(4);
        if (cancellation === "abort") controller.abort();
        else if (cancellation === "dispose") session.dispose();
        else session.setDirectory("/other");
        await flush();
        expect(outcome).toBe("AbortError");
        expect(session.components.size).toBe(0);
        expect(backend.nodes).toHaveBeenCalledTimes(4);
      } finally {
        gate.resolve(nodePage([node("a", 1)]));
        await Promise.all([...reads, reveal]);
        session.dispose();
      }
      expect(backend.nodes).toHaveBeenCalledTimes(4);
    });
  }
  it("finds an unlisted artifact after its component merged, using a fresh index", async () => {
    let merged = false;
    const image = { ...node("o:9:0", 71), temporary: true, path: "/private/generated/image.png" };
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(merged ? "new" : "old", merged ? ["merged"] : ["old"])),
      members: vi.fn(async () => memPage([])),
      nodes: vi.fn(async (_d, _t, id) => nodePage(id === "merged" ? [image] : [])),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    merged = true;
    const found = await session.resolveArtifact(71, new AbortController().signal);
    expect(found).toEqual({ node: image, componentId: "merged" });
    expect(session.components.get(found.componentId)?.dag.nodes.get(image.key)).toEqual(image);
  });
  it("aborting an in-flight index request never publishes its data or continues loading", async () => {
    const backend = fakeBackend();
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const gate = deferred<FolderComponentsPage>();
    backend.components.mockImplementation(() => gate.promise);
    const controller = new AbortController();
    const task = session.resolveArtifact(71, controller.signal);
    controller.abort();
    gate.resolve(compPage("new", ["new"]));
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(session.index?.token).toBe("t1");
    expect(session.components.size).toBe(0);
    expect(backend.nodes).not.toHaveBeenCalled();
  });
  it("aborting during component paging does not commit a partial component", async () => {
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    const controller = new AbortController();
    const task = session.resolveArtifact(71, controller.signal);
    await flush();
    controller.abort();
    gate.resolve(nodePage([node("generated", 71)], 2));
    await expect(task).rejects.toMatchObject({ name: "AbortError" });
    expect(session.components.size).toBe(0);
    expect(backend.nodes).toHaveBeenCalledTimes(1);
  });
  it("retries a stale snapshot and rejects absent, discarded and missing images clearly", async () => {
    let reads = 0;
    const backend = fakeBackend({ nodes: vi.fn(async () => ++reads === 1 ? nodePage([], 0, true) : nodePage([node("target", 71)])) });
    const session = createFolderSession(backend);
    session.setDirectory("/f"); await flush();
    expect((await session.resolveArtifact(71, new AbortController().signal)).node.artifactId).toBe(71);
    for (const patch of [{ discarded: true }, { state: "missing" as const }, { earlierRevision: true }]) {
      backend.nodes.mockImplementation(async () => nodePage([{ ...node("target", 71), ...patch }]));
      await expect(session.resolveArtifact(71, new AbortController().signal)).rejects.toThrow("no longer exists");
    }
    await expect(session.resolveArtifact(999, new AbortController().signal)).rejects.toThrow("no longer exists");
  });
});

it("reveal follows an index refresh that races its component load", async () => {
  forgetFolderSnapshots();
  let merged = false;
  const gate = deferred<ComponentNodesPage>();
  const image = node("generated", 71);
  const backend = fakeBackend({
    components: vi.fn(async () => compPage(merged ? "t2" : "t1", merged ? ["merged"] : ["original"])),
    members: vi.fn(async () => memPage([])),
    nodes: vi.fn(async (_d, _t, id) => id === "original" ? gate.promise : nodePage([image])),
  });
  const session = createFolderSession(backend);
  session.setDirectory("/f"); await flush();
  const revealing = session.resolveArtifact(71, new AbortController().signal);
  await flush();
  merged = true;
  await session.refresh();
  gate.resolve(nodePage([image]));
  expect(await revealing).toEqual({ node: image, componentId: "merged" });
});

describe("pane and folder open-stack snapshots", () => {
  beforeEach(() => forgetFolderSnapshots());
  const stackSummary = (id: string, path: string, coverKey: string) => ({ ...summary(id), cover: { path, present: true }, coverKey });
  const initial = [stackSummary("left", "/f/a.png", "a"), stackSummary("right", "/f/b.png", "b")];
  const backendFor = (components = initial, members: [string, string, string][] = [["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]]) => fakeBackend({
    components: vi.fn(async () => ({ ...compPage("t", []), components, total: components.length })),
    members: vi.fn(async () => memPage(members)),
    nodes: vi.fn(async (_d, _t, id) => nodePage([node(id === "right" ? "b" : "a", 0)])),
  });
  const sessionFor = (pane: string, backend: TraceBackend = backendFor()) => createFolderSession(backend, undefined, pane);

  it("restores two open stacks and their loaded tiles synchronously before revalidation", async () => {
    const first = sessionFor("pane-a");
    first.setDirectory("/f"); await flush();
    first.setStackOpen("left", true); first.setStackOpen("right", true);
    await first.ensure("left"); await first.ensure("right");
    first.dispose();
    const back = sessionFor("pane-a", fakeBackend({ components: vi.fn(() => new Promise<FolderComponentsPage>(() => {})) }));
    back.setDirectory("/f");
    expect(back.status).toBe("ready");
    expect(back.openStackKeys).toEqual(new Set(["a", "b"]));
    expect(back.components.get("left")?.nodes.map((node) => node.key)).toEqual(["a"]);
    expect(back.components.get("right")?.nodes.map((node) => node.key)).toEqual(["b"]);
    back.dispose();
  });

  it("keeps panes independent while sharing loaded data, and clears history on folder changes", async () => {
    const left = sessionFor("pane-a"), right = sessionFor("pane-b");
    left.setDirectory("/f"); right.setDirectory("/f"); await flush();
    left.setStackOpen("left", true); right.setStackOpen("right", true);
    await left.ensure("left"); await right.ensure("right");
    left.dispose(); right.dispose();
    for (const [pane, keys] of [["pane-a", ["a"]], ["pane-b", ["b"]], ["pane-c", []]] as const) {
      const back = sessionFor(pane);
      back.setDirectory("/f");
      expect(back.openStackKeys).toEqual(new Set(keys));
      back.dispose();
    }
    const back = sessionFor("pane-a");
    back.setDirectory("/g"); await flush();
    expect(back.openStackKeys.size).toBe(0);
    back.setDirectory("/f");
    expect(back.openStackKeys.size).toBe(0);
    back.dispose();
    const remount = sessionFor("pane-a");
    remount.setDirectory("/f");
    expect(remount.openStackKeys.size).toBe(0);
    remount.dispose();
    const otherPane = sessionFor("pane-b");
    otherPane.setDirectory("/f");
    expect(otherPane.openStackKeys).toEqual(new Set(["b"]));
    otherPane.dispose();
  });

  it("refresh resolves old covers into merged components, splits them again and reopens disappeared covers", async () => {
    let components = initial;
    let members: [string, string, string][] = [["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]];
    const backend = backendFor();
    backend.components.mockImplementation(async () => ({ ...compPage("t", []), components, total: components.length }));
    backend.members.mockImplementation(async () => memPage(members));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("right", true);
    components = [stackSummary("merged", "/f/a.png", "a")];
    members = [["/f/a.png", "merged", "a"], ["/f/b.png", "merged", "b"]];
    await session.refresh();
    expect(session.openStackKeys).toEqual(new Set(["a"]));
    components = initial; members = [["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]];
    await session.refresh();
    expect(session.openStackKeys).toEqual(new Set(["b"]));
    components = [stackSummary("replacement", "/f/a.png", "a")];
    members = [["/f/a.png", "replacement", "a"]];
    await session.refresh();
    expect(session.openStackKeys.size).toBe(0);
    components = initial; members = [["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]];
    await session.refresh();
    expect(session.openStackKeys).toEqual(new Set(["b"]));
    session.dispose();
  });

  it("a stack whose original image is deleted stays open while an edit survives", async () => {
    const stack = { ...summary("s"), cover: { path: "/f/a.png", present: false }, coverKey: "a", imageCount: 1, nodeCount: 2 };
    const backend = backendFor([stack], [["/f/b.png", "s", "b"]]);
    backend.nodes.mockResolvedValue(nodePage([{ ...node("a", 1), state: "missing" }, node("b", 2, ["a"])]));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("s", true); await session.ensure("s"); await flush();
    expect(session.openStackKeys).toEqual(new Set(["a"]));
    session.setStackOpen("s", false);
    expect(session.openStackKeys.size).toBe(0);
    session.dispose();
  });

  describe("a stack whose cover file is deleted and restored", () => {
    const present = { ...summary("s"), cover: { path: "/f/a.png", present: true }, coverKey: "a", imageCount: 2, nodeCount: 2 };
    const gone = { ...present, cover: { path: "/f/a.png", present: false }, imageCount: 1 };
    const both: [string, string, string][] = [["/f/a.png", "s", "a"], ["/f/b.png", "s", "b"]];
    const only: [string, string, string][] = [["/f/b.png", "s", "b"]];
    const nodes = (cover: "present" | "missing") => nodePage([{ ...node("a", 1), state: cover }, node("b", 2, ["a"])]);
    async function show(session: ReturnType<typeof sessionFor>, backend: ReturnType<typeof backendFor>, cover: "present" | "missing") {
      backend.components.mockResolvedValue({ ...compPage("t" + Math.random(), []), components: [cover === "present" ? present : gone], total: 1 });
      backend.members.mockResolvedValue(memPage(cover === "present" ? both : only));
      backend.nodes.mockResolvedValue(nodes(cover));
      await session.refresh(); await session.ensure("s"); await flush();
    }
    it("stays open when its cover is deleted, and stays closed after an explicit close when it returns", async () => {
      const backend = backendFor([present], both);
      backend.nodes.mockResolvedValue(nodes("present"));
      const session = sessionFor("pane", backend);
      session.setDirectory("/f"); await flush();
      session.setStackOpen("s", true); await session.ensure("s");
      expect(session.openStackKeys).toEqual(new Set(["a"]));
      await show(session, backend, "missing");
      expect(session.openStackKeys).toEqual(new Set(["a"]));
      session.setStackOpen("s", false);
      await show(session, backend, "present");
      expect(session.openStackKeys.size).toBe(0);
      session.dispose();
    });
    it("is forgotten entirely by a close made while the cover is missing", async () => {
      const backend = backendFor([present], both);
      backend.nodes.mockResolvedValue(nodes("present"));
      const session = sessionFor("pane", backend);
      session.setDirectory("/f"); await flush();
      session.setStackOpen("s", true); await session.ensure("s");
      await show(session, backend, "missing");
      session.setStackOpen("s", false);
      session.setStackOpen("s", true);
      session.setStackOpen("s", false);
      await show(session, backend, "present");
      expect(session.openStackKeys.size).toBe(0);
      session.dispose();
    });
    it("reopens through the cover's path when only that identity is remembered by an earlier snapshot of the folder", async () => {
      const backend = backendFor([present], both);
      backend.nodes.mockResolvedValue(nodes("present"));
      const session = sessionFor("pane", backend);
      session.setDirectory("/f"); await flush();
      session.setStackOpen("s", true);
      await show(session, backend, "missing");
      await show(session, backend, "present");
      expect(session.openStackKeys).toEqual(new Set(["a"]));
      session.dispose();
    });
  });

  it("reopens a resumed unsaved placeholder and forgets it after an explicit close", async () => {
    const backend = backendFor([summary("o:7:0")], []);
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: null, state: "running", temporary: true }]));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("o:7:0", true); await session.ensure("o:7:0");
    for (const open of [true, false]) {
      backend.components.mockResolvedValue(compPage("dismissed", []));
      await session.refresh();
      expect(session.openStackKeys.size).toBe(0);
      backend.components.mockResolvedValue(compPage("resumed", ["o:7:0"]));
      await session.refresh(); await flush();
      expect(session.openStackKeys).toEqual(new Set(open ? ["o:7:0"] : []));
      session.setStackOpen("o:7:0", false);
    }
    session.dispose();
  });

  it("evicts the oldest missing cover while keeping a recently reopened cover", async () => {
    const keys = Array.from({ length: MAX_UNRESOLVED_OPEN_STACKS + 1 }, (_, i) => `o:${i}:0`);
    const backend = backendFor(keys.map(summary), []);
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    for (const key of keys) session.setStackOpen(key, true);
    session.setStackOpen(keys[0], true);
    backend.components.mockResolvedValue(compPage("missing", []));
    await session.refresh();
    expect(session.openStackKeys.size).toBe(0);
    backend.components.mockResolvedValue(compPage("restored", keys));
    await session.refresh();
    expect(session.openStackKeys).toEqual(new Set([keys[0], ...keys.slice(2)]));
    session.dispose();
  });

  it("forgets unresolved identities on folder changes, including navigation through no folder", async () => {
    const backend = backendFor();
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("right", true);
    backend.components.mockResolvedValue(compPage("missing", []));
    backend.members.mockResolvedValue(memPage([]));
    await session.refresh();
    session.setDirectory(null);
    backend.components.mockResolvedValue({ ...compPage("restored", []), components: initial, total: 2 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]]));
    session.setDirectory("/f"); await flush();
    expect(session.openStackKeys.size).toBe(0);
    session.dispose();
  });

  it("closing a merged stack forgets all predecessor covers", async () => {
    const backend = backendFor();
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("left", true); session.setStackOpen("right", true);
    backend.components.mockResolvedValue({ ...compPage("new", []), components: [stackSummary("merged", "/f/a.png", "a")], total: 1 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "merged", "a"], ["/f/b.png", "merged", "b"]]));
    await session.refresh();
    session.setStackOpen("merged", false);
    backend.components.mockResolvedValue({ ...compPage("split", []), components: initial, total: 2 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]]));
    await session.refresh();
    expect(session.openStackKeys.size).toBe(0);
    session.dispose();
  });

  it("closing a merged stack forgets a predecessor absent from current nodes, including across remounts", async () => {
    const backend = backendFor();
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("left", true); session.setStackOpen("right", true);
    backend.components.mockResolvedValue({ ...compPage("merged", []), components: [stackSummary("merged", "/f/b.png", "b")], total: 1 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "merged", "a"], ["/f/b.png", "merged", "b"]]));
    await session.refresh();
    backend.members.mockResolvedValue(memPage([["/f/b.png", "merged", "b"]]));
    backend.nodes.mockResolvedValue(nodePage([node("b", 0)]));
    await session.refresh();
    expect(session.openStackKeys).toEqual(new Set(["b"]));
    session.dispose();
    const back = sessionFor("pane", backend);
    back.setDirectory("/f"); await flush();
    back.setStackOpen("merged", false);
    backend.components.mockResolvedValue({ ...compPage("restored", []), components: initial, total: 2 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "left", "a"], ["/f/b.png", "right", "b"]]));
    await back.refresh();
    expect(back.openStackKeys.size).toBe(0);
    back.dispose();
  });

  it("opens new external selections and remembers a deliberate close across remounts", async () => {
    const session = sessionFor("pane");
    session.setDirectory("/f"); await flush();
    session.followSelection("selected-b", new Set(["right"]));
    expect(session.openStackKeys).toEqual(new Set(["b"]));
    session.setStackOpen("right", false); session.dispose();
    const back = sessionFor("pane");
    back.setDirectory("/f");
    back.followSelection("selected-b", new Set(["right"]));
    expect(back.openStackKeys.size).toBe(0);
    await back.refresh();
    back.followSelection("selected-a", new Set(["left"]));
    expect(back.openStackKeys).toEqual(new Set(["a"]));
    back.followSelection("selected-b", new Set(["right"]));
    expect(back.openStackKeys).toEqual(new Set(["a", "b"]));
    back.dispose();
  });

  describe("explicit expansion", () => {
    // left: a → b → c, with a second child d of a.
    const tree = () => fakeBackend({
      components: vi.fn(async () => ({ ...compPage("t", []), components: [stackSummary("left", "/f/a.png", "a")], total: 1 })),
      members: vi.fn(async () => memPage([["/f/a.png", "left", "a"]])),
      nodes: vi.fn(async () => nodePage([node("a", 0), node("b", 1, ["a"]), node("c", 2, ["b"]), node("d", 3, ["a"])])),
    });

    it("a view's own selection opens, reveals and expands nothing; an outside one opens and reveals once per new focus", async () => {
      const session = sessionFor("pane", tree());
      session.setDirectory("/f"); await flush();
      await session.ensure("left");
      session.adoptSelection("own", new Set(["left"]), "d");
      session.followSelection("own", new Set(["left"]), "d");
      expect(session.openStackKeys.size).toBe(0);
      expect(session.expansion.reveal).toBeNull();
      session.followSelection("outside", new Set(["left"]), "c");
      expect(session.openStackKeys).toEqual(new Set(["a"]));
      expect(session.expansion.reveal).toBe("c");
      expect(session.isExpanded("b", "left")).toBe(true);
      // Collapsing an ancestor hides it; a re-issued target (same focus, new choice) does not reveal it again.
      expect(session.toggleExpansion("b", "left")).toBe(true);
      expect(session.isExpanded("b", "left")).toBe(false);
      session.followSelection("outside, re-issued", new Set(["left"]), "c");
      expect(session.isExpanded("b", "left")).toBe(false);
      session.dispose();
    });

    it("expands on a first click only what has children and is collapsed", async () => {
      const session = sessionFor("pane", tree());
      session.setDirectory("/f"); await flush();
      await session.ensure("left");
      const before = session.expansion;
      session.expandNode("c", "left");
      session.expandNode("a", "left");
      expect(session.expansion, "a leaf and the cover change nothing").toBe(before);
      session.expandNode("b", "left");
      expect(session.isExpanded("b", "left")).toBe(true);
      session.dispose();
    });

    it("persists with the pane across remounts, forgets on navigation, and drops nodes that are gone", async () => {
      const backend = tree();
      const first = sessionFor("pane", backend);
      first.setDirectory("/f"); await flush();
      await first.ensure("left");
      first.toggleExpansion("b", "left");
      first.dispose();
      const back = sessionFor("pane", backend);
      back.setDirectory("/f");
      expect(back.expansion.choices.get("b")).toBe(true);
      await flush(); await back.ensure("left");
      // b is deleted: a refresh of its (loaded) component drops the choice.
      backend.nodes.mockImplementation(async () => nodePage([node("a", 0), node("d", 3, ["a"])]));
      backend.components.mockImplementation(async () => ({ ...compPage("t2", []), components: [stackSummary("left", "/f/a.png", "a")], total: 1 }));
      await back.refresh(); await flush(); await back.ensure("left"); await flush();
      expect(back.expansion.choices.has("b")).toBe(false);
      back.toggleExpansion("d", "left");
      back.setDirectory("/g"); await flush();
      back.setDirectory("/f");
      expect(back.expansion.choices.size).toBe(0);
      back.dispose();
    });
  });

  it("keeps stacks with a shared reference title independently open", async () => {
    const components = [stackSummary("first", "/outside/style.png", "o:2:0"), stackSummary("second", "/outside/style.png", "o:3:0")];
    const backend = backendFor(components, []);
    backend.nodes.mockImplementation(async (_d, _t, id) => nodePage([{ ...node(id === "first" ? "o:2:0" : "o:3:0", 0), path: null, state: "running" }]));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("first", true);
    expect(session.openStackKeys).toEqual(new Set(["o:2:0"]));
    session.setStackOpen("second", true);
    expect(session.openStackKeys).toEqual(new Set(["o:2:0", "o:3:0"]));
    session.setStackOpen("first", false);
    expect(session.openStackKeys).toEqual(new Set(["o:3:0"]));
    session.dispose();
    const back = sessionFor("pane", backend);
    back.setDirectory("/f");
    expect(back.openStackKeys).toEqual(new Set(["o:3:0"]));
    back.dispose();
  });

  it("keeps a missing unlisted revision closed until it returns, and an explicit close forgets it", async () => {
    const backend = backendFor([stackSummary("draft", "/managed/draft.png", "o:7:0")], []);
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: "/managed/draft.png", temporary: true }]));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("draft", true); await session.ensure("draft");
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: "/managed/draft.png", state: "missing" }]));
    await session.refresh(); await flush();
    expect(session.openStackKeys.size).toBe(0);
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: "/managed/draft.png", temporary: true }]));
    await session.refresh(); await flush();
    expect(session.openStackKeys).toEqual(new Set(["o:7:0"]));
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: "/managed/draft.png", state: "missing" }]));
    await session.refresh(); await flush();
    // The toggle is still available even though the drawn cover is missing.
    session.setStackOpen("draft", false);
    backend.nodes.mockResolvedValue(nodePage([{ ...node("o:7:0", 7), path: "/managed/draft.png", temporary: true }]));
    await session.refresh(); await session.ensure("draft");
    expect(session.openStackKeys.size).toBe(0);
    session.dispose();
  });

  it("resolves an unlisted cover through fresh nodes after its component merges", async () => {
    const backend = backendFor([stackSummary("draft", "/managed/draft.png", "o:7:0")], []);
    const draft = { ...node("o:7:0", 7), path: "/managed/draft.png", temporary: true };
    backend.nodes.mockResolvedValue(nodePage([draft]));
    const session = sessionFor("pane", backend);
    session.setDirectory("/f"); await flush();
    session.setStackOpen("draft", true); await session.ensure("draft");
    backend.components.mockResolvedValue({ ...compPage("new", []), components: [stackSummary("merged", "/f/a.png", "a")], total: 1 });
    backend.members.mockResolvedValue(memPage([["/f/a.png", "merged", "a"]]));
    backend.nodes.mockResolvedValue(nodePage([node("a", 0), draft]));
    await session.refresh(); await flush();
    expect(session.openStackKeys).toEqual(new Set(["a"]));
    backend.nodes.mockResolvedValue(nodePage([node("a", 0)]));
    await session.refresh(); await flush();
    expect(session.openStackKeys.size).toBe(0);
    session.dispose();
  });
});

describe("acquireComponents", () => {
  beforeEach(() => forgetFolderSnapshots());
  const ready = async (backend: ReturnType<typeof fakeBackend>) => {
    const session = createFolderSession(backend);
    session.setDirectory("/f");
    await flush();
    return session;
  };
  const outcome = <T,>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: Error) => ({ error }));

  it("resolves complete components, paged, stamped with the index's directory and token", async () => {
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t9", ["c1"])),
      nodes: vi.fn(async (_d, _t, _c, offset) => offset === 0 ? nodePage([node("a", 0), node("b", 1)], 3) : nodePage([node("c", 2)], 3)),
    });
    const session = await ready(backend);
    const lease = session.acquireComponents(["c1"], "t9");
    const data = (await lease.results).get("c1")!;
    expect(data.nodes.map((n) => n.key)).toEqual(["a", "b", "c"]);
    expect(data).toMatchObject({ directory: "/f", token: "t9" });
    expect(session.components.get("c1")).toBe(data);
    lease.release();
    session.dispose();
  });

  it("handles empty, duplicate and unknown ids", async () => {
    const backend = fakeBackend({ components: vi.fn(async () => compPage("t1", ["c1", "c2"])) });
    const session = await ready(backend);
    expect((await session.acquireComponents([], "t1").results).size).toBe(0);
    expect(backend.nodes).not.toHaveBeenCalled();
    const unknown = await outcome(session.acquireComponents(["c1", "nope"], "t1").results);
    expect(unknown).toMatchObject({ error: { message: expect.stringContaining("nope") } });
    expect(backend.nodes).not.toHaveBeenCalled();
    const duplicated = await session.acquireComponents(["c2", "c1", "c2"], "t1").results;
    expect([...duplicated.keys()]).toEqual(["c2", "c1"]);
    expect(backend.nodes).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it("returns already-loaded fresh data without another read", async () => {
    const backend = fakeBackend();
    const session = await ready(backend);
    await session.ensure("c1");
    const data = (await session.acquireComponents(["c1"], "t1").results).get("c1");
    expect(data).toBe(session.components.get("c1"));
    expect(backend.nodes).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("rejects a token that is not the index's, without reading", async () => {
    const backend = fakeBackend();
    const session = await ready(backend);
    expect((await outcome(session.acquireComponents(["c1"], "old").results)).error).toBeInstanceOf(StaleComponentsError);
    expect(backend.nodes).not.toHaveBeenCalled();
    // Before any index exists there is no token to match.
    const empty = createFolderSession(fakeBackend());
    expect((await outcome(empty.acquireComponents(["c1"], "t1").results)).error).toBeInstanceOf(StaleComponentsError);
    empty.dispose(); session.dispose();
  });

  it("rejects data read under a token that changed mid-read, even when the old read completes", async () => {
    let token = "t1";
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(token, ["c1"])),
      nodes: vi.fn(() => gate.promise),
    });
    const session = await ready(backend);
    const lease = session.acquireComponents(["c1"], "t1");
    const result = outcome(lease.results);
    await flush();
    token = "t2";
    await session.refresh();
    gate.resolve(nodePage([node("old", 0)]));
    expect((await result).error).toBeInstanceOf(StaleComponentsError);
    // The old-token page never became the component's data.
    await flush();
    expect(session.components.get("c1")?.token).toBe("t2");
    session.dispose();
  });

  it("rejects when a stale page makes the session refresh to a new token", async () => {
    let token = "t1";
    const backend = fakeBackend({
      components: vi.fn(async () => compPage(token, ["c1"])),
      nodes: vi.fn(async (_d, t) => { if (t === "t1") { token = "t2"; return nodePage([], 0, true); } return nodePage([node("a", 0)]); }),
    });
    const session = await ready(backend);
    expect((await outcome(session.acquireComponents(["c1"], "t1").results)).error).toBeInstanceOf(StaleComponentsError);
    const retry = await session.acquireComponents(["c1"], "t2").results;
    expect(retry.get("c1")?.token).toBe("t2");
    session.dispose();
  });

  it("propagates a real read error that ensure swallows", async () => {
    const backend = fakeBackend({ nodes: vi.fn(async () => { throw new Error("disk on fire"); }) });
    const session = await ready(backend);
    const failed = await outcome(session.acquireComponents(["c1"], "t1").results);
    expect(failed.error?.message).toBe("disk on fire");
    expect(session.error).toBe("disk on fire");
    await expect(session.ensure("c1")).resolves.toBeUndefined();
    session.dispose();
  });

  it("fails the whole lease when one of several components fails", async () => {
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ["a", "b"])),
      nodes: vi.fn(async (_d, _t, id) => { if (id === "b") throw new Error("b broke"); return nodePage([node("a", 0)]); }),
    });
    const session = await ready(backend);
    expect((await outcome(session.acquireComponents(["a", "b"], "t1").results)).error?.message).toBe("b broke");
    session.dispose();
  });

  it("shares one read between independent interests", async () => {
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
    const session = await ready(backend);
    const a = session.acquireComponents(["c1"], "t1");
    const b = session.acquireComponents(["c1"], "t1");
    const viewed = session.ensure("c1");
    gate.resolve(nodePage([node("a", 0)]));
    const [first, second] = await Promise.all([a.results, b.results, viewed]);
    expect(backend.nodes).toHaveBeenCalledTimes(1);
    expect(first.get("c1")).toBe(second.get("c1"));
    session.dispose();
  });

  describe("cancellation", () => {
    // The request limiter is shared by the whole module: never leave a test's reads occupying its slots.
    const gates: Array<{ resolve: (page: ComponentNodesPage) => void }> = [];
    afterEach(async () => {
      for (const gate of gates.splice(0)) gate.resolve(nodePage([node("done", 0)]));
      await flush();
    });
    // Four reads occupy the shared request slots, so a fifth component queues.
    const queued = async () => {
      const ids = ["c1", "c2", "c3", "c4", "c5"];
      const gate = deferred<ComponentNodesPage>();
      gates.push(gate);
      const backend = fakeBackend({ components: vi.fn(async () => compPage("t1", ids)), nodes: vi.fn(() => gate.promise) });
      const session = await ready(backend);
      const occupying = ids.slice(0, 4).map((id) => session.ensure(id));
      return { session, backend, gate, occupying, requested: () => backend.nodes.mock.calls.map((call) => call[2]) };
    };

    it("aborts a queued read once its last interest disappears", async () => {
      const { session, gate, occupying, requested } = await queued();
      const first = new AbortController(), second = new AbortController();
      const a = outcome(session.acquireComponents(["c5"], "t1", first.signal).results);
      const b = outcome(session.acquireComponents(["c5"], "t1", second.signal).results);
      first.abort();
      expect((await a).error?.name).toBe("AbortError");
      second.abort();
      expect((await b).error?.name).toBe("AbortError");
      gate.resolve(nodePage([node("a", 0)]));
      await Promise.all(occupying);
      expect(requested()).toEqual(["c1", "c2", "c3", "c4"]);
      expect(session.components.has("c5")).toBe(false);
      session.dispose();
    });

    it("keeps a read other interests still want, and a cancelled interest does not affect them", async () => {
      const { session, gate, occupying, requested } = await queued();
      const cancelled = new AbortController();
      const doomed = outcome(session.acquireComponents(["c5"], "t1", cancelled.signal).results);
      const kept = session.acquireComponents(["c5", "c1"], "t1");
      cancelled.abort();
      expect((await doomed).error?.name).toBe("AbortError");
      gate.resolve(nodePage([node("a", 0)]));
      const data = await kept.results;
      await Promise.all(occupying);
      expect([...data.keys()]).toEqual(["c5", "c1"]);
      expect(requested().filter((id) => id === "c5")).toHaveLength(1);
      session.dispose();
    });

    it("lets the view's own interest keep a read alive after a lease releases", async () => {
      const { session, gate, occupying } = await queued();
      const viewed = session.ensure("c5");
      const lease = session.acquireComponents(["c5"], "t1");
      const result = outcome(lease.results);
      lease.release();
      expect((await result).error?.name).toBe("AbortError");
      gate.resolve(nodePage([node("a", 0)]));
      await Promise.all([...occupying, viewed]);
      expect(session.components.has("c5")).toBe(true);
      session.dispose();
    });

    it("does nothing when the signal is already aborted", async () => {
      const backend = fakeBackend();
      const session = await ready(backend);
      const controller = new AbortController();
      controller.abort(new Error("never mind"));
      const lease = session.acquireComponents(["c1"], "t1", controller.signal);
      expect((await outcome(lease.results)).error?.message).toBe("never mind");
      await flush();
      expect(backend.nodes).not.toHaveBeenCalled();
      // A refresh does not reload what nobody wants.
      await session.refresh();
      expect(backend.nodes).not.toHaveBeenCalled();
      session.dispose();
    });

    it("rejects pending leases when the folder changes or the session is disposed", async () => {
      for (const end of ["folder", "dispose"] as const) {
        const gate = deferred<ComponentNodesPage>();
        const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
        const session = await ready(backend);
        const result = outcome(session.acquireComponents(["c1"], "t1").results);
        await flush();
        if (end === "folder") session.setDirectory("/other"); else session.dispose();
        expect((await result).error).toBeDefined();
        gate.resolve(nodePage([node("a", 0)]));
        await flush();
        expect(session.components.has("c1")).toBe(false);
        session.dispose();
      }
    });
  });

  it("survives refreshes that keep the same token, reissuing its read", async () => {
    const gate = deferred<ComponentNodesPage>();
    const backend = fakeBackend({ nodes: vi.fn(() => gate.promise) });
    const session = await ready(backend);
    const lease = session.acquireComponents(["c1"], "t1");
    const result = outcome(lease.results);
    for (let i = 0; i < 6; i++) { await session.refresh(); await flush(); }
    gate.resolve(nodePage([node("a", 0)]));
    const settledResult = await result;
    expect(settledResult.error).toBeUndefined();
    expect(settledResult.value?.get("c1")?.token).toBe("t1");
    expect(session.isStale("c1")).toBe(false);
    session.dispose();
  });

  it("re-acquires an earlier component a same-token refresh outdated while a later one was loading", async () => {
    const gate = deferred<ComponentNodesPage>();
    const reload = deferred<ComponentNodesPage>();
    let aReads = 0;
    const backend = fakeBackend({
      components: vi.fn(async () => compPage("t1", ["a", "b"])),
      nodes: vi.fn((_d, _t, id) => id === "b" ? gate.promise : ++aReads === 1 ? Promise.resolve(nodePage([node("a", 0)])) : reload.promise),
    });
    const session = await ready(backend);
    const result = outcome(session.acquireComponents(["a", "b"], "t1").results);
    await flush();
    await session.refresh();
    await flush();
    gate.resolve(nodePage([node("b", 1)]));
    await flush();
    reload.resolve(nodePage([node("a", 2)]));
    const settledResult = await result;
    expect(settledResult.error).toBeUndefined();
    expect([...settledResult.value!.keys()]).toEqual(["a", "b"]);
    expect(session.isStale("a")).toBe(false);
    session.dispose();
  });

  it("does not raise an unhandled rejection when a released lease is dropped unawaited", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", record);
    try {
      const gate = deferred<ComponentNodesPage>();
      const session = await ready(fakeBackend({ nodes: vi.fn(() => gate.promise) }));
      session.acquireComponents(["c1"], "t1").release();
      await flush(); await flush();
      gate.resolve(nodePage([node("a", 0)]));
      await flush();
      expect(unhandled).toEqual([]);
      session.dispose();
    } finally { process.off("unhandledRejection", record); }
  });

  it("never lets a read under a replaced index's token commit after a snapshot restore", async () => {
    await (async () => {
      const first = createFolderSession(fakeBackend({ components: vi.fn(async () => compPage("t1", ["c1", "c2"])) }));
      first.setDirectory("/f"); await flush(); await first.ensure("c1"); first.dispose();
    })();
    const indexGate = deferred<FolderComponentsPage>();
    const oldRead = deferred<ComponentNodesPage>();
    const newRead = deferred<ComponentNodesPage>();
    const backend = fakeBackend({
      components: vi.fn(() => indexGate.promise),
      nodes: vi.fn((_d, token) => token === "t1" ? oldRead.promise : newRead.promise),
    });
    const session = createFolderSession(backend);
    session.setDirectory("/f");              // restores the t1 snapshot, revalidating in the background
    expect(session.index?.token).toBe("t1");
    const reading = session.ensure("c2");    // reads c2 under t1 ...
    indexGate.resolve(compPage("t2", ["c1", "c2"]));
    await flush();                            // ... while the t2 index replaces it
    expect(session.index?.token).toBe("t2");
    oldRead.resolve(nodePage([node("old", 0)]));
    await flush();
    expect(session.components.has("c2")).toBe(false);
    newRead.resolve(nodePage([node("new", 1)]));
    await reading; await flush();
    expect(session.components.get("c2")).toMatchObject({ token: "t2" });
    expect(session.components.get("c2")!.nodes.map((n) => n.key)).toEqual(["new"]);
    session.dispose();
  });

  it("keeps a held lease's components reloading across refreshes until it is released", async () => {
    let token = "t1";
    const backend = fakeBackend({ components: vi.fn(async () => compPage(token, ["c1"])) });
    const session = await ready(backend);
    const lease = session.acquireComponents(["c1"], "t1");
    const first = (await lease.results).get("c1")!;
    token = "t2";
    await session.refresh();
    await flush();
    const second = session.components.get("c1")!;
    expect(second.token).toBe("t2");
    expect(second.version).toBeGreaterThan(first.version);
    lease.release();
    token = "t3";
    await session.refresh();
    await flush();
    expect(session.components.get("c1")?.token).toBe("t2");
    expect(session.isStale("c1")).toBe(true);
    session.dispose();
  });
});
