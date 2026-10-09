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
 * Who decides: every change of the host selection that the view did not make
 * (Select all, Escape, another pane) starts the picks over from the host
 * selection (`picksFromHost`); the view's own clicks replace them. Extras
 * follow their nodes (`followPicks`): a saved image carries its pick to the
 * saved file, a discarded or deleted one drops it.
 */
import type { NodeKey, TraceNode } from "$lib/domain/trace-graph/model";

export interface Pick { readonly path: string; readonly key: NodeKey }
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

/**
 * The picks with each extra checked against its node now. `nodeOf` returns
 * the node, null when it is gone, or undefined when that cannot be known yet
 * (its component is not loaded): such a pick is kept. A node that is gone,
 * discarded, missing or an earlier revision drops its pick; a node whose image
 * moved (an unsaved image that was saved) carries its pick to the new path.
 */
export function followPicks(picks: Picks, nodeOf: (key: NodeKey) => TraceNode | null | undefined): Picks {
  const moved = new Map<string, string | null>();
  const extras: Pick[] = [];
  for (const extra of picks.extras) {
    const node = nodeOf(extra.key);
    if (node === undefined) extras.push(extra);
    else if (!node || !pickable(node)) moved.set(extra.path, null);
    else if (node.path !== extra.path) { moved.set(extra.path, node.path!); extras.push({ ...extra, path: node.path! }); }
    else extras.push(extra);
  }
  if (!moved.size) return picks;
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

/** What the view last saw of the host selection; see `followHost`. */
export interface HostSelection {
  readonly directory: string;
  /** The listing the selection was read from (compared by identity). */
  readonly entries: unknown;
  readonly paths: readonly string[];
}

/**
 * The host selection as the picks follow it. Every recomputation of the
 * host's selection is a change — even to the same files (Select all over an
 * all-selected folder) — except a listing refresh: new entries, same folder,
 * same files in the same order. That keeps the previous `paths` array, so the
 * picks made against it survive a folder's files changing on disk.
 */
export function followHost(previous: HostSelection | null, next: HostSelection): HostSelection {
  const refresh = previous !== null && previous.directory === next.directory && previous.entries !== next.entries
    && previous.paths.length === next.paths.length && previous.paths.every((path, index) => path === next.paths[index]);
  return refresh ? { ...next, paths: previous.paths } : next;
}
