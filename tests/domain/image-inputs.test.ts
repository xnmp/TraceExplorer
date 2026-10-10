import { describe, expect, it } from "vitest";
import { describeInputs, imageInputPaths, inputRequestFields, moveInput, removeInput, singleImagePath, withLiveInputs, type ImageInput } from "$lib/domain/image-inputs";

const inputs: ImageInput[] = ["/a.png", "/b.jpg", "/c.webp"].map((path) => ({ path }));
const paths = (list: readonly ImageInput[]) => list.map((input) => input.path);

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
