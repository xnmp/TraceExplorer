/**
 * The Trace view's ordered image selection ("picks"), which AI edits use as
 * their numbered inputs.
 *
 * The host's file selection holds only the folder's listed files, in listing
 * order. A Trace graph also shows images that are not listed: unsaved
 * generations, and inputs in subfolders or elsewhere. Picks add those
 * ("extras") and remember the order in which images were picked, so Image 1…N
 * follow the user's clicks. The listed part stays the host's selection: the
 * resolved picks are the host selection in pick order, plus the extras.
 */
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";

export interface Pick { readonly path: string; readonly key: NodeKey }
export interface Picks {
  /** Paths in the order they were picked. */
  readonly order: readonly string[];
  /** Picked images that are not listed files (never in the host selection). */
  readonly extras: readonly Pick[];
}

export const NO_PICKS: Picks = { order: [], extras: [] };

/** Whether a node's image can be an input: a present, current revision at a known path. */
export const pickable = (node: TraceNode): boolean =>
  !!node.path && node.state === "present" && !node.earlierRevision && !node.discarded;

/** A plain click: the selection becomes this one image. */
export function pickOnly(pick: Pick, listed: boolean): Picks {
  return { order: [pick.path], extras: listed ? [] : [pick] };
}

/**
 * A Ctrl or Shift click. A listed image toggles (the host toggles its own
 * selection alongside; a Shift range only adds); an extra always toggles.
 */
export function togglePick(picks: Picks, pick: Pick, listed: boolean, selected: boolean, range = false): Picks {
  const without = (paths: readonly string[]) => paths.filter((path) => path !== pick.path);
  if (listed) {
    if (selected && !range) return { ...picks, order: without(picks.order) };
    return picks.order.includes(pick.path) ? picks : { ...picks, order: [...picks.order, pick.path] };
  }
  if (picks.extras.some((extra) => extra.path === pick.path)) {
    return { order: without(picks.order), extras: picks.extras.filter((extra) => extra.path !== pick.path) };
  }
  return { order: [...without(picks.order), pick.path], extras: [...picks.extras, pick] };
}

/** The selected images in pick order: picked paths still selected, then host selections not picked here. */
export function resolvePicks(picks: Picks, hostSelected: readonly string[]): string[] {
  const host = new Set(hostSelected);
  const extras = new Set(picks.extras.map((extra) => extra.path));
  const ordered = picks.order.filter((path) => host.has(path) || extras.has(path));
  const seen = new Set(ordered);
  return [...ordered, ...hostSelected.filter((path) => !seen.has(path))];
}
