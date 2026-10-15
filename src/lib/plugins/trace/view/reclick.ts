/**
 * A second click on the selected tile toggles its children, but only once no further click makes
 * it a double click (which opens the file): the toggle waits out the double-click window, as
 * Windows Explorer's slow click to rename does. A double click therefore never moves anything.
 * Pure: the view feeds it events and runs the timer.
 *
 * Any press within the window, a double click, or a change of pane, folder or selection cancels
 * the pending toggle. The caret never waits.
 */

/**
 * The double-click window, which a toggle waits out: the largest common platform default, so a
 * slow double click never toggles first on any of them. Windows' default is 500 ms, macOS's
 * (`NSEvent.doubleClickInterval`) is about the same, and GTK's `gtk-double-click-time`, which
 * WebKitGTK hosts use, is 400 ms. The webview does not expose the user's setting, and the host SDK
 * offers no capability for it yet.
 */
export const DOUBLE_CLICK_MS = 500;

/** A re-click waiting to toggle `key`, made at time `at` (ms). */
export interface PendingToggle {
  readonly key: string;
  readonly at: number;
}

export type ReclickEvent =
  /** A plain single click on the selected tile (the first click of a possible double click). */
  | { readonly kind: "reclick"; readonly key: string; readonly at: number }
  /** A pointer press anywhere in the view. */
  | { readonly kind: "press"; readonly at: number }
  | { readonly kind: "dblclick" }
  /** The pane, folder or selection changed. */
  | { readonly kind: "cancel" }
  /** The timer fired. */
  | { readonly kind: "tick"; readonly at: number };

export interface ReclickStep {
  readonly pending: PendingToggle | null;
  /** The key to toggle now, if any. */
  readonly toggle: string | null;
}

/** The next state for `event`. */
export function reclickStep(pending: PendingToggle | null, event: ReclickEvent, window = DOUBLE_CLICK_MS): ReclickStep {
  switch (event.kind) {
    case "reclick":
      // A pending re-click and this one are two clicks in a row: a double click in the making.
      if (pending && event.at - pending.at < window) return { pending: null, toggle: null };
      return { pending: { key: event.key, at: event.at }, toggle: null };
    case "press":
      return { pending: pending && event.at - pending.at < window ? null : pending, toggle: null };
    case "dblclick":
    case "cancel":
      return { pending: null, toggle: null };
    case "tick":
      if (!pending) return { pending: null, toggle: null };
      return event.at - pending.at >= window ? { pending: null, toggle: pending.key } : { pending, toggle: null };
  }
}
