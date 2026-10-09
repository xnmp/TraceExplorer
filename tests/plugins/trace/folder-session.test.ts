import "./svelte-host";
import { describe, it, expect, vi } from "vitest";
import { createFolderSession } from "$lib/plugins/trace/view/folder-session.svelte";
import type { TraceBackend } from "$lib/plugins/trace/view/backend";
import type { ComponentNodesPage, FolderComponentsPage, FolderMembersPage } from "$lib/api/trace";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const summary = (id: string) => ({ id, title: id, cover: null, imageCount: 1, nodeCount: 1, active: false, unsaved: false });
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
