/**
 * Explicit expansion inside open stacks (docs/trace-view-layout.md, "Interaction model"). Pure:
 * no Svelte, IO or timers.
 *
 * A pane remembers which nodes the user expanded, by node key (revision keys are stable across
 * component merges, so one pane-wide map serves every stack). What a band shows follows from it
 * (`bandVisibleKeys`): a node's children are visible exactly when the node is expanded and
 * visible itself. The only geometry a click can change is the clicked node's own children:
 *
 * - a first click on an unselected tile selects it and opens its children (`expandNode`), adding
 *   only them; selecting a leaf or a node already expanded changes styling only (a leaf records
 *   the intent, so children it gets later, such as an AI edit's output, show);
 * - the caret and a second click on the selected tile toggle one node (`toggleNode`);
 * - collapsing an ancestor of the selected node hides it; the selection stays (host file-tree
 *   behaviour) and nothing else changes;
 * - a selection made outside the view (or Show image) reveals its node (`revealNode`): its
 *   ancestors count as expanded (`revealPath`) until a later choice settles them into explicit
 *   choices (`settleReveal`);
 * - starting a job from the view shows its outputs (`expandForOutputs`): each input is revealed
 *   and expanded, so the job's placeholder and output appear under it.
 *
 * Defaults: in-folder roots are expanded unless the user collapsed them; every other node is
 * collapsed until expanded. A stack's cover is expanded while its stack is open: its expansion is
 * the stack's open state, which the open-stack set owns.
 */
import type { NodeKey } from "./model";
import type { BadgeProjection } from "./projection";
import { bandVisibleKeys, componentRoots } from "./visibility";

export interface Expansion {
  /**
   * The user's explicit choices by node key (or reference badge key): true expanded, false
   * collapsed. Absent keys take the default. Insertion order is recency (latest last).
   */
  readonly choices: ReadonlyMap<NodeKey, boolean>;
  /**
   * Nodes selections asked to show, oldest first (at most `MAX_REVEALS`). Each one's ancestors
   * count as expanded (whatever the choices say) until `settleReveal` turns them into choices in
   * its stack. One whose stack is not loaded stays pending until it is.
   */
  readonly reveals: readonly NodeKey[];
}

export const NO_EXPANSION: Expansion = { choices: new Map(), reveals: [] };

/** Pending reveals kept: the most recent. */
export const MAX_REVEALS = 16;

/** One open stack, as expansion resolves against it. */
export interface ExpansionScope {
  readonly graph: BadgeProjection;
  /** Drawable keys of the component. */
  readonly members: readonly NodeKey[];
  /** The stack's cover: expanded while the stack is open. */
  readonly cover: NodeKey;
}

/** `choices` with `key` set to `value`, moved to the most recent place. */
function choose(choices: ReadonlyMap<NodeKey, boolean>, key: NodeKey, value: boolean): ReadonlyMap<NodeKey, boolean> {
  const next = new Map(choices);
  next.delete(key);
  next.set(key, value);
  return next;
}

const isKey = (value: unknown): value is NodeKey => typeof value === "string" && value.length > 0;

/** Whether `key` belongs to the scope: a member or one of its reference badges. */
const inScope = (scope: ExpansionScope, key: NodeKey): boolean => scope.members.includes(key) || scope.graph.badges.has(key);

/** The children `key` has in the scope: a node's, or a reference badge's consumers. */
const childCount = (scope: ExpansionScope, key: NodeKey): number => {
  const badge = scope.graph.badges.get(key);
  return badge ? badge.consumers.length : scope.graph.dag.children.get(key)?.length ?? 0;
};

/** What the choices alone expand in the scope: chosen keys, unchosen in-folder roots, and the cover. */
function chosenKeys(expansion: Expansion, scope: ExpansionScope): Set<NodeKey> {
  const { graph, members } = scope;
  const roots = new Set(componentRoots(graph.dag, members, "in-folder"));
  const expanded = new Set<NodeKey>();
  for (const key of members) if (expansion.choices.get(key) ?? roots.has(key)) expanded.add(key);
  for (const key of graph.badges.keys()) if (expansion.choices.get(key) === true) expanded.add(key);
  if (members.includes(scope.cover)) expanded.add(scope.cover);
  return expanded;
}

