import "./svelte-host";
import { describe, expect, it } from "vitest";
import { PROMPT_LIMIT, tileTooltipContent, tooltipPrompt } from "$lib/plugins/trace/view/tooltip/content";
import type { TraceNode } from "$lib/domain/trace-graph/model";
import type { TraceRun } from "$lib/api/trace";

const node = (over: Partial<TraceNode> = {}): TraceNode => ({
  key: "o:1:0", artifactId: 7, runId: 1, parents: [], path: "/pictures/out.png", scope: "current", location: "./out.png",
  state: "present", temporary: false, discarded: false, earlierRevision: false, order: 0, prompt: "", ...over,
});
const run = (over: Partial<TraceRun> = {}): TraceRun => ({
  id: 1, operation: "openai.image.edit", parameters: {}, createdAt: "", status: "succeeded", finishedAt: null, error: null,
  recovered: false, inputIds: [], ...over,
});

describe("tileTooltipContent", () => {
  it("shows the full prompt, with the image name as a detail", () => {
    const content = tileTooltipContent(node({ prompt: "A lighthouse at dusk\nwith warm windows" }));
    expect(content).toEqual({ text: "A lighthouse at dusk\nwith warm windows", isPrompt: true, details: ["out.png"] });
  });

  it("falls back to the image name when there is no prompt", () => {
    expect(tileTooltipContent(node({ prompt: "   \n " }))).toEqual({ text: "out.png", isPrompt: false, details: [] });
    expect(tileTooltipContent(node({ prompt: "", path: null, state: "running" })).text).toBe("Generating…");
  });

  it("adds the operation and model once run details are known", () => {
    const content = tileTooltipContent(node({ prompt: "p" }), run({ parameters: { model: " gpt-image-2 " } }));
    expect(content.details).toEqual(["out.png · AI edit · gpt-image-2"]);
    // A non-string model is ignored.
    expect(tileTooltipContent(node({ prompt: "p" }), run({ parameters: { model: 42 } })).details).toEqual(["out.png · AI edit"]);
  });

  it("says when an image is unsaved, missing or elsewhere", () => {
    expect(tileTooltipContent(node({ temporary: true, location: "Unsaved" })).details).toEqual(["Unsaved"]);
    expect(tileTooltipContent(node({ temporary: true, discarded: true })).details).toEqual(["Deleted"]);
    expect(tileTooltipContent(node({ state: "missing", prompt: "p" })).details).toEqual(["out.png · Missing"]);
    expect(tileTooltipContent(node({ scope: "external", location: "/elsewhere/out.png" })).details).toEqual(["Outside this folder: /elsewhere/out.png"]);
    expect(tileTooltipContent(node({ scope: "subfolder", location: "refs/out.png", prompt: "p" })).details).toEqual(["out.png", "Subfolder: refs/out.png"]);
  });
});

describe("tooltipPrompt", () => {
  it("trims, normalises line endings and collapses blank runs", () => {
    expect(tooltipPrompt("  first  \r\nsecond\r\n\r\n\r\n\r\nthird \n")).toBe("first\nsecond\n\nthird");
  });

  it("handles missing prompts", () => {
    expect(tooltipPrompt(null)).toBe("");
    expect(tooltipPrompt(undefined)).toBe("");
  });

  it("caps extremely long prompts", () => {
    const long = "word ".repeat(10_000);
    const text = tooltipPrompt(long);
    expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT + 1);
    expect(text.endsWith("…")).toBe(true);
    expect(tooltipPrompt("x".repeat(PROMPT_LIMIT))).toBe("x".repeat(PROMPT_LIMIT));
  });
});
