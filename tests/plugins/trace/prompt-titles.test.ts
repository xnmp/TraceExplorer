import "./svelte-host";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/common", () => ({ invoke }));

import { promptTitles } from "$lib/plugins/trace/prompt-titles.svelte";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const titleCalls = () => invoke.mock.calls.filter((c) => c[0] === "trace_prompt_title");

async function configured(settings: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (method: string) => (method === "trace_title_connection" ? true : "A Title"));
  await promptTitles.configure(settings);
}

beforeEach(async () => {
  promptTitles.unbind();
  invoke.mockReset();
  await promptTitles.configure({ titleGenerator: "disabled" });
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
    await promptTitles.configure({ titleGenerator: "disabled" });
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
    expect(titleCalls()).toEqual([["trace_prompt_title", { runId: 5, codexPath: "" }]]);
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
    invoke.mockImplementation(async (method: string) => { if (method === "trace_title_connection") return true; throw new Error("fail"); });
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
    invoke.mockImplementation(async (method: string) => (method === "trace_title_connection" ? true : "   "));
    await promptTitles.configure({});
    promptTitles.request(6, "p");
    await flush();
    expect(promptTitles.labelFor(6, "p")).toBe("p");
  });

  it("pending is true while in flight, and requests run one at a time", async () => {
    const first = deferred<string>();
    invoke.mockImplementation((method: string, params: { runId?: number }) => {
      if (method === "trace_title_connection") return Promise.resolve(true);
      return params.runId === 1 ? first.promise : Promise.resolve("Second");
    });
    await promptTitles.configure({});
    promptTitles.request(1, "one");
    promptTitles.request(2, "two");
    await flush();
    expect(promptTitles.pending(1)).toBe(true);
    expect(promptTitles.pending(2)).toBe(true);
    expect(titleCalls()).toHaveLength(1);
    first.resolve("First");
    await flush();
    expect(promptTitles.pending(1)).toBe(false);
    expect(promptTitles.pending(2)).toBe(false);
    expect(promptTitles.labelFor(1, "")).toBe("First");
    expect(promptTitles.labelFor(2, "")).toBe("Second");
  });

  it("passes the configured executable, preferring titleCodexPath", async () => {
    await configured({ codexPath: "/bin/codex", titleCodexPath: "  /opt/title-codex  " });
    promptTitles.request(1, "p");
    await flush();
    expect(titleCalls()[0][1]).toEqual({ runId: 1, codexPath: "/opt/title-codex" });
    await configured({ codexPath: "/bin/codex", titleCodexPath: "  " });
    promptTitles.request(2, "p");
    await flush();
    expect(titleCalls().at(-1)![1]).toEqual({ runId: 2, codexPath: "/bin/codex" });
  });

  it("reconfiguring discards in-flight results and allows runs to be requested again", async () => {
    const gate = deferred<string>();
    invoke.mockImplementation((method: string) => (method === "trace_title_connection" ? Promise.resolve(true) : gate.promise));
    await promptTitles.configure({});
    promptTitles.request(1, "p");
    await flush();
    await configured();
    gate.resolve("Stale");
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
});
