import "./svelte-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLineageSubscriptions, loadFolderLineage, lineageContribution, registerLineage, LINEAGE_ID } from "$lib/plugins/trace/lineage";
import { SVELTE_ABI } from "../../../src/sdk";
import type { TraceBackend } from "$lib/plugins/trace/view/backend";
import type { TraceNodeRecord } from "$lib/api/trace";

const g = globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: Record<string, unknown> };
const original = g.__TAURI_EXPLORER_PLUGIN_SDK__;
const announce = (capabilities: string[] | undefined) => { g.__TAURI_EXPLORER_PLUGIN_SDK__ = { ...original, sdkVersion: 1, apiVersion: 2, svelteVersion: SVELTE_ABI, capabilities, modules: original?.modules ?? {} }; };
afterEach(() => { g.__TAURI_EXPLORER_PLUGIN_SDK__ = original; });

const D = "/pics";
const node = (key: string, parents: string[] = []): TraceNodeRecord => ({ key, parents, path: `${D}/${key}`, scope: "current", state: "present" } as TraceNodeRecord);
const page = <T,>(items: T[], offset: number, size: number) => items.slice(offset, offset + size);

function backend(overrides: Partial<TraceBackend> = {}, size = 2): TraceBackend {
  const nodes = [node("a"), node("b", ["a"]), node("c", ["a", "b"]), node("d", ["c"])];
  return {
    components: async (_d, offset) => ({ token: "t", total: 1, offset, components: offset ? [] : [{ id: "k1" } as never] }),
    members: async (_d, token, offset) => {
      const all = nodes.map((n) => ({ path: n.path!, componentId: "k1", key: n.key }));
      return token !== "t" ? { stale: true, total: 0, offset, members: [] } : { stale: false, total: all.length, offset, members: page(all, offset, size) };
    },
    nodes: async (_d, token, _c, offset) => token !== "t" ? { stale: true, total: 0, offset, nodes: [] } : { stale: false, total: nodes.length, offset, nodes: page(nodes, offset, size) },
    ...overrides,
  };
}

