import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { selectedTraceImage } from "$lib/domain/trace-selection";

const file = (name: string, path = `/images/${name}`, kind: FileEntry["kind"] = "file"): FileEntry => ({ name, path, kind, size: 32, modified: "2026-10-07" });

describe("trace image selection", () => {
  it("accepts a single local raster or SVG image", () => {
    for (const name of ["image.png", "image.JPG", "image.svg", "image.WEBP"]) {
      const image = file(name);
      expect(selectedTraceImage([image])).toEqual(image);
    }
  });
  it("leaves the viewed image unchanged for unsupported selections", () => {
    for (const selection of [[], [file("note.txt")], [file("folder.png", "/images/folder.png", "directory")], [file("image.png", "archive://image.png")], [file("a.png"), file("b.png")]]) {
      expect(selectedTraceImage(selection)).toBeNull();
    }
  });
});
