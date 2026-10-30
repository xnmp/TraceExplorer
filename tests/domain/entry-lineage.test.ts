import { describe, expect, it } from "vitest";
import { buildEntryLineage, type LineageNode } from "$lib/domain/entry-lineage";

const D = "/pics";
const member = (name: string, key = name) => ({ path: `${D}/${name}`, key });
const node = (key: string, parents: string[] = [], extra: Partial<LineageNode> = {}): LineageNode =>
  ({ key, parents, scope: "current", state: "present", path: `${D}/${key}`, artifactId: null, ...extra });
const entry = (name: string) => ({ kind: "entry", path: `${D}/${name}` });
const shape = (l: ReturnType<typeof buildEntryLineage>) => Object.fromEntries(l.parents);

describe("buildEntryLineage", () => {
  it("maps single-parent edits, in input order", () => {
    const l = buildEntryLineage([member("a"), member("b"), member("c")], [node("a"), node("b", ["a"]), node("c", ["a"])]);
    expect(shape(l)).toEqual({ [`${D}/b`]: [entry("a")], [`${D}/c`]: [entry("a")] });
  });

  it("keeps merge and three-parent sets in the node's parent order", () => {
    const l = buildEntryLineage(
      [member("a"), member("b"), member("c"), member("m"), member("n")],
      [node("a"), node("b"), node("c"), node("m", ["b", "a"]), node("n", ["c", "a", "b"])]);
    expect(l.parents.get(`${D}/m`)).toEqual([entry("b"), entry("a")]);
    expect(l.parents.get(`${D}/n`)).toEqual([entry("c"), entry("a"), entry("b")]);
  });

  it("resolves a missing intermediate to the nearest present ancestors", () => {
    const l = buildEntryLineage(
      [member("a"), member("b"), member("d")],
      [node("a"), node("b"), node("gone1", ["a", "b"], { state: "missing" }), node("gone2", ["gone1"], { state: "missing" }), node("d", ["gone2"])]);
    expect(l.parents.get(`${D}/d`)).toEqual([entry("a"), entry("b")]);
  });

  it("gives a file with no present ancestor no parents", () => {
    const l = buildEntryLineage([member("d")], [node("gone", [], { state: "missing" }), node("d", ["gone"])]);
    expect(l.parents.has(`${D}/d`)).toBe(false);
  });

  it("turns subfolder and external parents into external parents with identity, label and thumbnail", () => {
    const l = buildEntryLineage(
      [member("a"), member("e")],
      [node("a"), node("sub", [], { scope: "subfolder", path: `${D}/sub/ref.png`, artifactId: 7 }),
        node("out", [], { scope: "external", path: "/elsewhere/style.png", artifactId: 9 }),
        node("lost", [], { scope: "external", path: "/elsewhere/lost.png", state: "missing" }),
        node("e", ["a", "sub", "out", "lost"])]);
    expect(l.parents.get(`${D}/e`)).toEqual([
      entry("a"),
      { kind: "external", key: "artifact:7", label: "ref.png", thumbnailPath: `${D}/sub/ref.png` },
      { kind: "external", key: "artifact:9", label: "style.png", thumbnailPath: "/elsewhere/style.png" },
      { kind: "external", key: "lost", label: "lost.png" },
    ]);
  });

  it("prefers the reference badge path and falls back to the node key without an artifact", () => {
    const l = buildEntryLineage([member("e")], [
      node("ref", [], { scope: "external", path: null, referenceBadge: { path: "C:\\refs\\look.png" } }),
      node("e", ["ref"])]);
    expect(l.parents.get(`${D}/e`)).toEqual([{ kind: "external", key: "ref", label: "look.png", thumbnailPath: "C:\\refs\\look.png" }]);
  });

  it("does not look through external parents", () => {
    const l = buildEntryLineage([member("a"), member("e")], [
      node("a"), node("out", ["a"], { scope: "external", path: "/x/o.png", artifactId: 1 }), node("e", ["out"])]);
    expect(l.parents.get(`${D}/e`)).toEqual([{ kind: "external", key: "artifact:1", label: "o.png", thumbnailPath: "/x/o.png" }]);
  });

  it("skips running-output placeholders, as members and as parents", () => {
    const placeholder = node("o:1", ["a"], { path: null, state: "running", artifactId: null });
    const l = buildEntryLineage([member("a"), member("b")], [node("a"), placeholder, node("b", ["o:1"])]);
    // A placeholder has no file: its own parents stand in for it.
    expect(l.parents.get(`${D}/b`)).toEqual([entry("a")]);
    expect([...l.parents.keys()]).not.toContain("o:1");
    const alone = buildEntryLineage([member("a")], [node("a"), node("o:2", ["a"], { path: null, state: "running" })]);
    expect(alone.parents.size).toBe(0);
  });

  it("removes duplicates, including those from resolution and self-edges", () => {
    const l = buildEntryLineage([member("a"), member("b")], [
      node("a"), node("gone", ["a"], { state: "missing" }), node("b", ["a", "gone", "a", "b"])]);
    expect(l.parents.get(`${D}/b`)).toEqual([entry("a")]);
  });

  it("drops an edge that resolves back to the file's own path (an in-place edit)", () => {
    const l = buildEntryLineage([{ path: `${D}/a`, key: "a2" }, { path: `${D}/a`, key: "a1" }], [node("a1"), node("a2", ["a1"])]);
    expect(l.parents.size).toBe(0);
  });

  it("attaches a child of an earlier revision to the file now at that path", () => {
    const l = buildEntryLineage([member("photo.png", "v2"), member("b.png", "b")], [
      node("g"), node("v1", ["g"], { earlierRevision: true, path: `${D}/photo.png` }), node("v2", ["v1"]), node("b", ["v1"])]);
    expect(l.parents.get(`${D}/b.png`)).toEqual([entry("photo.png")]);
  });

  it("resolves a 50,000-deep chain of missing ancestors without overflowing the stack", () => {
    const nodes: LineageNode[] = [node("root"), node("m0", ["root"], { state: "missing" })];
    for (let i = 1; i < 50_000; i += 1) nodes.push(node(`m${i}`, [`m${i - 1}`], { state: "missing" }));
    nodes.push(node("leaf", ["m49999"]));
    const l = buildEntryLineage([member("root"), member("leaf")], nodes);
    expect(l.parents.get(`${D}/leaf`)).toEqual([entry("root")]);
  });

  it("returns an empty lineage for an empty folder", () => {
    const l = buildEntryLineage([], []);
    expect(l.parents.size).toBe(0);
    expect(typeof l.revision).toBe("string");
    expect(l.revision).toBe(buildEntryLineage([], []).revision);
  });

  it("survives malformed and partial input", () => {
    const bad = [null, undefined, { key: 1 }, { key: "x", parents: [null, 5, "a"] }, { key: "k", parents: "nope" }, { key: "orphan", parents: ["nowhere"] }] as unknown as LineageNode[];
    const members = [null, { path: "", key: "a" }, { path: `${D}/q`, key: 3 }, member("x"), member("orphan"), member("k"), member("a")] as never;
    const l = buildEntryLineage(members, [...bad, node("a")]);
    expect(shape(l)).toEqual({ [`${D}/x`]: [entry("a")] });
    expect(buildEntryLineage(undefined as never, undefined as never).parents.size).toBe(0);
  });

  it("terminates on cycles among missing nodes", () => {
    const l = buildEntryLineage([member("a"), member("d")], [
      node("a"), node("x", ["y", "a"], { state: "missing" }), node("y", ["x"], { state: "missing" }), node("d", ["x"])]);
    expect(l.parents.get(`${D}/d`)).toEqual([entry("a")]);
  });

  it("changes revision when lineage changes and not when unrelated node data does", () => {
    const base = [member("a"), member("b")];
    const one = buildEntryLineage(base, [node("a"), node("b", ["a"])]);
    const same = buildEntryLineage(base, [node("a", [], { order: 99 } as never), node("b", ["a"], { state: "missing" })]);
    const other = buildEntryLineage(base, [node("a"), node("b")]);
    const swapped = buildEntryLineage([member("a"), member("b"), member("c")], [node("a"), node("b"), node("c", ["a", "b"])]);
    const swapped2 = buildEntryLineage([member("a"), member("b"), member("c")], [node("a"), node("b"), node("c", ["b", "a"])]);
    expect(same.revision).toBe(one.revision);
    expect(other.revision).not.toBe(one.revision);
    expect(swapped.revision).not.toBe(swapped2.revision);
  });

  it("handles a 10,000-file folder with deep missing chains in bounded time", () => {
    const n = 10_000;
    const members = Array.from({ length: n }, (_, i) => member(`f${i}.png`, `f${i}`));
    const nodes: LineageNode[] = members.map((m, i) => node(m.key, i === 0 ? [] : [`f${i - 1}`]));
    // A long chain of deleted intermediates feeding a diamond-shaped fan-in.
    nodes.push(node("g0", ["f0"], { state: "missing" }));
    for (let i = 1; i < 2000; i += 1) nodes.push(node(`g${i}`, [`g${i - 1}`, `g${Math.max(0, i - 2)}`], { state: "missing" }));
    nodes.push(node("tail", ["g1999"]));
    members.push(member("tail.png", "tail"));
    const start = performance.now();
    const l = buildEntryLineage(members, nodes);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(l.parents.size).toBe(n); // f1..f9999 plus tail
    expect(l.parents.get(`${D}/tail.png`)).toEqual([entry("f0.png")]);
  });

  describe("labels", () => {
    const ms = [member("a"), member("b")];
    const labelled = (a: Partial<LineageNode>, b: Partial<LineageNode> = {}) => buildEntryLineage(ms, [node("a", [], a), node("b", ["a"], b)]);

    it("maps each member's prompt by path, including files without parents", () => {
      const l = labelled({ prompt: "a red fox" }, { prompt: "make it blue" });
      expect(l.labels).toEqual(new Map([[`${D}/a`, { prompt: "a red fox" }], [`${D}/b`, { prompt: "make it blue" }]]));
    });

    it("carries a title alongside the prompt", () => {
      expect(labelled({ prompt: "a red fox", title: "Red fox" }).labels?.get(`${D}/a`)).toEqual({ prompt: "a red fox", title: "Red fox" });
    });

    it("omits empty, whitespace, missing and non-string text, and files it does not describe", () => {
      const l = labelled({ prompt: "  " }, { prompt: 42 as never, title: {} as never });
      expect(l.labels).toBeUndefined();
      expect("labels" in l).toBe(false);
      const some = labelled({ prompt: "x" }, { prompt: "" });
      expect([...some.labels!.keys()]).toEqual([`${D}/a`]);
    });

    it("ignores nodes that are not members", () => {
      const l = buildEntryLineage([member("a")], [node("a"), node("ghost", [], { prompt: "orphan" })]);
      expect(l.labels).toBeUndefined();
    });

    it("bounds very long prompts and titles", () => {
      const l = labelled({ prompt: "x".repeat(5_000_000), title: "t".repeat(5_000) });
      const label = l.labels!.get(`${D}/a`)!;
      expect(label.prompt!.length).toBeLessThanOrEqual(2000);
      expect(label.title!.length).toBeLessThanOrEqual(200);
    });

    it("changes the revision when only a prompt or title changes, and not otherwise", () => {
      const base = labelled({ prompt: "one" });
      expect(labelled({ prompt: "one" }).revision).toBe(base.revision);
      expect(labelled({ prompt: "two" }).revision).not.toBe(base.revision);
      expect(labelled({ prompt: "one", title: "T" }).revision).not.toBe(base.revision);
      expect(labelled({}).revision).not.toBe(base.revision);
    });

    it("keeps the unlabelled revision unchanged by the labels feature", () => {
      expect(buildEntryLineage(ms, [node("a"), node("b", ["a"])]).revision).toBe(labelled({ prompt: "" }).revision);
    });

    it("labels a 10,000-file folder within the bound", () => {
      const members = Array.from({ length: 10_000 }, (_, i) => member(`f${i}.png`, `f${i}`));
      const nodes = members.map((m, i) => node(m.key, i ? [`f${i - 1}`] : [], { prompt: `prompt ${i}` }));
      const start = performance.now();
      const l = buildEntryLineage(members, nodes);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(l.labels!.size).toBe(10_000);
      expect(l.labels!.get(`${D}/f9999.png`)).toEqual({ prompt: "prompt 9999" });
    });
  });
});
