import { describe, expect, it } from "vitest";
import { insetBottom } from "$lib/plugins/trace/view/motion";

describe("reading a section's displayed clip", () => {
  it("reads the bottom inset from every form an engine serializes", () => {
    expect(insetBottom("inset(0px 0px 12.5px 0px round 5px)")).toBe(12.5);
    expect(insetBottom("inset(0px 0px 12.5px round 5px)")).toBe(12.5);
    expect(insetBottom("inset(3px 0px)")).toBe(3);
    expect(insetBottom("inset(7px)")).toBe(7);
    expect(insetBottom("  inset(1px 2px 3px 4px)  ")).toBe(3);
  });

  it("treats no clip, other shapes and malformed values as unclipped", () => {
    for (const value of ["none", "", "circle(50%)", "inset()", "inset(a b c)", "inset(0px 0px 4px", "polygon(0 0, 1px 1px)"]) {
      expect(insetBottom(value), value).toBe(0);
    }
  });
});
