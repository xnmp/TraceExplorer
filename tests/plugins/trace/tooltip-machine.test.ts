import { describe, expect, it } from "vitest";
import { deadline, initialTooltipState, stepTooltip, visibleTarget, type TooltipEvent, type TooltipState, type TooltipTiming } from "$lib/plugins/trace/view/tooltip/machine";

const TIMING: TooltipTiming = { coldDelay: 400, warmDelay: 0, warmWindow: 500 };
type T = string;

/** Runs events in order; a `tick` is delivered only if a deadline has passed, as a real timer would. */
function run(events: ReadonlyArray<TooltipEvent<T>>, timing = TIMING, from: TooltipState<T> = initialTooltipState<T>()): TooltipState<T> {
  return events.reduce((state, event) => stepTooltip(state, event, timing), from);
}
const enter = (target: T, at: number): TooltipEvent<T> => ({ type: "enter", target, at });
const leave = (target: T, at: number): TooltipEvent<T> => ({ type: "leave", target, at });
const tick = (at: number): TooltipEvent<T> => ({ type: "tick", at });

describe("cold delay", () => {
  it("opens only once the cold delay has passed", () => {
    const pending = run([enter("a", 1000)]);
    expect(visibleTarget(pending)).toBeNull();
    expect(deadline(pending)).toBe(1400);
    expect(visibleTarget(run([tick(1399)], TIMING, pending))).toBeNull();
    expect(visibleTarget(run([tick(1400)], TIMING, pending))).toBe("a");
  });

  it("an early tick keeps the deadline, so the caller can reschedule", () => {
    const early = run([enter("a", 0), tick(399.6)]);
    expect(visibleTarget(early)).toBeNull();
    expect(deadline(early)).toBe(400);
  });

  it("re-entering the pending target does not restart the delay", () => {
    expect(deadline(run([enter("a", 0), enter("a", 300)]))).toBe(400);
  });

  it("first open is not instant (it animates in)", () => {
    expect(run([enter("a", 0), tick(400)]).instant).toBe(false);
  });

  it("needs no timer when idle or open", () => {
    expect(deadline(initialTooltipState())).toBeNull();
    expect(deadline(run([enter("a", 0), tick(400)]))).toBeNull();
  });
});

describe("rapid enter and leave", () => {
  it("never shows a tooltip for targets crossed before the delay", () => {
    const events: TooltipEvent<T>[] = [];
    for (let index = 0; index < 50; index++) {
      const at = index * 120;
      events.push(enter(`t${index}`, at), tick(at + 60), leave(`t${index}`, at + 100), tick(at + 110));
    }
    let state = initialTooltipState<T>();
    for (const event of events) {
      state = stepTooltip(state, event, TIMING);
      expect(visibleTarget(state)).toBeNull();
    }
    // Nothing became warm either: the next target still waits the full delay.
    expect(deadline(run([enter("z", 6000)], TIMING, state))).toBe(6400);
  });

  it("leaving cancels the pending tooltip even if its deadline passes later", () => {
    expect(visibleTarget(run([enter("a", 0), leave("a", 200), tick(500)]))).toBeNull();
  });
});

describe("warm hand-off", () => {
  const opened = () => run([enter("a", 0), tick(400)]);

  it("opens the next target at once after leaving an open tooltip", () => {
    const next = run([leave("a", 1000), enter("b", 1080)], TIMING, opened());
    expect(visibleTarget(next)).toBe("b");
    expect(next.instant).toBe(true);
  });

  it("moving straight from one target to another hands off without a gap", () => {
    expect(visibleTarget(run([enter("b", 900)], TIMING, opened()))).toBe("b");
  });

  it("uses the warm delay when one is configured", () => {
    const timing = { ...TIMING, warmDelay: 50 };
    const next = run([leave("a", 1000), enter("b", 1100)], timing, run([enter("a", 0), tick(400)], timing));
    expect(visibleTarget(next)).toBeNull();
    expect(deadline(next)).toBe(1150);
    expect(visibleTarget(run([tick(1150)], timing, next))).toBe("b");
  });

  it("cools down once the warm window has passed", () => {
    const late = run([leave("a", 1000), enter("b", 1500)], TIMING, opened());
    expect(visibleTarget(late)).toBeNull();
    expect(deadline(late)).toBe(1900);
    expect(late.instant).toBe(false);
    expect(visibleTarget(run([enter("b", 1499)], TIMING, run([leave("a", 1000)], TIMING, opened())))).toBe("b");
  });

  it("leaving a target that is not the current one changes nothing", () => {
    const state = opened();
    expect(run([leave("b", 900)], TIMING, state)).toBe(state);
  });
});

describe("dismissal", () => {
  const opened = () => run([enter("a", 0), tick(400)]);

  it.each(["scroll", "blur", "resize", "escape", "press"] as const)("%s hides the tooltip and cools down", (reason) => {
    const dismissed = run([{ type: "dismiss", reason, at: 600 }], TIMING, opened());
    expect(visibleTarget(dismissed)).toBeNull();
    // No warm hand-off after a dismissal: the next tooltip waits the full delay.
    expect(deadline(run([enter("b", 650)], TIMING, dismissed))).toBe(1050);
  });

  it.each(["scroll", "blur", "escape", "press"] as const)("%s cancels a pending tooltip", (reason) => {
    expect(visibleTarget(run([enter("a", 0), { type: "dismiss", reason, at: 200 }, tick(400)]))).toBeNull();
  });

  it.each(["escape", "press"] as const)("after %s the same target stays closed until it is left", (reason) => {
    const dismissed = run([{ type: "dismiss", reason, at: 600 }], TIMING, opened());
    // Focus or a synthetic re-enter of the same target does not reopen it.
    const again = run([enter("a", 700), tick(2000)], TIMING, dismissed);
    expect(visibleTarget(again)).toBeNull();
    // Leaving releases it; a later hover opens it after the cold delay.
    const later = run([leave("a", 2100), enter("a", 2200), tick(2600)], TIMING, again);
    expect(visibleTarget(later)).toBe("a");
  });

  it("a scroll does not suppress the target under the pointer", () => {
    const dismissed = run([{ type: "dismiss", reason: "scroll", at: 600 }], TIMING, opened());
    expect(visibleTarget(run([enter("a", 700), tick(1100)], TIMING, dismissed))).toBe("a");
  });

  it("other targets open normally while one is suppressed", () => {
    const dismissed = run([{ type: "dismiss", reason: "escape", at: 600 }], TIMING, opened());
    expect(visibleTarget(run([enter("b", 700), tick(1100)], TIMING, dismissed))).toBe("b");
  });

  it("dismissing when nothing is shown or warm returns the same state", () => {
    const idle = initialTooltipState<T>();
    expect(stepTooltip(idle, { type: "dismiss", reason: "scroll", at: 5 }, TIMING)).toBe(idle);
  });
});

describe("malformed timing", () => {
  it("treats a negative delay as zero", () => {
    expect(visibleTarget(run([enter("a", 0)], { coldDelay: -10, warmDelay: -10, warmWindow: 0 }))).toBe("a");
  });
});
