import { describe, it, expect } from "vitest";
import { classify, modelFromGraph, modelFromView, runSettings } from "$lib/plugins/trace/view/preview-model";
import type { TraceArtifact, TraceGraph, TraceRun } from "$lib/api/trace";
import type { TraceNode } from "$lib/domain/trace-graph/model";

describe("classify", () => {
  it.each([
    ["/a/b/x.png", "/a/b", "current", "./x.png"],
    ["/a/b/x.png", "/a/b/", "current", "./x.png"],
    ["C:\\pics\\x.png", "C:\\pics", "current", "./x.png"],
    ["C:\\pics\\x.png", "C:/pics/", "current", "./x.png"],
    ["/a/b/refs/x.png", "/a/b", "subfolder", "refs/x.png"],
    ["/a/b/refs/deep/x.png", "/a/b/", "subfolder", "refs/deep/x.png"],
    ["C:\\pics\\refs\\x.png", "C:\\pics", "subfolder", "refs/x.png"],
    ["/a/bc/x.png", "/a/b", "external", "/a/bc/x.png"],
    ["/other/x.png", "/a/b", "external", "/other/x.png"],
    ["/a/x.png", "/a/b", "external", "/a/x.png"],
  ] as const)("%s in %s is %s", (path, directory, scope, location) => {
    expect(classify(path, directory)).toEqual({ scope, location });
  });
});

const node = (over: Partial<TraceNode>): TraceNode => ({
  key: "k", artifactId: 1, runId: 1, parents: [], path: "/f/a.png", scope: "current", location: "./a.png",
  state: "present", temporary: false, discarded: false, earlierRevision: false, order: 0, prompt: "p", ...over,
});

describe("modelFromView", () => {
  it("maps parent nodes to focusable inputs and skips unknown parents", () => {
    const nodes = new Map([["p1", node({ key: "p1", path: "/f/in.png", location: "./in.png", runId: 5, prompt: "inp" })]]);
    const model = modelFromView(node({ artifactId: 9, runId: 7, prompt: "hello", parents: ["p1", "ghost"] }), (key) => nodes.get(key) ?? null);
    expect(model).toMatchObject({ artifactId: 9, runId: 7, prompt: "hello", focusable: true });
    expect(model.inputs).toEqual([{ key: "p1", path: "/f/in.png", present: true, scope: "current", location: "./in.png", runId: 5, prompt: "inp", title: "in.png" }]);
  });

  it("marks discarded, missing and earlier-revision inputs as not present; unsaved placeholders get a generic title", () => {
    const nodes: Record<string, TraceNode> = {
      d: node({ key: "d", discarded: true }), m: node({ key: "m", state: "missing" }),
      e: node({ key: "e", earlierRevision: true }), r: node({ key: "r", path: null, state: "running" }),
    };
    const model = modelFromView(node({ parents: Object.keys(nodes) }), (key) => nodes[key] ?? null);
    expect(model.inputs.map((i) => i.present)).toEqual([false, false, false, false]);
    expect(model.inputs.find((i) => i.key === "r")!.title).toBe("Image");
  });

  it("handles a node without parents", () => {
    expect(modelFromView(node({ parents: [] }), () => null).inputs).toEqual([]);
  });
});

const artifact = (id: number, over: Partial<TraceArtifact> = {}): TraceArtifact => ({
  id, path: `/f/a${id}.png`, digest: "d", createdAt: "", generatingRun: null, pathState: "present", ...over,
});
const run = (id: number, inputIds: number[], parameters: Record<string, unknown> = {}): TraceRun => ({
  id, operation: "edit", parameters, createdAt: "", status: "succeeded", finishedAt: null, error: null, recovered: false, inputIds,
});
const graph = (over: Partial<TraceGraph>): TraceGraph => ({ currentArtifactId: 1, selectedRevisionStatus: "matched", artifacts: [], runs: [], ...over });

