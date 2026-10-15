import { describe, expect, it } from "vitest";
import { DOUBLE_CLICK_MS, reclickStep, type PendingToggle, type ReclickEvent } from "$lib/plugins/trace/view/reclick";

/** Runs events from no pending toggle; returns every key toggled and what is left pending. */
function run(events: ReclickEvent[]): { toggled: string[]; pending: PendingToggle | null } {
  let pending: PendingToggle | null = null;
  const toggled: string[] = [];
  for (const event of events) {
    const step = reclickStep(pending, event);
    pending = step.pending;
    if (step.toggle) toggled.push(step.toggle);
  }
  return { toggled, pending };
}

describe("re-click toggle", () => {
  it("toggles a single re-click once the double-click window has passed, not before", () => {
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: DOUBLE_CLICK_MS - 1 }]).toggled).toEqual([]);
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: DOUBLE_CLICK_MS }]).toggled).toEqual(["a"]);
    // It fires once.
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: DOUBLE_CLICK_MS }, { kind: "tick", at: 2 * DOUBLE_CLICK_MS }]).toggled).toEqual(["a"]);
  });

  it("waits out the slowest common platform double click (Windows' default, 500 ms)", () => {
    // A slow double click whose second press comes 480 ms later must not toggle first.
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: 480 }, { kind: "press", at: 480 }]).toggled).toEqual([]);
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: 500 }]).toggled).toEqual(["a"]);
  });

  it("a double click never toggles: its second press, its double-click event or a second re-click cancels", () => {
    for (const second of [{ kind: "press", at: 150 }, { kind: "dblclick" }, { kind: "reclick", key: "a", at: 150 }] as ReclickEvent[]) {
      const { toggled, pending } = run([{ kind: "press", at: 0 }, { kind: "reclick", key: "a", at: 5 }, second, { kind: "tick", at: 1000 }]);
      expect(toggled, second.kind).toEqual([]);
      expect(pending).toBeNull();
    }
  });

  it("pane, folder and selection changes cancel; a press after the window does not", () => {
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "cancel" }, { kind: "tick", at: 1000 }]).toggled).toEqual([]);
    // A late press (the next interaction) cannot cancel a toggle already due; the tick fires it.
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "press", at: DOUBLE_CLICK_MS + 1 }, { kind: "tick", at: DOUBLE_CLICK_MS + 2 }]).toggled).toEqual(["a"]);
  });

  it("slow re-clicks each toggle, and the latest key is the one toggled", () => {
    expect(run([
      { kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: DOUBLE_CLICK_MS },
      { kind: "reclick", key: "a", at: 1000 }, { kind: "tick", at: 1000 + DOUBLE_CLICK_MS },
    ]).toggled).toEqual(["a", "a"]);
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "reclick", key: "b", at: 2 * DOUBLE_CLICK_MS }, { kind: "tick", at: 3 * DOUBLE_CLICK_MS }]).toggled).toEqual(["b"]);
  });

  it("ignores ticks with nothing pending, and malformed times never toggle early", () => {
    expect(run([{ kind: "tick", at: 0 }]).toggled).toEqual([]);
    expect(run([{ kind: "reclick", key: "a", at: 0 }, { kind: "tick", at: Number.NaN }]).toggled).toEqual([]);
  });
});
