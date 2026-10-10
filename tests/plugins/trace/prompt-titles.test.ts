import "./svelte-host";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/common", () => ({ invoke }));

import { promptTitles } from "$lib/plugins/trace/prompt-titles.svelte";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const description = {version:1, enabled:true, available:true, configurationRevision:1, context:{configurationRevision:1,fingerprint:"f".repeat(64)}};
const result = (title:string, revision=1, fingerprint="f".repeat(64)) => ({title,configurationRevision:revision,fingerprint});
const titleCalls = () => invoke.mock.calls.filter((c) => c[0] === "trace_prompt_title");

async function configured(settings: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (method: string) => (method === "trace_title_context" ? description : result("A Title")));
  await promptTitles.configure(settings);
}

beforeEach(async () => {
  promptTitles.unbind();
  invoke.mockReset();
  await promptTitles.configure({ summarizePrompts: false });
  invoke.mockReset();
});

describe("promptTitles", () => {
  it("requests nothing while unconfigured", async () => {
    promptTitles.request(1, "a cat");
    promptTitles.loadFor(1, "a cat");
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(promptTitles.pending(1)).toBe(false);
  });

  it("stays unconfigured when the generator is disabled (and never probes the connection)", async () => {
    await promptTitles.configure({ summarizePrompts: false });
    expect(promptTitles.configured).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays unconfigured when the connection check fails or rejects", async () => {
    invoke.mockResolvedValue(false);
    await promptTitles.configure({});
    expect(promptTitles.configured).toBe(false);
    invoke.mockRejectedValue(new Error("no codex"));
    await promptTitles.configure({});
    expect(promptTitles.configured).toBe(false);
  });

  it("generates a title for a run and exposes it through labelFor", async () => {
    await configured();
    promptTitles.loadFor(5, "a cat on a mat");
    await flush();
    expect(titleCalls()).toHaveLength(1);
    expect(titleCalls()[0][1]).toMatchObject({runId:5,expectedConfigurationRevision:1});
    expect(titleCalls()[0][1].requestId).toMatch(/^title-[a-f0-9-]+-[0-9]+$/);
    expect(promptTitles.labelFor(5, "a cat on a mat")).toBe("A Title");
    expect(promptTitles.pending(5)).toBe(false);
  });

  it("falls back to the prompt when there is no title, and to empty for a null run", async () => {
    await configured();
    expect(promptTitles.labelFor(9, "raw prompt")).toBe("raw prompt");
    expect(promptTitles.labelFor(null, "raw prompt")).toBe("");
  });

  it("ignores null run ids and blank prompts", async () => {
    await configured();
    promptTitles.loadFor(null, "x");
    for (const blank of ["", "   ", "\n\t"]) promptTitles.request(2, blank);
    await flush();
    expect(titleCalls()).toHaveLength(0);
    expect(promptTitles.pending(2)).toBe(false);
  });

  it("requests a run at most once, even when asked again after completion or while in flight", async () => {
    await configured();
    promptTitles.request(3, "p");
    promptTitles.request(3, "p");
    await flush();
    promptTitles.request(3, "p");
    await flush();
    expect(titleCalls()).toHaveLength(1);
  });

  it("does not retry a run whose generation failed, and keeps the prompt", async () => {
    invoke.mockImplementation(async (method: string) => { if (method === "trace_title_context") return description; throw new Error("fail"); });
    await promptTitles.configure({});
    promptTitles.request(4, "p");
    await flush();
    promptTitles.request(4, "p");
    await flush();
    expect(titleCalls()).toHaveLength(1);
    expect(promptTitles.labelFor(4, "p")).toBe("p");
    expect(promptTitles.pending(4)).toBe(false);
  });

  it("ignores blank titles from the generator", async () => {
    invoke.mockImplementation(async (method: string) => (method === "trace_title_context" ? description : result("   ")));
    await promptTitles.configure({});
    promptTitles.request(6, "p");
    await flush();
    expect(promptTitles.labelFor(6, "p")).toBe("p");
  });

  it("pending is true while in flight, and requests run one at a time", async () => {
    const first = deferred<ReturnType<typeof result>>();
    invoke.mockImplementation((method: string, params: { runId?: number }) => {
      if (method === "trace_title_context") return Promise.resolve(description);
      return params.runId === 1 ? first.promise : Promise.resolve(result("Second"));
    });
    await promptTitles.configure({});
    promptTitles.request(1, "one");
    promptTitles.request(2, "two");
    await flush();
    expect(promptTitles.pending(1)).toBe(true);
    expect(promptTitles.pending(2)).toBe(true);
    expect(titleCalls()).toHaveLength(1);
    first.resolve(result("First"));
    await flush();
    expect(promptTitles.pending(1)).toBe(false);
    expect(promptTitles.pending(2)).toBe(false);
    expect(promptTitles.labelFor(1, "")).toBe("First");
    expect(promptTitles.labelFor(2, "")).toBe("Second");
  });

  it("image executable and legacy title fields have no effect on global title requests", async () => {
    await configured({codexPath:"/image",titleCodexPath:"/old-title",titleGenerator:"disabled"});
    promptTitles.request(1,"p");
    await flush();
    expect(titleCalls()[0][1]).toMatchObject({runId:1,expectedConfigurationRevision:1});
    expect(titleCalls()[0][1]).not.toHaveProperty("codexPath");
  });

  it("reconfiguring discards in-flight results and allows runs to be requested again", async () => {
    const gate = deferred<ReturnType<typeof result>>();
    invoke.mockImplementation((method: string) => (method === "trace_title_context" ? Promise.resolve(description) : gate.promise));
    await promptTitles.configure({});
    promptTitles.request(1, "p");
    await flush();
    await configured();
    gate.resolve(result("Stale"));
    await flush();
    expect(promptTitles.labelFor(1, "raw")).toBe("raw");
    promptTitles.request(1, "p");
    await flush();
    expect(promptTitles.labelFor(1, "raw")).toBe("A Title");
  });

  it("clear forgets titles", async () => {
    await configured();
    promptTitles.request(1, "p");
    await flush();
    promptTitles.clear();
    expect(promptTitles.labelFor(1, "raw")).toBe("raw");
  });

  it("load() only requests runs with a string prompt", async () => {
    await configured();
    const base = { operation: "edit", createdAt: "", status: "succeeded", finishedAt: null, error: null, recovered: false, inputIds: [] } as const;
    promptTitles.load({ ...base, id: 1, parameters: { prompt: 5 } } as never);
    promptTitles.load({ ...base, id: 2, parameters: {} } as never);
    promptTitles.load({ ...base, id: 3, parameters: { prompt: "ok" } } as never);
    await flush();
    expect(titleCalls().map((c) => c[1].runId)).toEqual([3]);
  });

  it("removes an existing provider's label immediately when summaries are disabled", async () => {
    await configured();
    promptTitles.request(1, "Original");
    await flush();
    expect(promptTitles.labelFor(1, "Original")).toBe("A Title");
    invoke.mockClear();
    await promptTitles.configure({summarizePrompts:false});
    expect(promptTitles.labelFor(1, "Original")).toBe("Original");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores an older connection probe after a newer disabled preference", async () => {
    const probe = deferred<typeof description>();
    invoke.mockReturnValue(probe.promise);
    const initial = promptTitles.configure({});
    await promptTitles.configure({summarizePrompts:false});
    probe.resolve(description);
    await initial;
    promptTitles.request(1, "Original");
    expect(promptTitles.configured).toBe(false);
    expect(titleCalls()).toHaveLength(0);
  });

  it("never displays a result stamped with a different revision or fingerprint", async () => {
    for (const wrong of [result("Wrong", 2), result("Wrong", 1, "a".repeat(64))]) {
      invoke.mockImplementation(async method => method === "trace_title_context" ? description : wrong);
      await promptTitles.configure({});
      promptTitles.request(1, "Original");
      await flush();
      expect(promptTitles.labelFor(1, "Original")).toBe("Original");
    }
  });

  it("cancels active work by its request identity on unbind", async () => {
    const work = deferred<ReturnType<typeof result>>();
    invoke.mockImplementation(method => method === "trace_title_context" ? Promise.resolve(description) : method === "trace_prompt_title" ? work.promise : Promise.resolve({cancelled:true}));
    await promptTitles.configure({});
    promptTitles.request(1,"Original");
    const requestId = titleCalls()[0][1].requestId;
    promptTitles.unbind();
    expect(invoke).toHaveBeenCalledWith("trace_cancel_prompt_title", {requestId});
    work.resolve(result("Late"));
    await flush();
    expect(promptTitles.labelFor(1,"Original")).toBe("Original");
    expect(promptTitles.pending(1)).toBe(false);
  });

  it("binds Trace preferences and invalidates labels on a global configuration notification", async () => {
    await configured();
    let changed!: (revision:number) => void;
    const stop = vi.fn();
    promptTitles.bind({storage:{get:async()=>({summarizePrompts:true}),set:async()=>{}},text:{subscribe:listener=>{changed=listener;return stop;},openSettings(){}}});
    await flush();
    promptTitles.request(1,"Original");
    await flush();
    expect(promptTitles.labelFor(1,"Original")).toBe("A Title");
    changed(2);
    expect(promptTitles.labelFor(1,"Original")).toBe("Original");
    await flush();
    promptTitles.unbind();
    expect(stop).toHaveBeenCalledTimes(1);
    invoke.mockClear();
    changed(3);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never regenerates loaded titles eagerly: configuration and preference changes request nothing until nodes ask again", async () => {
    const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
    await configured();
    let textChanged!: (revision: number) => void;
    let preferencesChanged!: (settings: Record<string, unknown>) => void;
    promptTitles.bind({
      storage: { get: async () => ({ summarizePrompts: true }), set: async () => {}, subscribe: (listener) => { preferencesChanged = listener; return () => {}; } },
      text: { subscribe: (listener) => { textChanged = listener; return () => {}; }, openSettings() {} },
    });
    await settle();
    const loaded = Array.from({ length: 40 }, (_, index) => index + 1);
    for (const id of loaded) promptTitles.request(id, `Prompt ${id}`);
    await settle();
    expect(titleCalls().map((call) => call[1].runId)).toEqual(loaded);
    invoke.mockClear();
    textChanged(2);
    await settle();
    preferencesChanged({ summarizePrompts: true });
    await settle();
    expect(promptTitles.configured).toBe(true);
    expect(invoke.mock.calls.filter((call) => call[0] === "trace_title_context")).toHaveLength(2);
    expect(titleCalls()).toHaveLength(0);
    expect(loaded.every((id) => promptTitles.labelFor(id, `Prompt ${id}`) === `Prompt ${id}` && !promptTitles.pending(id))).toBe(true);
    promptTitles.request(7, "Prompt 7");
    promptTitles.request(3, "Prompt 3");
    await settle();
    expect(titleCalls().map((call) => call[1].runId)).toEqual([7, 3]);
    expect(titleCalls().every((call) => call[1].expectedConfigurationRevision === 1)).toBe(true);
  });

  it("falls back quietly on an older host and ignores a preference load after disposal", async () => {
    const get = vi.fn(async()=>({}));
    promptTitles.bind({storage:{get,set:async()=>{}}});
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    const preferences = deferred<Record<string,unknown>>();
    promptTitles.bind({storage:{get:()=>preferences.promise,set:async()=>{}},text:{subscribe:()=>()=>{},openSettings(){}}});
    promptTitles.unbind();
    preferences.resolve({summarizePrompts:true});
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });
});