describe("modelFromGraph", () => {
  it("is null when the current artifact is missing", () => {
    expect(modelFromGraph(graph({ currentArtifactId: 42, artifacts: [artifact(1)] }), "/f")).toBeNull();
    expect(modelFromGraph(graph({}), "/f")).toBeNull();
  });

  it("has no run and no inputs for a source image", () => {
    expect(modelFromGraph(graph({ artifacts: [artifact(1)] }), "/f")).toEqual({ artifactId: 1, runId: null, prompt: "", inputs: [], focusable: false });
  });

  it("builds inputs from the generating run with producer prompts and classification", () => {
    const g = graph({
      artifacts: [
        artifact(1, { generatingRun: 10 }),
        artifact(2, { path: "/f/refs/in.png", generatingRun: 11 }),
        artifact(3, { path: "/elsewhere/x.png", pathState: "missing" }),
      ],
      runs: [run(10, [2, 3], { prompt: "final" }), run(11, [], { prompt: "ref prompt" })],
    });
    const model = modelFromGraph(g, "/f")!;
    expect(model).toMatchObject({ artifactId: 1, runId: 10, prompt: "final", focusable: false });
    expect(model.inputs).toEqual([
      { key: "a:2", path: "/f/refs/in.png", present: true, scope: "subfolder", location: "refs/in.png", runId: 11, prompt: "ref prompt", title: "in.png" },
      { key: "a:3", path: "/elsewhere/x.png", present: false, scope: "external", location: "/elsewhere/x.png", runId: null, prompt: "", title: "x.png" },
    ]);
  });

  it("dedupes input ids and skips inputs whose artifact is unknown", () => {
    const g = graph({ artifacts: [artifact(1, { generatingRun: 10 }), artifact(2)], runs: [run(10, [2, 2, 99, 2])] });
    expect(modelFromGraph(g, "/f")!.inputs.map((i) => i.key)).toEqual(["a:2"]);
  });

  it("labels temporary inputs Unsaved and external, and marks discarded inputs absent", () => {
    const g = graph({
      artifacts: [artifact(1, { generatingRun: 10 }), artifact(2, { temporary: true, path: "/tmp/x/out.png" }), artifact(3, { discarded: true })],
      runs: [run(10, [2, 3])],
    });
    const [temp, gone] = modelFromGraph(g, "/f")!.inputs;
    expect(temp).toMatchObject({ scope: "external", location: "Unsaved", present: true });
    expect(gone.present).toBe(false);
  });

  it("ignores non-string prompts", () => {
    const g = graph({
      artifacts: [artifact(1, { generatingRun: 10 }), artifact(2, { generatingRun: 11 })],
      runs: [run(10, [2], { prompt: 42 }), run(11, [], { prompt: { text: "x" } })],
    });
    const model = modelFromGraph(g, "/f")!;
    expect(model.prompt).toBe("");
    expect(model.inputs[0].prompt).toBe("");
  });

  it("tolerates a generating run id with no matching run", () => {
    const model = modelFromGraph(graph({ artifacts: [artifact(1, { generatingRun: 77 })] }), "/f")!;
    expect(model.runId).toBeNull();
    expect(model.inputs).toEqual([]);
  });

  it("handles a large fan-in", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => i + 2);
    const g = graph({ artifacts: [artifact(1, { generatingRun: 10 }), ...ids.map((id) => artifact(id))], runs: [run(10, ids)] });
    expect(modelFromGraph(g, "/f")!.inputs).toHaveLength(2000);
  });
});

describe("runSettings", () => {
  const edit = (parameters: Record<string, unknown>, details: TraceRun["details"] = null): TraceRun => ({
    id: 1, operation: "openai.image.edit", parameters, createdAt: "", status: "succeeded", finishedAt: null, error: null, recovered: false, details, inputIds: [],
  });

  it("labels the recorded settings in display order, ending with the actual size", () => {
    expect(runSettings(edit({ prompt: "p", resolution: "2k", aspect_ratio: "3:2", quality: "high", seed: 7 }, { actual_size: { width: 1536, height: 1024 } }))).toEqual([
      { label: "Operation", value: "OpenAI edit" },
      { label: "Resolution", value: "2K" },
      { label: "Aspect ratio", value: "3:2" },
      { label: "Quality", value: "high" },
      { label: "Seed", value: "7" },
      { label: "Actual size", value: "1536 × 1024 px" },
    ]);
  });

  it("shows the keep-aspect setting as Keep", () => {
    expect(runSettings(edit({ aspect_ratio: "keep" }))).toContainEqual({ label: "Aspect ratio", value: "Keep" });
  });

  it("leaves out missing, empty, automatic and non-scalar values", () => {
    expect(runSettings(edit({ resolution: "AUTO", aspect_ratio: "auto", quality: "", seed: null, rect: { left: 0 } }))).toEqual([{ label: "Operation", value: "OpenAI edit" }]);
    expect(runSettings(edit({ quality: { level: 3 }, seed: Number.NaN })).map((row) => row.label)).toEqual(["Operation"]);
  });

  it("ignores a malformed or implausible actual size", () => {
    for (const actual_size of [null, "1024x768", { width: 1024 }, { width: 0, height: 768 }, { width: 1.5, height: 2 }, { width: -4, height: 4 }, { width: 2 ** 60, height: 1 }]) {
      expect(runSettings(edit({}, { actual_size })).map((row) => row.label)).not.toContain("Actual size");
    }
    expect(runSettings(edit({}, null)).map((row) => row.label)).toEqual(["Operation"]);
  });

  it("keeps a very long value intact for the row to ellipsize", () => {
    const seed = "9".repeat(5000);
    expect(runSettings(edit({ seed }))).toContainEqual({ label: "Seed", value: seed });
  });
});