/**
 * The nodes to expand, beyond `expanded`, so that `target` is visible: one chain of parents from
 * it up to a visible node, preferring visible, then in-folder, then older parents. A reference
 * input without parents shows once one of its outputs does (each output keeps its inputs); a
 * reference badge, once one of its consumers does. Empty when `target` is visible already or is
 * not in the scope.
 */
export function revealPath(scope: ExpansionScope, expanded: ReadonlySet<NodeKey>, target: NodeKey): NodeKey[] {
  const { graph, members } = scope, { dag } = graph;
  const inComponent = new Set(members);
  const visible = new Set(bandVisibleKeys(graph, members, expanded));
  let at = target;
  const badge = graph.badges.get(target);
  if (badge) {
    const consumers = badge.consumers.filter((key) => inComponent.has(key));
    if (!consumers.length || consumers.some((key) => visible.has(key))) return [];
    at = consumers[0];
  }
  if (!inComponent.has(at)) return [];
  const local = (key: NodeKey) => dag.nodes.get(key)?.scope === "current";
  const path: NodeKey[] = [], seen = new Set<NodeKey>();
  while (!visible.has(at) && !seen.has(at)) {
    seen.add(at);
    const parents = (dag.parents.get(at) ?? []).filter((key) => inComponent.has(key));
    const parent = parents.find((key) => visible.has(key)) ?? parents.find(local) ?? parents[0];
    if (parent !== undefined) { path.push(parent); at = parent; continue; }
    // A parentless reference input: reveal an output of it instead.
    const children = (dag.children.get(at) ?? []).filter((key) => inComponent.has(key) && !seen.has(key));
    const child = children.find(local) ?? children[0];
    if (child === undefined) break;
    at = child;
  }
  return path;
}

/**
 * The scope's expanded keys: the choices, the defaults, the cover, and the path a pending reveal
 * needs. What the layout input carries for an open stack (`OpenStack.expanded`).
 */
export function expandedKeys(expansion: Expansion, scope: ExpansionScope): ReadonlySet<NodeKey> {
  const expanded = chosenKeys(expansion, scope);
  for (const target of expansion.reveals) if (inScope(scope, target)) for (const key of revealPath(scope, expanded, target)) expanded.add(key);
  return expanded;
}

/** Whether `key` is expanded in the scope (the cover always is). */
export const isExpanded = (expansion: Expansion, scope: ExpansionScope, key: NodeKey): boolean => expandedKeys(expansion, scope).has(key);

/**
 * Turns the pending reveals in this scope into explicit choices (their paths expanded), so a later
 * toggle starts from what is shown. Reveals in other scopes are left pending.
 */
export function settleReveal(expansion: Expansion, scope: ExpansionScope): Expansion {
  const here = expansion.reveals.filter((key) => inScope(scope, key));
  if (!here.length) return expansion;
  const choices = new Map(expansion.choices), expanded = chosenKeys(expansion, scope);
  for (const target of here) {
    // Outermost first, so the chain reads from the stack down in recency order.
    for (const key of revealPath(scope, expanded, target).reverse()) { choices.delete(key); choices.set(key, true); expanded.add(key); }
  }
  return { choices, reveals: expansion.reveals.filter((key) => !inScope(scope, key)) };
}

/**
 * Shows `key` (a selection made outside the view, Show image, Preview's input links): its
 * ancestors count as expanded until settled. Expands nothing else and collapses nothing; earlier
 * reveals stay pending (the oldest beyond `MAX_REVEALS` are forgotten). Selecting a tile in the
 * view never calls this.
 */
export function revealNode(expansion: Expansion, key: NodeKey): Expansion {
  if (!isKey(key) || expansion.reveals.at(-1) === key) return expansion;
  return { choices: expansion.choices, reveals: [...expansion.reveals.filter((other) => other !== key), key].slice(-MAX_REVEALS) };
}

/**
 * The node the layout holds still in this scope: the one the user expanded or collapsed last
 * (the most recent choice in the scope of a node with children: a leaf's recorded intent shows
 * nothing, so it moves nothing), else the latest pending reveal in it; null for none.
 */
export function expansionAnchor(expansion: Expansion, scope: ExpansionScope): NodeKey | null {
  const keys = [...expansion.choices.keys()];
  for (let index = keys.length - 1; index >= 0; index--) if (inScope(scope, keys[index]) && childCount(scope, keys[index]) > 0) return keys[index];
  for (let index = expansion.reveals.length - 1; index >= 0; index--) if (inScope(scope, expansion.reveals[index])) return expansion.reveals[index];
  return null;
}

