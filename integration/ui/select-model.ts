/**
 * Pure rules for the select-only combobox (WAI-ARIA APG): which option is
 * active after a key, how typeahead matches, and where the popup sits.
 * No DOM, no Svelte; `Select.svelte` only translates events into these calls.
 */
export interface SelectOption { value: string; label: string; disabled?: boolean }

export const NONE = -1;
const PAGE = 10;

const enabled = (options: readonly SelectOption[], index: number): boolean => index >= 0 && index < options.length && !options[index].disabled;
export const indexOfValue = (options: readonly SelectOption[], value: string | undefined): number => options.findIndex((option) => option.value === value);
export const firstEnabled = (options: readonly SelectOption[]): number => options.findIndex((_, i) => enabled(options, i));
export const lastEnabled = (options: readonly SelectOption[]): number => {
  for (let i = options.length - 1; i >= 0; i--) if (enabled(options, i)) return i;
  return NONE;
};

/** The option highlighted when the list opens: the selected one, else the first enabled. */
export function initialActive(options: readonly SelectOption[], value: string | undefined): number {
  const selected = indexOfValue(options, value);
  return enabled(options, selected) ? selected : firstEnabled(options);
}

export type Move = "next" | "prev" | "first" | "last" | "pageUp" | "pageDown";

/** Next active index. Disabled options are skipped; the ends clamp rather than wrap. Returns `from` when nothing is reachable. */
export function move(options: readonly SelectOption[], from: number, how: Move): number {
  if (how === "first") return firstEnabled(options);
  if (how === "last") return lastEnabled(options);
  const step = how === "next" || how === "pageDown" ? 1 : -1;
  const distance = how === "next" || how === "prev" ? 1 : PAGE;
  let target = from;
  let travelled = 0;
  for (let i = from + step; i >= 0 && i < options.length && travelled < distance; i += step) {
    if (enabled(options, i)) { target = i; travelled++; }
  }
  if (travelled > 0) return target;
  return from === NONE ? (step > 0 ? firstEnabled(options) : lastEnabled(options)) : from;
}

export interface Typeahead { text: string; at: number }
export const TYPEAHEAD_MS = 500;
export const emptyTypeahead: Typeahead = { text: "", at: 0 };

/** Appends a printable character, starting a fresh buffer once the pause exceeds the timeout. */
export function typeahead(previous: Typeahead, char: string, now: number): Typeahead {
  const fresh = now - previous.at > TYPEAHEAD_MS;
  return { text: (fresh ? "" : previous.text) + char.toLowerCase(), at: now };
}

/**
 * The option a typeahead buffer selects, searching from the active one with wraparound.
 * A buffer of one repeated letter ("aaa") cycles through options starting with it.
 */
export function typeaheadMatch(options: readonly SelectOption[], active: number, text: string): number {
  if (!text) return NONE;
  const cycling = [...text].every((c) => c === text[0]);
  const needle = cycling ? text[0] : text;
  const start = cycling ? active + 1 : Math.max(active, 0);
  for (let offset = 0; offset < options.length; offset++) {
    const i = (((start + offset) % options.length) + options.length) % options.length;
    if (enabled(options, i) && options[i].label.toLowerCase().startsWith(needle)) return i;
  }
  return NONE;
}

export interface KeyInput { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }
export type KeyAction =
  | { type: "open"; at: "selected" | "first" | "last" }
  | { type: "move"; how: Move }
  | { type: "select"; close: true }
  | { type: "selectActive" }
  | { type: "close" }
  | { type: "tab" }
  | { type: "type"; char: string };

/** Maps a key to an action per the APG select-only combobox. `null` means the key is not ours. */
export function keyAction(open: boolean, input: KeyInput): KeyAction | null {
  const { key } = input;
  if (input.ctrlKey || input.metaKey) return null;
  if (!open) {
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") return { type: "open", at: "selected" };
    if (key === "Home") return { type: "open", at: "first" };
    if (key === "End") return { type: "open", at: "last" };
  } else {
    if (key === "ArrowUp" && input.altKey) return { type: "select", close: true };
    switch (key) {
      case "ArrowDown": return { type: "move", how: "next" };
      case "ArrowUp": return { type: "move", how: "prev" };
      case "Home": return { type: "move", how: "first" };
      case "End": return { type: "move", how: "last" };
      case "PageUp": return { type: "move", how: "pageUp" };
      case "PageDown": return { type: "move", how: "pageDown" };
      case "Enter": case " ": return { type: "selectActive" };
      case "Escape": return { type: "close" };
      case "Tab": return { type: "tab" };
    }
  }
  if (key.length === 1 && key !== " " && !input.altKey) return { type: "type", char: key };
  return null;
}

export interface Rect { top: number; bottom: number; left: number; width: number }
export interface Placement { top: number; left: number; minWidth: number; maxHeight: number; side: "below" | "above" }

/**
 * Places the popup under the trigger, or above it when the room below is too small
 * and above is larger. `maxHeight` is the space on the chosen side.
 */
export function place(trigger: Rect, viewport: { width: number; height: number }, contentHeight: number, gap = 4, margin = 8): Placement {
  const below = Math.max(0, viewport.height - trigger.bottom - gap - margin);
  const above = Math.max(0, trigger.top - gap - margin);
  const side = contentHeight > below && above > below ? "above" : "below";
  const maxHeight = Math.floor(side === "below" ? below : above);
  const height = Math.min(contentHeight, maxHeight);
  const top = side === "below" ? trigger.bottom + gap : trigger.top - gap - height;
  const left = Math.max(margin, Math.min(trigger.left, viewport.width - margin - trigger.width));
  return { top, left, minWidth: trigger.width, maxHeight, side };
}
