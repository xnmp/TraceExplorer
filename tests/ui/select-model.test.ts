import { describe, expect, it } from "vitest";
import { NONE, emptyTypeahead, initialActive, keyAction, move, place, typeahead, typeaheadMatch, type SelectOption } from "../../integration/ui/select-model";

const opts = (...labels: string[]): SelectOption[] => labels.map((l) => (l.startsWith("!") ? { value: l.slice(1), label: l.slice(1), disabled: true } : { value: l, label: l }));
const fruit = opts("Apple", "Apricot", "Banana", "Blueberry", "Cherry");

describe("initialActive", () => {
  it("is the selected option", () => expect(initialActive(fruit, "Banana")).toBe(2));
  it("falls back to the first enabled option when the value matches nothing", () => expect(initialActive(opts("!A", "B"), "zzz")).toBe(1));
  it("falls back when the selected option is disabled", () => expect(initialActive(opts("A", "!B"), "B")).toBe(0));
  it("is NONE for empty or all-disabled lists", () => {
    expect(initialActive([], "x")).toBe(NONE);
    expect(initialActive(opts("!A", "!B"), "A")).toBe(NONE);
  });
});

describe("move", () => {
  it("steps and clamps at the ends", () => {
    expect(move(fruit, 0, "next")).toBe(1);
    expect(move(fruit, 4, "next")).toBe(4);
    expect(move(fruit, 0, "prev")).toBe(0);
  });
  it("skips disabled options", () => {
    const o = opts("A", "!B", "!C", "D");
    expect(move(o, 0, "next")).toBe(3);
    expect(move(o, 3, "prev")).toBe(0);
  });
  it("does not move onto a trailing disabled option", () => expect(move(opts("A", "!B"), 0, "next")).toBe(0));
  it("jumps to the first and last enabled options", () => {
    const o = opts("!A", "B", "C", "!D");
    expect(move(o, 2, "first")).toBe(1);
    expect(move(o, 1, "last")).toBe(2);
  });
  it("pages by ten and clamps", () => {
    const many = opts(...Array.from({ length: 25 }, (_, i) => `o${i}`));
    expect(move(many, 2, "pageDown")).toBe(12);
    expect(move(many, 20, "pageDown")).toBe(24);
    expect(move(many, 3, "pageUp")).toBe(0);
  });
  it("starts from the ends when nothing is active", () => {
    expect(move(fruit, NONE, "next")).toBe(0);
    expect(move(fruit, NONE, "prev")).toBe(4);
  });
  it("returns NONE for empty or all-disabled lists", () => {
    expect(move([], NONE, "next")).toBe(NONE);
    expect(move(opts("!A"), NONE, "first")).toBe(NONE);
    expect(move(opts("!A"), NONE, "last")).toBe(NONE);
  });
});

describe("typeahead", () => {
  it("accumulates characters typed quickly and resets after a pause", () => {
    const a = typeahead(emptyTypeahead, "B", 1000);
    expect(typeahead(a, "l", 1200).text).toBe("bl");
    expect(typeahead(a, "l", 1700).text).toBe("l");
  });
  it("matches by prefix, case-insensitively", () => expect(typeaheadMatch(fruit, 0, "bl")).toBe(3));
  it("a single letter finds the next match after the active option", () => expect(typeaheadMatch(fruit, 0, "a")).toBe(1));
  it("repeating the same letter cycles with wraparound", () => {
    expect(typeaheadMatch(fruit, 0, "aa")).toBe(1);
    expect(typeaheadMatch(fruit, 1, "aaa")).toBe(0);
  });
  it("a longer prefix keeps the current option when it still matches", () => expect(typeaheadMatch(fruit, 1, "ap")).toBe(1));
  it("wraps past the end", () => expect(typeaheadMatch(fruit, 4, "b")).toBe(2));
  it("ignores disabled options and returns NONE with no match, empty text or no options", () => {
    expect(typeaheadMatch(opts("!Apple", "Avocado"), NONE, "a")).toBe(1);
    expect(typeaheadMatch(fruit, 0, "z")).toBe(NONE);
    expect(typeaheadMatch(fruit, 0, "")).toBe(NONE);
    expect(typeaheadMatch([], NONE, "a")).toBe(NONE);
  });
});

