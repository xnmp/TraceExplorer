import { describe, expect, it } from "vitest";
import { outputLocationProblem } from "$lib/domain/target-location";

describe("AI image output location", () => {
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