/**
 * A first click on an unselected tile: opens its children if they are not open already. It only
 * ever adds that node's children: nothing else is expanded or collapsed, and a node already
 * expanded returns `expansion` itself. A leaf records the intent (it shows nothing and moves
 * nothing: see `expansionAnchor`), so children it gets later show.
 */
export function expandNode(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !inScope(scope, key) || isExpanded(expansion, scope, key)) return expansion;
  if (!childCount(scope, key)) return { ...expansion, choices: choose(expansion.choices, key, true) };
  const settled = settleReveal(expansion, scope);
  return { ...settled, choices: choose(settled.choices, key, true) };
}

/**
 * A job started from the view on `key` (one of its inputs): `key` is revealed, as a selection
 * from outside the view would be, and expanded, so the job's placeholder and output show under
 * it even when it sat in a collapsed branch. `expansion` itself when it is shown and expanded already.
 */
export function expandForOutputs(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !inScope(scope, key)) return expansion;
  const expanded = expandedKeys(expansion, scope);
  if (expanded.has(key) && revealPath(scope, expanded, key).length === 0) return expansion;
  const settled = settleReveal(revealNode(expansion, key), scope);
  return isExpanded(settled, scope, key) ? settled : { ...settled, choices: choose(settled.choices, key, true) };
}

/**
 * The caret, or a second click on the selected tile: flips `key` from what is shown. A pending
 * reveal in the scope settles first, so collapsing an ancestor of a revealed selection hides it.
 * The cover's expansion is its stack's open state: callers close the stack instead.
 */
export function toggleNode(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !inScope(scope, key)) return expansion;
  const settled = settleReveal(expansion, scope);
  return { ...settled, choices: choose(settled.choices, key, !isExpanded(settled, scope, key)) };
}

/** Whether a chosen key's node still exists: in loaded data, gone from it, or not known (its stack is not loaded). */
export type ChoiceStatus = "present" | "gone" | "unknown";

/** Choices of nodes that are not loaded are kept, but only this many (the most recent). */
export const MAX_UNKNOWN_CHOICES = 256;

/**
 * Drops choices (and a pending reveal) of nodes that are gone, and all but the most recent
 * `limit` choices of nodes not known. Returns `expansion` itself when nothing changes.
 */
export function pruneExpansion(expansion: Expansion, status: (key: NodeKey) => ChoiceStatus, limit = MAX_UNKNOWN_CHOICES): Expansion {
  const entries = [...expansion.choices].filter(([key, value]) => isKey(key) && typeof value === "boolean");
  const states = entries.map(([key]) => status(key));
  let unknown = states.filter((state) => state === "unknown").length;
  const kept = entries.filter((_, index) => {
    if (states[index] === "gone") return false;
    if (states[index] === "unknown" && unknown > Math.max(0, limit)) { unknown--; return false; }
    return true;
  });
  const reveals = expansion.reveals.filter((key) => isKey(key) && status(key) !== "gone");
  if (kept.length === expansion.choices.size && reveals.length === expansion.reveals.length) return expansion;
  return { choices: new Map(kept), reveals };
}

/** Same choices (in any order) and the same pending reveals. */
export function sameExpansion(a: Expansion, b: Expansion): boolean {
  if (a === b) return true;
  if (a.reveals.length !== b.reveals.length || a.reveals.some((key, index) => b.reveals[index] !== key) || a.choices.size !== b.choices.size) return false;
  for (const [key, value] of a.choices) if (b.choices.get(key) !== value) return false;
  return true;
}

/**
 * Reads a remembered expansion (a pane snapshot), keeping only well-formed choices. Anything
 * else is no expansion.
 */
export function readExpansion(value: unknown): Expansion {
  if (typeof value !== "object" || value === null) return NO_EXPANSION;
  const { choices, reveals, reveal } = value as { choices?: unknown; reveals?: unknown; reveal?: unknown };
  const entries = choices instanceof Map ? [...choices].filter(([key, open]) => isKey(key) && typeof open === "boolean") as [NodeKey, boolean][] : [];
  // An older snapshot kept one pending reveal.
  const pending = Array.isArray(reveals) ? reveals.filter(isKey) : isKey(reveal) ? [reveal] : [];
  return { choices: new Map(entries), reveals: [...new Set(pending)].slice(-MAX_REVEALS) };
}
