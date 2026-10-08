import { describe, expect, it } from "vitest";
import { describeInputs, imageInputPaths, inputRequestFields, moveInput, removeInput, type ImageInput } from "$lib/domain/image-inputs";

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

  it("sends inputs in the shown order, pinning revisions only when every image has one", () => {
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
