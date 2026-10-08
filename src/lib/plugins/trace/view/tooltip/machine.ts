/**
 * When a tooltip shows: a pure state machine driven by injected time.
 *
 * - Cold: hovering (or keyboard-focusing) a target opens its tooltip after
 *   `coldDelay`. Leaving before then cancels it, so sweeping the pointer
 *   across tiles never flashes tooltips.
 * - Warm: once a tooltip has shown, entering another target within
 *   `warmWindow` of the last one closing opens the next after `warmDelay`
 *   (normally immediately), the usual "skip delay" behaviour.
 * - Dismissal (press, Escape, scroll, window blur, resize) closes it and
 *   cools down. Press and Escape also suppress the target they closed until
 *   it is left, so the tooltip does not reappear under a resting pointer.
 *
 * Targets are compared by identity. The machine never reads a clock: the
 * caller passes `at` with every event and schedules a `tick` at `deadline`.
 */

export interface TooltipTiming {
  /** Delay before the first tooltip opens, in ms. */
  readonly coldDelay: number;
  /** Delay before a tooltip opens while warm, in ms. */
  readonly warmDelay: number;
  /** How long after a tooltip closes the next one still opens warm, in ms. */
  readonly warmWindow: number;
}

/**
 * Cold 400 ms is the Windows/WinUI hover time (ToolTipService's initial show
 * delay), the platform the host's Fluent tokens follow; it is shorter than
 * GTK's native tooltip timeout that WebKitGTK `title` tooltips use. Warm
 * hand-offs open at once, as WinUI's BetweenShowDelay and Radix's
 * skipDelayDuration do.
 */
export const TOOLTIP_TIMING: TooltipTiming = { coldDelay: 400, warmDelay: 0, warmWindow: 500 };

export type DismissReason = "press" | "escape" | "scroll" | "blur" | "resize";

export type TooltipEvent<T> =
  | { readonly type: "enter"; readonly target: T; readonly at: number }
  | { readonly type: "leave"; readonly target: T; readonly at: number }
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "dismiss"; readonly reason: DismissReason; readonly at: number };

export interface TooltipState<T> {
  readonly phase: "idle" | "pending" | "open";
  /** The target pending or open; null when idle. */
  readonly target: T | null;
  /** When a pending tooltip opens. */
  readonly dueAt: number;
  /** Until when an entered target opens warm (when idle). */
  readonly warmUntil: number;
  /** A target closed by press or Escape; ignored until it is left. */
  readonly suppressed: T | null;
  /** The open tooltip was handed off warm, so it appears without an entrance animation. */
  readonly instant: boolean;
}

export const initialTooltipState = <T>(): TooltipState<T> =>
  ({ phase: "idle", target: null, dueAt: 0, warmUntil: -Infinity, suppressed: null, instant: false });

/** The target whose tooltip is showing. */
export const visibleTarget = <T>(state: TooltipState<T>): T | null => state.phase === "open" ? state.target : null;

/** When the caller must send a `tick`, or null when no timer is needed. */
export const deadline = <T>(state: TooltipState<T>): number | null => state.phase === "pending" ? state.dueAt : null;

/** Closes whatever is pending or open; a tooltip that was open warms the next one. */
function close<T>(state: TooltipState<T>, at: number, timing: TooltipTiming): TooltipState<T> {
  if (state.phase === "idle") return state;
  return { ...state, phase: "idle", target: null, instant: false, warmUntil: state.phase === "open" ? at + timing.warmWindow : state.warmUntil };
}

export function stepTooltip<T>(state: TooltipState<T>, event: TooltipEvent<T>, timing: TooltipTiming = TOOLTIP_TIMING): TooltipState<T> {
  switch (event.type) {
    case "enter": {
      if (event.target === state.suppressed) return close(state, event.at, timing);
      if (state.phase !== "idle" && state.target === event.target) return state;
      const warm = state.phase === "open" || event.at < state.warmUntil;
      const delay = Math.max(0, warm ? timing.warmDelay : timing.coldDelay);
      const next: TooltipState<T> = { ...state, phase: "pending", target: event.target, dueAt: event.at + delay, instant: warm };
      return delay === 0 ? { ...next, phase: "open" } : next;
    }
    case "leave": {
      const released = state.suppressed === event.target ? { ...state, suppressed: null } : state;
      return released.target === event.target ? close(released, event.at, timing) : released;
    }
    case "tick":
      return state.phase === "pending" && event.at >= state.dueAt ? { ...state, phase: "open" } : state;
    case "dismiss": {
      const suppress = event.reason === "press" || event.reason === "escape";
      if (state.phase === "idle" && state.warmUntil === -Infinity) return state;
      return {
        ...state, phase: "idle", target: null, instant: false, warmUntil: -Infinity,
        suppressed: suppress && state.target !== null ? state.target : state.suppressed,
      };
    }
  }
}
