import { describe, expect, it } from "vitest";
import { describeInputSnapshot, describeInputs, imageInputPaths, inputRequestFields, mergeDroppedImageInputs, moveInput, removeInput, singleImagePath, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";

const inputs: ImageInput[] = ["/a.png", "/b.jpg", "/c.webp"].map((path) => ({ path }));
const paths = (list: readonly ImageInput[]) => list.map((input) => input.path);

describe("dropped image inputs", () => {
  const inspected = (paths: readonly string[]) => new Map(paths.map((path) => [path, { path, digest: `digest:${path}`, size: { width: 160, height: 96 } }]));
  it("appends supported files in delivery order, including uppercase and native Windows paths", () => {
    const delivered = ["/b.JPG", "C:\\pictures\\a.PNG", "\\\\server\\share\\c.WebP", "/d.jpeg"];
    const result = mergeDroppedImageInputs([], delivered, inspected(delivered));
    expect(paths(result.inputs)).toEqual(delivered);
    expect(result.addedPaths).toEqual(delivered);
    expect(result.issues).toEqual([]);
    expect(mergeDroppedImageInputs([], [], new Map())).toEqual({ inputs: [], addedPaths: [], issues: [] });
  });
  it("keeps existing order, pinned metadata and immutable arguments", () => {
    const existing = Object.freeze([Object.freeze({ path: "/old.png", digest: "pinned", size: Object.freeze({ width: 1, height: 2 }) })]);
    const delivered = Object.freeze(["/new.webp", "/old.png", "/new.webp"]);
    const descriptions = inspected(delivered);
    const before = structuredClone([...descriptions]);
    const result = mergeDroppedImageInputs(existing, delivered, descriptions);
    expect(result.inputs[0]).toBe(existing[0]);
    expect(result.inputs[0]).toEqual({ path: "/old.png", digest: "pinned", size: { width: 1, height: 2 } });
    expect(result.addedPaths).toEqual(["/new.webp"]);
    expect(result.issues).toEqual([
      { path: "/old.png", code: "duplicate", message: "Already an input" },
      { path: "/new.webp", code: "duplicate", message: "Already an input" },
    ]);
    expect([...descriptions]).toEqual(before);
    expect(delivered).toEqual(["/new.webp", "/old.png", "/new.webp"]);
  });
  it("reports every malformed, relative, URL, virtual and NUL path without coercion", () => {
    const malformed = [null, undefined, 42, {}, [], true, "", "photo.png", "./photo.png", "../photo.png", "C:photo.png", "\\photo.png",
      "https://example.com/photo.png", "file:///photo.png", "demo://photo.png", "data:image/png;base64,a.png", "/bad\0.png"];
    const result = mergeDroppedImageInputs([], malformed, new Map());
    expect(result.inputs).toEqual([]);
    expect(result.issues).toHaveLength(malformed.length);
    expect(result.issues.every((issue) => issue.code === "invalid-path")).toBe(true);
    expect(result.issues[0].path).toBeNull();
    expect(result.issues[3].path).toBeNull();
    expect(imageInputPaths(malformed as string[])).toEqual([]);
  });
  it("partially accepts a mixed batch and rejects absent, failed and incomplete inspections", () => {
    const delivered = ["/a.png", "/animated.gif", "/bad.jpg", "/missing.png", "/incomplete.webp", "/b.webp"];
    const descriptions: Map<string, ImageInput> = inspected(["/a.png", "/b.webp"]);
    descriptions.set("/bad.jpg", { path: "/bad.jpg", error: "Permission denied" });
    descriptions.set("/incomplete.webp", { path: "/incomplete.webp" });
    const result = mergeDroppedImageInputs([], delivered, descriptions);
    expect(result.addedPaths).toEqual(["/a.png", "/b.webp"]);
    expect(result.issues).toEqual([
      { path: "/animated.gif", code: "unsupported-format", message: "Unsupported format. Use PNG, JPEG or WebP" },
      { path: "/bad.jpg", code: "unreadable", message: "Cannot read image: Permission denied" },
      { path: "/missing.png", code: "unreadable", message: "Cannot read image: inspection unavailable" },
      { path: "/incomplete.webp", code: "unreadable", message: "Cannot read image: inspection unavailable" },
    ]);
  });
  it("uses exact-string duplicate identity, including duplicates of unreadable files", () => {
    const result = mergeDroppedImageInputs([{ path: "/a.png" }], ["/A.png", "/bad.png", "/bad.png"], inspected(["/A.png"]));
    expect(result.addedPaths).toEqual(["/A.png"]);
    expect(result.issues).toEqual(expect.arrayContaining([
      { path: "/bad.png", code: "duplicate", message: "Already an input" },
      { path: "/bad.png", code: "unreadable", message: "Cannot read image: inspection unavailable" },
    ]));
  });
  it("accepts the next readable file into slot eight and explains overflow, even when already full", () => {
    const existing = Array.from({ length: 7 }, (_, i) => ({ path: `/existing-${i}.png` }));
    const delivered = ["/bad.png", "/fits.jpg", "/ninth.webp"];
    const result = mergeDroppedImageInputs(existing, delivered, inspected(["/fits.jpg", "/ninth.webp"]));
    expect(paths(result.inputs)).toEqual([...paths(existing), "/fits.jpg"]);
    expect(result.issues).toEqual([
      { path: "/bad.png", code: "unreadable", message: "Cannot read image: inspection unavailable" },
      { path: "/ninth.webp", code: "limit", message: "Up to 8 inputs" },
    ]);
    const full = mergeDroppedImageInputs(result.inputs, ["/tenth.png", "/fits.jpg", "/no.gif"], new Map());
    expect(full.addedPaths).toEqual([]);
    expect(full.issues.map((issue) => issue.code)).toEqual(["duplicate", "unsupported-format", "limit"]);
  });
  it("merges against a reordered/removed arrangement without restoring removed inputs", () => {
    const arranged = removeInput(moveInput(inputs, 2, 0), 1);
    const result = mergeDroppedImageInputs(arranged, ["/a.png", "/c.webp"], inspected(["/a.png"]));
    expect(paths(result.inputs)).toEqual(["/c.webp", "/b.jpg", "/a.png"]);
    expect(result.issues[0].code).toBe("duplicate");
  });
  it("handles a very large batch in linear work and explains every skipped file", () => {
    const delivered = Array.from({ length: 100_000 }, (_, i) => `/drop-${i}.png`);
    const result = mergeDroppedImageInputs([], delivered, inspected(delivered.slice(0, 8)));
    expect(result.addedPaths).toEqual(delivered.slice(0, 8));
    expect(result.issues).toHaveLength(99_992);
    expect(result.issues[0]).toEqual({ path: "/drop-8.png", code: "limit", message: "Up to 8 inputs" });
    expect(result.issues.at(-1)?.path).toBe("/drop-99999.png");
  });
});

describe("AI edit inputs", () => {
  it("accepts one to eight distinct local images, in order", () => {
    expect(imageInputPaths(["/b.JPG", "/a.png"])).toEqual(["/b.JPG", "/a.png"]);
    for (const invalid of [[], ["/a.png", "/a.png"], ["/a.gif"], ["demo://a.png"], Array.from({ length: 9 }, (_, i) => `/${i}.png`)]) {
      expect(imageInputPaths(invalid)).toEqual([]);
    }
  });

  it("removes an input and renumbers the rest, but never the last one", () => {
    expect(paths(removeInput(inputs, 0))).toEqual(["/b.jpg", "/c.webp"]);
    expect(paths(removeInput(inputs, 1))).toEqual(["/a.png", "/c.webp"]);
    const one = [inputs[0]];
    expect(removeInput(one, 0)).toBe(one);
    expect(removeInput(inputs, 7)).toBe(inputs);
    expect(removeInput(inputs, -1)).toBe(inputs);
  });

  it("moves an input to a new position, clamped to the strip", () => {
    expect(paths(moveInput(inputs, 2, 0))).toEqual(["/c.webp", "/a.png", "/b.jpg"]);
    expect(paths(moveInput(inputs, 0, 1))).toEqual(["/b.jpg", "/a.png", "/c.webp"]);
    expect(paths(moveInput(inputs, 0, 99))).toEqual(["/b.jpg", "/c.webp", "/a.png"]);
    expect(moveInput(inputs, 1, 1)).toBe(inputs);
    expect(moveInput(inputs, 5, 0)).toBe(inputs);
  });

  it("sends inputs in the shown order, pinning the revisions it knows", () => {
    const described = describeInputs(inputs, [
      { path: "/c.webp", digest: "c", size: { width: 3, height: 1 } }, { path: "/a.png", digest: "a" }, { path: "/b.jpg", digest: "b" },
    ]);
    expect(inputRequestFields(moveInput(described, 2, 0))).toEqual({
      sourcePath: "/c.webp", expectedSourceDigest: "c", referencePaths: ["/a.png", "/b.jpg"], expectedReferenceDigests: ["a", "b"],
    });
    expect(inputRequestFields(inputs)).toEqual({ sourcePath: "/a.png", referencePaths: ["/b.jpg", "/c.webp"] });
    expect(inputRequestFields([{ path: "/a.png", digest: "a" }])).toEqual({ sourcePath: "/a.png", expectedSourceDigest: "a", referencePaths: [] });
    expect(inputRequestFields([])).toEqual({ sourcePath: null, referencePaths: [] });
  });

  it("pins Image 1 from the editor even when the other images could not be described", () => {
    // describeImageInputs failed: only the editor's capture of Image 1 is known.
    const known: ImageInput[] = [{ path: "/a.png", digest: "shown", size: { width: 4, height: 3 } }, { path: "/b.jpg" }];
    expect(inputRequestFields(known)).toEqual({ sourcePath: "/a.png", expectedSourceDigest: "shown", referencePaths: ["/b.jpg"] });
    // References are pinned as one list: all or none.
    expect(inputRequestFields([{ path: "/a.png" }, { path: "/b.jpg", digest: "b" }, { path: "/c.webp" }]))
      .toEqual({ sourcePath: "/a.png", referencePaths: ["/b.jpg", "/c.webp"] });
    expect(inputRequestFields([{ path: "/a.png" }, { path: "/b.jpg", digest: "b" }]))
      .toEqual({ sourcePath: "/a.png", referencePaths: ["/b.jpg"], expectedReferenceDigests: ["b"] });
  });

  it("follows what the caller learns later, keeping the arrangement made here", () => {
    // The editor opened the dialog before its preview had loaded: no size yet.
    const arranged = moveInput([{ path: "/a.png", digest: "a" }, { path: "/b.jpg", digest: "b" }], 1, 0);
    const live: ImageInput[] = [{ path: "/a.png", digest: "a", size: { width: 8, height: 6 } }, { path: "/b.jpg" }];
    expect(withLiveInputs(arranged, live)).toEqual([{ path: "/b.jpg", digest: "b" }, { path: "/a.png", digest: "a", size: { width: 8, height: 6 } }]);
    // A removed image stays removed; an unusable one stays unusable.
    expect(withLiveInputs([{ path: "/b.jpg", error: "Path not found" }], live)).toEqual([{ path: "/b.jpg", error: "Path not found" }]);
    expect(withLiveInputs(removeInput(arranged, 0), live)).toEqual([{ path: "/a.png", digest: "a", size: { width: 8, height: 6 } }]);
    // Nothing new: the same inputs.
    const same = [{ path: "/b.jpg", digest: "b" }];
    expect(withLiveInputs(same, live)[0]).toBe(same[0]);
    expect(withLiveInputs(same, [])).toEqual(same);
  });

  it("keeps a revision the editor pinned and marks unusable images", () => {
    const merged = describeInputs([{ path: "/a.png", digest: "shown", size: { width: 4, height: 3 } }, { path: "/b.jpg" }, { path: "/c.webp" }],
      [{ path: "/a.png", digest: "disk", size: { width: 8, height: 6 } }, { path: "/b.jpg", error: "Path not found" }]);
    expect(merged).toEqual([
      { path: "/a.png", digest: "shown", size: { width: 4, height: 3 }, error: undefined },
      { path: "/b.jpg", error: "Path not found" },
      { path: "/c.webp" },
    ]);
  });

  it("applies a captured read after reorder/removal without overwriting a removed and re-dropped image", () => {
    const captured = [{ path: "/a.png" }, { path: "/b.jpg" }, { path: "/c.webp" }];
    const newer = { path: "/a.png", digest: "new-inspection", size: { width: 80, height: 60 } };
    const current = [captured[2], captured[1], newer];
    expect(describeInputSnapshot(current, captured, [
      { path: "/a.png", error: "An older read failed" }, { path: "/b.jpg", digest: "b" }, { path: "/c.webp", digest: "c" },
    ])).toEqual([{ path: "/c.webp", digest: "c", error: undefined, size: undefined },
      { path: "/b.jpg", digest: "b", error: undefined, size: undefined }, newer]);
    expect(describeInputSnapshot([captured[1]], captured, [{ path: "/a.png", digest: "a" }])).toEqual([captured[1]]);
  });
});

describe("single image for the host editor", () => {
  const file = (path: string) => ({ path, kind: "file" as const });
  it("returns the path of exactly one local PNG, JPEG or WebP file", () => {
    expect(singleImagePath([file("/m/a.png")])).toBe("/m/a.png");
    expect(singleImagePath([file("/m/a.JPG")])).toBe("/m/a.JPG");
    expect(singleImagePath([file("C:\\m\\a.WebP")])).toBe("C:\\m\\a.WebP");
  });
  it("is null for none, several, a directory, a non-image or a virtual-filesystem entry", () => {
    expect(singleImagePath([])).toBeNull();
    expect(singleImagePath([file("/m/a.png"), file("/m/b.png")])).toBeNull();
    expect(singleImagePath([{ path: "/m/dir.png", kind: "directory" }])).toBeNull();
    expect(singleImagePath([file("/m/a.gif")])).toBeNull();
    expect(singleImagePath([file("/m/a")])).toBeNull();
    expect(singleImagePath([file("demo://a.png")])).toBeNull();
  });
  it("follows a Trace view's picks when there are any", () => {
    expect(singleImagePath([file("/m/a.png")], ["/m/a.png", "/tmp/unsaved.png"])).toBeNull();
    expect(singleImagePath([file("/m/a.png")], ["/m/a.png"])).toBe("/m/a.png");
    expect(singleImagePath([file("/m/a.png")], ["/m/b.png"])).toBeNull();
    expect(singleImagePath([], ["/m/a.png"])).toBeNull();
    expect(singleImagePath([file("/m/a.png")], [])).toBe("/m/a.png");
  });
});