describe("loadFolderLineage", () => {
  it("pages members and nodes and maps them to parents", async () => {
    const lineage = await loadFolderLineage(backend(), D, new AbortController().signal);
    expect(lineage.parents.get(`${D}/c`)).toEqual([{ kind: "entry", path: `${D}/a` }, { kind: "entry", path: `${D}/b` }]);
    expect(lineage.parents.get(`${D}/d`)).toEqual([{ kind: "entry", path: `${D}/c` }]);
    expect(lineage.parents.has(`${D}/a`)).toBe(false);
  });

  it("asks for a summary only for edits that lack one, and fills titles it already has", async () => {
    const withRuns = backend({}, 10);
    const base = withRuns.nodes;
    withRuns.nodes = async (...args) => { const p = await base(...args); return { ...p, nodes: p.nodes.map((n, i) => ({ ...n, runId: i === 0 ? 7 : i === 1 ? 8 : null, prompt: `p-${n.key}` })) }; };
    const titleFor = vi.fn((id: number) => id === 7 ? "Seven" : undefined);
    const request = vi.fn();
    const lineage = await loadFolderLineage(withRuns, D, new AbortController().signal, { titleFor, request });
    expect(lineage.labels?.get(`${D}/a`)).toEqual({ prompt: "p-a", title: "Seven" });
    expect(request.mock.calls.filter(([id]) => id === 7)).toEqual([]);
    expect(request).toHaveBeenCalledWith(8, "p-b");
    expect(lineage.labels?.get(`${D}/b`)).toEqual({ prompt: "p-b" });
    expect(titleFor).not.toHaveBeenCalledWith(null);
    const without = await loadFolderLineage(withRuns, D, new AbortController().signal);
    expect(without.labels?.get(`${D}/a`)).toEqual({ prompt: "p-a" });
  });

  it("restarts when a page reports the index changed, then gives up", async () => {
    let first = true;
    const flaky = backend({ members: async (_d, _t, offset) => first ? (first = false, { stale: true, total: 0, offset, members: [] }) : { stale: false, total: 0, offset, members: [] } });
    expect((await loadFolderLineage(flaky, D, new AbortController().signal)).parents.size).toBe(0);
    const calls = vi.fn(async (_d: string, _t: string, offset: number) => ({ stale: true, total: 0, offset, members: [] }));
    await expect(loadFolderLineage(backend({ members: calls }), D, new AbortController().signal)).rejects.toThrow(/kept changing/);
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("rejects on a backend error and on abort without a result", async () => {
    await expect(loadFolderLineage(backend({ nodes: async () => { throw new Error("boom"); } }), D, new AbortController().signal)).rejects.toThrow("boom");
    const controller = new AbortController();
    const reading = loadFolderLineage(backend({ members: async () => { controller.abort(new Error("cancelled")); return { stale: false, total: 0, offset: 0, members: [] }; } }), D, controller.signal);
    await expect(reading).rejects.toThrow("cancelled");
    const aborted = new AbortController(); aborted.abort(new Error("early"));
    const never = vi.fn();
    await expect(loadFolderLineage(backend({ components: never }), D, aborted.signal)).rejects.toThrow("early");
    expect(never).not.toHaveBeenCalled();
  });

  it("a restart uses the retry's data and cancels the failed attempt's queued node reads", async () => {
    const seen: string[] = [];
    let attempt = 0;
    const tokens = ["t1", "t2"];
    const b: TraceBackend = {
      components: async (_d, offset) => ({ token: tokens[attempt++] ?? "t2", total: 1, offset, components: [] }),
      members: async (_d, token, offset) => ({ stale: false, total: 12, offset, members: Array.from({ length: 12 }, (_, i) => ({ path: `${D}/f${i}`, componentId: `c${i}`, key: `f${i}` })) }),
      nodes: async (_d, token, id, offset) => {
        seen.push(`${token}:${id}`);
        if (token === "t1") { await new Promise((r) => setTimeout(r, 1)); return { stale: true, total: 0, offset, nodes: [] }; }
        await new Promise((r) => setTimeout(r, 1));
        return { stale: false, total: 1, offset, nodes: [node(id.replace("c", "f"), id === "c1" ? ["f0"] : [])] };
      },
    };
    const lineage = await loadFolderLineage(b, D, new AbortController().signal);
    expect(lineage.parents.get(`${D}/f1`)).toEqual([{ kind: "entry", path: `${D}/f0` }]);
    // Only reads already running when the first stale page arrived reach the backend; the rest are dropped.
    expect(seen.filter((entry) => entry.startsWith("t1:")).length).toBeLessThan(12);
  });

  it("tolerates partial and malformed pages without looping", async () => {
    const odd = backend({
      components: async (_d, offset) => ({ token: "t", total: 5, offset, components: undefined as never }),
      members: async (_d, _t, offset) => ({ stale: false, total: 9, offset, members: undefined as never }),
    });
    expect((await loadFolderLineage(odd, D, new AbortController().signal)).parents.size).toBe(0);
  });

  it("reads each owning component once, and none for an empty folder", async () => {
    const nodes = vi.fn(backend({}, 10).nodes);
    await loadFolderLineage(backend({ nodes }, 10), D, new AbortController().signal);
    expect(nodes).toHaveBeenCalledTimes(1);
    const none = vi.fn();
    await loadFolderLineage(backend({ members: async (_d, _t, offset) => ({ stale: false, total: 0, offset, members: [] }), nodes: none }), D, new AbortController().signal);
    expect(none).not.toHaveBeenCalled();
  });
});

describe("lineage title notifications", () => {
  it("tells the host to reload when a title arrives, and stops after unsubscribe", () => {
    let fire = () => {};
    const off = vi.fn();
    const titles = { titleFor: () => undefined, subscribe: (changed: () => void) => { fire = changed; return off; } };
    const contribution = lineageContribution(backend(), () => true, createLineageSubscriptions(), titles);
    const changed = vi.fn();
    const stop = contribution.subscribe!(D, changed);
    fire();
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("lineage subscriptions", () => {
  it("notifies subscribers of the changed directories, and all on a Trace change", () => {
    const subs = createLineageSubscriptions();
    const a = vi.fn(), b = vi.fn();
    subs.subscribe("/a", a); subs.subscribe("/b/", b);
    subs.notifyDirectories(["/a"]);
    expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled();
    subs.notifyAll();
    expect(a).toHaveBeenCalledTimes(2); expect(b).toHaveBeenCalledTimes(1);
  });
  it("stops after unsubscribe, and one throwing listener does not starve the others", () => {
    const subs = createLineageSubscriptions();
    const a = vi.fn(), b = vi.fn(() => { throw new Error("x"); }), c = vi.fn();
    const off = subs.subscribe("/a", a); subs.subscribe("/a", b); subs.subscribe("/a", c);
    off(); off();
    subs.notifyAll();
    expect(a).not.toHaveBeenCalled(); expect(c).toHaveBeenCalledTimes(1);
  });
});

describe("registerLineage", () => {
  const context = (extra: Record<string, unknown> = {}) => {
    const commands: Array<{ id: string; label: string; handler: () => void }> = [];
    const toggle = vi.fn();
    const ctx = { registerCommand: (c: never) => commands.push(c), workspace: { toggleEntryLineage: toggle }, ...extra } as never;
    return { ctx, commands, toggle };
  };

  it("registers the provider and a Show Traces command where the host announces entryLineage", async () => {
    announce(["fileViews", "entryLineage"]);
    const registered: Array<{ id: string; title: string; available(d: string): unknown; load: Function }> = [];
    const { ctx, commands, toggle } = context({ registerEntryLineage: (c: never) => registered.push(c) });
    expect(registerLineage(ctx, backend(), (d) => d === D ? true : "pending")).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ id: "trace.lineage", title: "Traces" });
    expect(registered[0].available(D)).toBe(true);
    expect(registered[0].available("/other")).toBe("pending");
    expect(commands.map((c) => c.label)).toEqual(["Show Traces"]);
    commands[0].handler();
    expect(toggle).toHaveBeenCalledWith(LINEAGE_ID);
    expect(((await registered[0].load(D, new AbortController().signal)) as { parents: Map<string, unknown> }).parents.size).toBe(3);
  });

  it.each([
    ["no capability", ["fileViews"]],
    ["no capability list", undefined],
  ])("registers nothing on an older host (%s)", (_name, capabilities) => {
    announce(capabilities);
    const registerEntryLineage = vi.fn();
    const { ctx, commands } = context({ registerEntryLineage });
    expect(registerLineage(ctx, backend(), () => true)).toBe(false);
    expect(registerEntryLineage).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it("registers nothing when the capability is announced but the method is missing, or the runtime is absent", () => {
    announce(["entryLineage"]);
    const { ctx, commands } = context();
    expect(registerLineage(ctx, backend(), () => true)).toBe(false);
    expect(commands).toEqual([]);
    g.__TAURI_EXPLORER_PLUGIN_SDK__ = undefined;
    expect(registerLineage(context({ registerEntryLineage: vi.fn() }).ctx, backend(), () => true)).toBe(false);
  });

  it("does not throw when the host lacks toggleEntryLineage", () => {
    announce(["entryLineage"]);
    const commands: Array<{ handler: () => void }> = [];
    const ctx = { registerEntryLineage: vi.fn(), registerCommand: (c: never) => commands.push(c), workspace: {} } as never;
    registerLineage(ctx, backend(), () => true);
    expect(() => commands[0].handler()).not.toThrow();
  });
});
