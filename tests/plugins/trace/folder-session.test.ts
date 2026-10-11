import "./svelte-host";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { createFolderSession, forgetFolderSnapshots } from "$lib/plugins/trace/view/folder-session.svelte";
import { createSnapshotCache } from "$lib/plugins/trace/view/folder-snapshots";
import type { TraceBackend } from "$lib/plugins/trace/view/backend";
import type { ComponentNodesPage, FolderComponentsPage, FolderMembersPage } from "$lib/api/trace";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import { locateTarget } from "$lib/plugins/trace/view/target-location";
import { withNativeRequestCapacity } from "../../../e2e/harness/request-capacity";

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
