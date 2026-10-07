import "./svelte-host";
import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.hoisted(() => ({
  saveGeneratedImage: vi.fn(),
  discardGeneratedImage: vi.fn(),
  imageSaveSuggestion: vi.fn(),
  pickSaveFile: vi.fn(),
}));
vi.mock("$lib/api/trace", () => ({
  saveGeneratedImage: api.saveGeneratedImage,
  discardGeneratedImage: api.discardGeneratedImage,
  imageSaveSuggestion: api.imageSaveSuggestion,
}));
vi.mock("../../../src/sdk", () => ({ host: () => ({ pickSaveFile: api.pickSaveFile }) }));

import { nodeStatus, nodeTarget, nodeTitle, nodeTypeLabel } from "$lib/plugins/trace/view/node-target";
import { traceInvalidation } from "$lib/plugins/trace/invalidation.svelte";
import { imageActionState } from "$lib/plugins/trace/image-actions.svelte";
import type { TraceNode } from "$lib/domain/trace-graph/model";

const node = (over: Partial<TraceNode> = {}): TraceNode => ({
  key: "o:1:0", artifactId: 7, runId: 1, parents: [], path: "/tmp/gen/out.png", scope: "external", location: "Unsaved",
  state: "present", temporary: true, discarded: false, earlierRevision: false, order: 0, prompt: "", ...over,
});
const callbacks = () => ({ saved: vi.fn(), discarded: vi.fn() });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const action = (target: ReturnType<typeof nodeTarget>, id: string) => target.actions!.find((a) => a.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  api.saveGeneratedImage.mockResolvedValue({ path: "/f/saved.png" });
  api.discardGeneratedImage.mockResolvedValue({ viewPath: null });
  api.imageSaveSuggestion.mockResolvedValue({ directory: "/f", filename: "out.png" });
});

describe("nodeTitle / nodeTypeLabel / nodeStatus", () => {
  it("titles by basename, or by running state when there is no path", () => {
    expect(nodeTitle(node({ path: "C:\\x\\a.png" }))).toBe("a.png");
    expect(nodeTitle(node({ path: null, state: "running" }))).toBe("Generating…");
    expect(nodeTitle(node({ path: null, state: "missing" }))).toBe("Image");
  });
  it("labels the extension in upper case, and nothing without one", () => {
    expect(nodeTypeLabel(node({ path: "/f/a.webp" }))).toBe("WEBP");
    expect(nodeTypeLabel(node({ path: "/f/archive.tar.gz" }))).toBe("GZ");
    expect(nodeTypeLabel(node({ path: "noext" }))).toBeUndefined();
    expect(nodeTypeLabel(node({ path: null }))).toBeUndefined();
  });
  it.each([
    [{ discarded: true, state: "running" }, "Deleted"],
    [{ state: "running" }, "Generating"],
    [{ state: "uncertain" }, "Interrupted"],
    [{ state: "missing" }, "Missing"],
    [{ state: "unavailable" }, "Unavailable"],
    [{ earlierRevision: true }, "Earlier revision"],
    [{}, ""],
  ] as const)("status for %j is %j", (over, expected) => {
    expect(nodeStatus(node(over as Partial<TraceNode>))).toBe(expected);
  });
});

