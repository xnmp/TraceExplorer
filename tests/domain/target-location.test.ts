import { describe, expect, it } from "vitest";
import { aiOutputDirectory, outputLocationProblem } from "$lib/domain/target-location";

describe("AI image output location", () => {
  it("suggests the local pane folder for both edits and generation", () => {
    expect(aiOutputDirectory("/output", [])).toBe("/output");
    expect(aiOutputDirectory("/output", ["/inputs/a.png"])).toBe("/output");
  });

  it("falls back to the first input's local folder for virtual, search or unavailable panes", () => {
    for (const directory of ["demo://pictures", "search://images", "relative", "", null, undefined, "/bad\0", `/${"a".repeat(4096)}`]) {
      expect(aiOutputDirectory(directory, ["/inputs/a.png", "/other/b.png"])).toBe("/inputs");
      expect(aiOutputDirectory(directory, ["C:\\Images\\a.png"])).toBe("C:/Images");
      expect(outputLocationProblem(aiOutputDirectory(directory, []))).not.toBeNull();
    }
  });

  it("does not invent an output folder from a nonlocal or malformed input", () => {
    for (const inputs of [[], ["demo://a.png"], ["relative.png"], ["/bad\0.png"]]) {
      expect(aiOutputDirectory("search://images", inputs)).toBe("search://images");
    }
  });
  it("accepts local pane folders, including drive and network roots", () => {
    for (const folder of ["/", "/pictures", "C:\\", "C:\\Pictures", "C:/Pictures", "\\\\server\\share", "//server/share"]) {
      expect(outputLocationProblem(folder)).toBeNull();
    }
  });

  it("gives actionable guidance for unavailable, virtual and malformed locations", () => {
    expect(outputLocationProblem("")).toMatch(/Select a local folder.*context menu.*update the host/);
    for (const folder of ["demo://pictures", "search://images", "relative/folder", "C:pictures", "/pictures\0", `/${"a".repeat(4096)}`]) {
      expect(outputLocationProblem(folder)).toMatch(/Open a local output folder.*Ctrl\+E again/);
    }
  });
});
