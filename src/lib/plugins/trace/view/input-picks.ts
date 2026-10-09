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
 *
 * Who decides: every change of the host selection's files that the view did
 * not make (Select all, Escape, another pane) starts the picks over from the
 * host selection (`picksFromHost`); a re-sort or a listing refresh is not a
 * change (`selectionKey`). The view's own clicks replace the picks, settled
 * against the host selection they produced (`settlePicks`). Extras follow
 * their nodes (`followPicks`): a saved image carries its pick to the saved
 * file, a discarded or deleted one drops it.
 */
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";

export interface Pick {
  readonly path: string;
  readonly key: NodeKey;
  /** An extra's Trace component: kept loaded while picked, so the pick is checked against fresh data. */
  readonly componentId?: string;
}
export interface Picks {
  /** Paths in the order they were picked. */
  readonly order: readonly string[];
  /** Picked images that are not in the host selection (unlisted when picked). */
  readonly extras: readonly Pick[];
}

export const NO_PICKS: Picks = { order: [], extras: [] };

/** Whether a node's image can be an input: a present, current revision at a known path. */
export const pickable = (node: TraceNode): boolean =>
  !!node.path && node.state === "present" && !node.earlierRevision && !node.discarded;

/** The picks a host selection stands for: its files, in its order, and no extras. */
export function picksFromHost(host: readonly string[]): Picks {
  return host.length ? { order: [...host], extras: [] } : NO_PICKS;
}

/**
 * What the picks start over on: the folder and the host's selected files as a
 * set. A re-sort or a listing refresh keeps it, as the host itself only
 * notifies when the selection's contents change.
 */
export function selectionKey(directory: string, host: readonly string[]): string {
  return JSON.stringify([directory, [...new Set(host)].sort()]);
}

/**
 * The picks as the view records them after its own interaction: a new object
 * (an assignment of the same object would not register), with the order
 * holding only what is still selected: the host selection and the extras.
 * A Shift range, for one, replaces the host selection.
 */
export function settlePicks(picks: Picks, host: readonly string[]): Picks {
  const keep = new Set([...host, ...picks.extras.map((extra) => extra.path)]);
  return { order: [...new Set(picks.order.filter((path) => keep.has(path)))], extras: [...picks.extras] };
}

/**
 * A click on a listed file. `host` says whether the host should apply the
 * click to its selection. A Ctrl-click on a file picked only as an extra (an
 * unsaved image saved since, which the host does not hold) unpicks that extra:
 * passed on, the host would select it instead.
 */
export function clickListed(picks: Picks, path: string, host: readonly string[], modifiers: { ctrlKey?: boolean; shiftKey?: boolean }): { picks: Picks; host: boolean } {
  const extra = picks.extras.find((candidate) => candidate.path === path);
  if (modifiers.ctrlKey && extra && !host.includes(path)) return { picks: togglePick(picks, extra, false, false), host: false };
  const pick = { path, key: path };
  if (!modifiers.ctrlKey && !modifiers.shiftKey) return { picks: pickOnly(pick, true), host: true };
  return { picks: togglePick(picks, pick, true, resolvePicks(picks, host).includes(path), !modifiers.ctrlKey), host: true };
}

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
    // An extra that has since become this listed file (a saved image) goes with it.
    if (selected && !range) return { order: without(picks.order), extras: picks.extras.filter((extra) => extra.path !== pick.path) };
    return picks.order.includes(pick.path) ? picks : { ...picks, order: [...picks.order, pick.path] };
  }
  if (picks.extras.some((extra) => extra.path === pick.path)) {
    return { order: without(picks.order), extras: picks.extras.filter((extra) => extra.path !== pick.path) };
  }
  return { order: [...without(picks.order), pick.path], extras: [...picks.extras, pick] };
}

/** Removes the extra a node key names, for example once its image is discarded. */
export function dropPick(picks: Picks, key: NodeKey): Picks {
  const gone = new Set(picks.extras.filter((extra) => extra.key === key).map((extra) => extra.path));
  if (!gone.size) return picks;
  return { order: picks.order.filter((path) => !gone.has(path)), extras: picks.extras.filter((extra) => extra.key !== key) };
}

/**
 * Replaces the extra `key` names with `next`, in its place in the order: a
 * saved image becomes its saved file. A `listed` replacement belongs to the
 * host selection, so it is no longer an extra. Null when `key` is not picked.
 */
export function replacePick(picks: Picks, key: NodeKey, next: Pick, listed: boolean): Picks | null {
  const old = picks.extras.find((extra) => extra.key === key);
  if (!old) return null;
  const order = [...new Set(picks.order.map((path) => path === old.path ? next.path : path))];
  const extras = picks.extras.flatMap((extra) => extra.key === key ? (listed ? [] : [next]) : extra.path === next.path ? [] : [extra]);
  return { order, extras };
}

/** Where an extra's node is now: found in current data, gone, or not known yet ("unknown"). */
export type PickLocation = { readonly node: TraceNode; readonly componentId: string } | null | "unknown";

/**
 * The picks with each extra checked against its node now. `locate` finds the
 * node in current data, says it is gone (null), or that it cannot tell yet
 * ("unknown": its component is not loaded or out of date): such a pick is kept
 * as it is. A node that is gone, discarded, missing or an earlier revision
 * drops its pick; a node whose image moved (an unsaved image that was saved)
 * carries its pick to the new path, and one whose component changed (merged
 * with another) carries its pick to that component.
 */
export function followPicks(picks: Picks, locate: (key: NodeKey) => PickLocation): Picks {
  const moved = new Map<string, string | null>();
  let changed = false;
  const extras: Pick[] = [];
  for (const extra of picks.extras) {
    const found = locate(extra.key);
    if (found === "unknown") { extras.push(extra); continue; }
    if (!found || !pickable(found.node)) { moved.set(extra.path, null); changed = true; continue; }
    const path = found.node.path!;
    if (path !== extra.path) moved.set(extra.path, path);
    if (path !== extra.path || found.componentId !== extra.componentId) { extras.push({ ...extra, path, componentId: found.componentId }); changed = true; }
    else extras.push(extra);
  }
  if (!changed) return picks;
  const order = picks.order.flatMap((path) => {
    if (!moved.has(path)) return [path];
    const to = moved.get(path);
    return to ? [to] : [];
  });
  return { order: [...new Set(order)], extras: extras.filter((extra, index) => extras.findIndex((other) => other.path === extra.path) === index) };
}

/** The selected images in pick order: picked paths still selected, then host selections not picked here. */
export function resolvePicks(picks: Picks, hostSelected: readonly string[]): string[] {
  const host = new Set(hostSelected);
  const extras = new Set(picks.extras.map((extra) => extra.path));
  const ordered = [...new Set(picks.order.filter((path) => host.has(path) || extras.has(path)))];
  const seen = new Set(ordered);
  return [...ordered, ...hostSelected.filter((path) => !seen.has(path))];
}