describe("nodeTarget", () => {
  it("gives unsaved nodes Save, Save as… and Delete, and an Unsaved badge", () => {
    const target = nodeTarget(node(), "c1", "/f", callbacks());
    expect(target.actions!.map((a) => a.id)).toEqual(["save", "save-as", "delete"]);
    expect(target.badge).toBe("Unsaved");
    expect(target.imagePath).toBe("/tmp/gen/out.png");
    expect(target.data).toEqual({ kind: "trace-node", key: "o:1:0", componentId: "c1", directory: "/f" });
  });

  it.each([
    ["saved", { temporary: false }],
    ["discarded", { temporary: true, discarded: true }],
    ["reference", { temporary: false, scope: "external" as const }],
    ["placeholder without artifact", { temporary: true, artifactId: null, path: null, state: "running" as const }],
  ])("offers no actions for %s nodes", (_name, over) => {
    expect(nodeTarget(node(over), "c", "/f", callbacks()).actions).toEqual([]);
  });

  it("shows an image only for present, non-discarded, non-earlier-revision nodes", () => {
    for (const over of [{ state: "missing" }, { state: "running" }, { discarded: true }, { earlierRevision: true }, { path: null }] as Partial<TraceNode>[]) {
      expect(nodeTarget(node(over), "c", "/f", callbacks()).imagePath).toBeUndefined();
    }
    expect(nodeTarget(node({ temporary: false }), "c", "/f", callbacks()).imagePath).toBe("/tmp/gen/out.png");
  });

  it("badges non-unsaved nodes with their status, or nothing", () => {
    expect(nodeTarget(node({ temporary: false, state: "missing" }), "c", "/f", callbacks()).badge).toBe("Missing");
    expect(nodeTarget(node({ temporary: false }), "c", "/f", callbacks()).badge).toBeUndefined();
    expect(nodeTarget(node({ discarded: true }), "c", "/f", callbacks()).badge).toBe("Deleted");
  });

  it("disables Save/Save as when the image is not present, but still allows Delete", () => {
    const target = nodeTarget(node({ state: "missing" }), "c", "/f", callbacks());
    expect(action(target, "save").disabled).toBe(true);
    expect(action(target, "save-as").disabled).toBe(true);
    expect(action(target, "delete").disabled).toBe(false);
  });

  it("Save stores the image, notifies the view and bumps the invalidation revision", async () => {
    const cb = callbacks();
    const before = traceInvalidation.revision;
    await action(nodeTarget(node(), "c", "/f", cb), "save").run!();
    expect(api.saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(api.saveGeneratedImage).toHaveBeenCalledWith(7);
    expect(cb.saved).toHaveBeenCalledWith("/f/saved.png", "o:1:0");
    expect(traceInvalidation.revision).toBe(before + 1);
    expect(imageActionState.busy(7)).toBe(false);
  });

  it("running Save twice concurrently saves once", async () => {
    const gate = deferred<{ path: string }>();
    api.saveGeneratedImage.mockReturnValue(gate.promise);
    const cb = callbacks();
    const save = action(nodeTarget(node(), "c", "/f", cb), "save");
    const first = save.run!();
    const second = save.run!();
    expect(imageActionState.busy(7)).toBe(true);
    gate.resolve({ path: "/f/s.png" });
    await Promise.all([first, second]);
    expect(api.saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(cb.saved).toHaveBeenCalledTimes(1);
  });

  it("a failed save releases the busy guard and does not notify", async () => {
    api.saveGeneratedImage.mockRejectedValue(new Error("disk full"));
    const cb = callbacks();
    const before = traceInvalidation.revision;
    await expect(action(nodeTarget(node(), "c", "/f", cb), "save").run!()).rejects.toThrow("disk full");
    expect(cb.saved).not.toHaveBeenCalled();
    expect(traceInvalidation.revision).toBe(before);
    expect(imageActionState.busy(7)).toBe(false);
  });

  it("Save as saves to the picked path", async () => {
    api.pickSaveFile.mockResolvedValue("/chosen/name.png");
    const cb = callbacks();
    await action(nodeTarget(node(), "c", "/f", cb), "save-as").run!();
    expect(api.pickSaveFile).toHaveBeenCalledWith(expect.objectContaining({ directory: "/f", filename: "out.png" }));
    expect(api.saveGeneratedImage).toHaveBeenCalledWith(7, "/chosen/name.png");
    expect(cb.saved).toHaveBeenCalledWith("/f/saved.png", "o:1:0");
  });

  it("Save as with a cancelled picker saves nothing", async () => {
    api.pickSaveFile.mockResolvedValue(null);
    const cb = callbacks();
    await action(nodeTarget(node(), "c", "/f", cb), "save-as").run!();
    expect(api.saveGeneratedImage).not.toHaveBeenCalled();
    expect(cb.saved).not.toHaveBeenCalled();
    expect(imageActionState.busy(7)).toBe(false);
  });

  it("Delete discards the artifact and notifies the view", async () => {
    const cb = callbacks();
    await action(nodeTarget(node(), "c", "/f", cb), "delete").run!();
    expect(api.discardGeneratedImage).toHaveBeenCalledWith(7);
    expect(cb.discarded).toHaveBeenCalledWith("o:1:0");
  });

  it("an action in flight for the artifact blocks the other actions", async () => {
    const gate = deferred<{ path: string }>();
    api.saveGeneratedImage.mockReturnValue(gate.promise);
    const target = nodeTarget(node(), "c", "/f", callbacks());
    const saving = action(target, "save").run!();
    await action(target, "delete").run!();
    expect(api.discardGeneratedImage).not.toHaveBeenCalled();
    gate.resolve({ path: "/x.png" });
    await saving;
  });
});
