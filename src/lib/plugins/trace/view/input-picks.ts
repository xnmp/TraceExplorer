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
 * Picks are never trusted as stored: `reconcilePicks` checks them against the
 * live state first. An extra whose image was saved, discarded, deleted or has
 * become a listed file no longer counts, and a host selection the view did not
 * make (Select all, Escape, a save selecting its file) replaces the extras.
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

/** Removes the image a node key names, for example once its image is discarded. */
export function dropPick(picks: Picks, key: NodeKey): Picks {
  const gone = new Set(picks.extras.filter((extra) => extra.key === key).map((extra) => extra.path));
  if (!gone.size) return picks;
  return { order: picks.order.filter((path) => !gone.has(path)), extras: picks.extras.filter((extra) => extra.key !== key) };
}

/**
 * Whether an extra still names an image that can be an input: its node is
 * pickable at the picked path, and the host does not list that path (a listed
 * image belongs to the host selection). `node` is `undefined` when it cannot be
 * known yet (its component is not loaded): the extra is kept; `null` means the
 * node is gone.
 */
export function extraIsLive(pick: Pick, node: TraceNode | null | undefined, listed: boolean): boolean {
  if (listed) return false;
  if (node === undefined) return true;
  return node !== null && pickable(node) && node.path === pick.path;
}

const sameSelection = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((path) => set.has(path));
};

/**
 * The picks as they stand now. `basis` is the host selection the picks were
 * last made against: when the host selection differs, something else changed
 * it, so its selection wins (extras are dropped; still-selected images keep
 * their pick order, newly selected ones follow). Otherwise extras that are no
 * longer `live` are dropped.
 */
export function reconcilePicks(picks: Picks, basis: readonly string[], host: readonly string[], live: (pick: Pick) => boolean): Picks {
  const selected = new Set(host);
  if (!sameSelection(basis, host)) {
    const kept = picks.order.filter((path) => selected.has(path));
    const seen = new Set(kept);
    return { order: [...kept, ...host.filter((path) => !seen.has(path))], extras: [] };
  }
  const extras = picks.extras.filter((extra) => !selected.has(extra.path) && live(extra));
  if (extras.length === picks.extras.length) return picks;
  const keep = new Set([...host, ...extras.map((extra) => extra.path)]);
  return { order: picks.order.filter((path) => keep.has(path)), extras };
}

/** The selected images in pick order: picked paths still selected, then host selections not picked here. */
export function resolvePicks(picks: Picks, hostSelected: readonly string[]): string[] {
  const host = new Set(hostSelected);
  const extras = new Set(picks.extras.map((extra) => extra.path));
  const ordered = picks.order.filter((path) => host.has(path) || extras.has(path));
  const seen = new Set(ordered);
  return [...ordered, ...hostSelected.filter((path) => !seen.has(path))];
}