describe("keyAction", () => {
  it("opens when closed", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) expect(keyAction(false, { key })).toEqual({ type: "open", at: "selected" });
    expect(keyAction(false, { key: "ArrowDown", altKey: true })).toEqual({ type: "open", at: "selected" });
    expect(keyAction(false, { key: "Home" })).toEqual({ type: "open", at: "first" });
    expect(keyAction(false, { key: "End" })).toEqual({ type: "open", at: "last" });
  });
  it("moves, selects and closes when open", () => {
    expect(keyAction(true, { key: "ArrowDown" })).toEqual({ type: "move", how: "next" });
    expect(keyAction(true, { key: "PageUp" })).toEqual({ type: "move", how: "pageUp" });
    expect(keyAction(true, { key: "Enter" })).toEqual({ type: "selectActive" });
    expect(keyAction(true, { key: " " })).toEqual({ type: "selectActive" });
    expect(keyAction(true, { key: "ArrowUp", altKey: true })).toEqual({ type: "select", close: true });
    expect(keyAction(true, { key: "Escape" })).toEqual({ type: "close" });
    expect(keyAction(true, { key: "Tab" })).toEqual({ type: "tab" });
  });
  it("treats printable characters as typeahead and leaves shortcuts alone", () => {
    expect(keyAction(false, { key: "b" })).toEqual({ type: "type", char: "b" });
    expect(keyAction(true, { key: "b" })).toEqual({ type: "type", char: "b" });
    expect(keyAction(false, { key: "a", ctrlKey: true })).toBeNull();
    expect(keyAction(false, { key: "Shift" })).toBeNull();
    expect(keyAction(false, { key: "Escape" })).toBeNull();
  });
});

describe("place", () => {
  const viewport = { width: 1000, height: 800 };
  const trigger = (top: number) => ({ top, bottom: top + 34, left: 100, width: 200 });
  it("opens below when it fits", () => {
    const p = place(trigger(100), viewport, { width: 200, height: 200 });
    expect(p).toMatchObject({ side: "below", top: 138, left: 100, minWidth: 200 });
  });
  it("flips above when there is too little room below and more above", () => {
    const p = place(trigger(700), viewport, { width: 200, height: 200 });
    expect(p.side).toBe("above");
    expect(p.top + 200).toBe(696);
  });
  it("stays below and scrolls when neither side fits but below is larger", () => {
    const p = place(trigger(100), { width: 1000, height: 300 }, { width: 200, height: 500 });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(300 - 134 - 4 - 8);
  });
  it("limits maxHeight to the room on the chosen side", () => {
    const p = place(trigger(500), viewport, { width: 200, height: 900 });
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(488);
  });
  it("keeps the popup inside the viewport horizontally", () => {
    expect(place({ top: 0, bottom: 34, left: 900, width: 200 }, viewport, { width: 200, height: 100 }).left).toBe(792);
    expect(place({ top: 0, bottom: 34, left: -50, width: 200 }, viewport, { width: 200, height: 100 }).left).toBe(8);
  });
  it("shifts a popup wider than its trigger left so its right edge stays in the viewport", () => {
    const p = place({ top: 0, bottom: 34, left: 800, width: 100 }, viewport, { width: 400, height: 100 });
    expect(p.left).toBe(592);
    expect(p.left + 400).toBeLessThanOrEqual(1000 - 8);
  });
  it("pins a popup as wide as the viewport to the margin", () => expect(place({ top: 0, bottom: 34, left: 300, width: 100 }, viewport, { width: 2000, height: 100 }).left).toBe(8));
  it("survives a trigger outside the viewport", () => {
    const p = place({ top: 2000, bottom: 2034, left: 0, width: 10 }, viewport, { width: 10, height: 100 });
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });
});
