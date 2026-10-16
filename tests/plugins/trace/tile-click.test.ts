import { describe, expect, it, vi } from "vitest";
import { isTileReclick, tileDoubleClick } from "$lib/plugins/trace/view/tile-click";

describe("tile activation", () => {
  const selected = { focusedKey: "a", selectedKeys: new Set(["a"]), selectedPaths: new Set(["/a.png"]) };

  it("treats every plain click on the sole focused selection as a re-click, including unlisted picks", () => {
    expect(isTileReclick("a", selected, {})).toBe(true);
    const secondClick = { ctrlKey: false, detail: 2 };
    expect(isTileReclick("a", selected, secondClick)).toBe(true);
    expect(isTileReclick("a", { ...selected, selectedPaths: new Set() }, {})).toBe(true);
    expect(isTileReclick("b", selected, {})).toBe(false);
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"])("keeps %s clicks as selection actions", (modifier) => {
    expect(isTileReclick("a", selected, { [modifier]: true })).toBe(false);
  });

  it("does not re-click an unfocused tile or one member of a multiple selection", () => {
    expect(isTileReclick("a", { ...selected, focusedKey: undefined }, {})).toBe(false);
    expect(isTileReclick("a", { ...selected, selectedKeys: new Set(["a", "b"]) }, {})).toBe(false);
    expect(isTileReclick("a", { ...selected, selectedPaths: new Set(["/a.png", "/notes.txt"]) }, {})).toBe(false);
  });

  it("reports unavailable double-clicks through the host toast without opening", () => {
    const open = vi.fn(), show = vi.fn();
    tileDoubleClick(true, open, { show, error: vi.fn() });
    expect(open).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledExactlyOnceWith("Double-click isn't available in Trace view", "info");
  });

  it("ignores expandable double-clicks when the host has no toast service", () => {
    const open = vi.fn();
    expect(() => tileDoubleClick(true, open)).not.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a leaf once without a toast", () => {
    const open = vi.fn(), show = vi.fn();
    tileDoubleClick(false, open, { show, error: vi.fn() });
    expect(open).toHaveBeenCalledExactlyOnceWith();
    expect(show).not.toHaveBeenCalled();
  });
});
