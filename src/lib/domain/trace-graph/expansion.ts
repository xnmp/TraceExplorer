/**
 * Explicit expansion inside open stacks (docs/trace-view-layout.md, "Interaction model"). Pure:
 * no Svelte, IO or timers.
 *
 * A pane remembers the user's expand and collapse choices, by node key and in order (revision keys
 * are stable across component merges, so one pane-wide record serves every stack). What a band
 * shows follows from it (`bandVisibleKeys`): each node follows the latest choice among its parents,
 * so for an edit of two inputs the latest action wins. The only geometry a click can change is
 * the clicked node's own children:
 *
 * - a first click on an unselected tile selects it and opens its children (`expandNode`): it only
 *   ever shows things. Selecting a leaf or a node whose children are all shown changes styling
 *   only (a leaf records the intent, so children it gets later, such as an AI edit's output, show);
 * - the caret and a second click on the selected tile toggle one node from what is shown
 *   (`toggleNode`): a node whose children are all shown collapses, hiding every child nothing
 *   else holds; any other expands, showing them all;
 * - collapsing an ancestor of the selected node hides it; the selection stays (host file-tree
 *   behaviour) and nothing else changes;
 * - a selection made outside the view (or Show image) reveals its node (`revealNode`): its
 *   ancestors count as expanded (`revealPath`) until a later choice settles them into explicit
 *   choices (`settleReveal`);
 * - starting a job from the view shows its outputs (`expandForOutputs`): each input node is
 *   revealed and expanded, so the job's placeholder and output appear under it. Reference badges
 *   are never expanded for it: an output of badges alone is a root, shown anyway.
 *
 * Defaults: in-folder roots are expanded unless the user collapsed them, and older than any
 * choice; every other node is collapsed until expanded. A stack's cover is expanded while its
 * stack is open, newer than any choice: its expansion is the stack's open state, which the
 * open-stack set owns.
 */
import type { NodeKey } from "./model";
import type { BadgeProjection } from "./projection";
import { bandVisibleKeys, componentRoots, type BandExpansion } from "./visibility";

export interface Expansion {
  /**
   * The user's explicit choices by node key (or reference badge key): true expanded, false
   * collapsed. Absent keys take the default. Insertion order is recency (latest last); at most
   * `MAX_CHOICES`, the oldest forgotten first.
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

/**
 * Choices kept: the most recent. A forgotten choice falls back to its default, so a reveal path
 * deeper than this settles only its innermost part.
 */
export const MAX_CHOICES = 4096;

/** One open stack, as expansion resolves against it. */
export interface ExpansionScope {
  readonly graph: BadgeProjection;
  /** Drawable keys of the component. */
  readonly members: readonly NodeKey[];
  /** The stack's cover: expanded while the stack is open. */
  readonly cover: NodeKey;
}

/** `choices` with each of `keys` set to `value`, in order, as the most recent; the oldest beyond `MAX_CHOICES` are forgotten. */
function choose(choices: ReadonlyMap<NodeKey, boolean>, keys: NodeKey | readonly NodeKey[], value: boolean): ReadonlyMap<NodeKey, boolean> {
  const next = new Map(choices);
  for (const key of typeof keys === "string" ? [keys] : keys) { next.delete(key); next.set(key, value); }
  for (const oldest of next.keys()) { if (next.size <= MAX_CHOICES) break; next.delete(oldest); }
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

/**
 * What the choices alone decide in the scope, oldest first: unchosen in-folder roots (expanded),
 * the scope's choices in order, then the cover (expanded).
 */
function chosenKeys(expansion: Expansion, scope: ExpansionScope): Map<NodeKey, boolean> {
  const { graph, members } = scope;
  const decided = new Map<NodeKey, boolean>();
  for (const root of componentRoots(graph.dag, members, "in-folder")) if (!expansion.choices.has(root)) decided.set(root, true);
  for (const [key, value] of expansion.choices) if (inScope(scope, key)) decided.set(key, value);
  if (members.includes(scope.cover)) { decided.delete(scope.cover); decided.set(scope.cover, true); }
  return decided;
}

/** `decided` with `key` expanded as its latest entry. */
const expandLatest = (decided: Map<NodeKey, boolean>, key: NodeKey) => { decided.delete(key); decided.set(key, true); };

/**
 * The nodes to expand, as the latest entries of `expanded`, so that `target` is visible: one chain
 * of parents from it up to a visible node, preferring visible, then in-folder, then older parents. A reference
 * input without parents shows once one of its outputs does (each output keeps its inputs); a
 * reference badge, once one of its consumers does. Empty when `target` is visible already or is
 * not in the scope.
 */
export function revealPath(scope: ExpansionScope, expanded: BandExpansion, target: NodeKey): NodeKey[] {
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
 * The scope's expansion, oldest first: the defaults, the choices, the cover, and the path each
 * pending reveal needs (expanded, newest). What the layout input carries for an open stack
 * (`OpenStack.expanded`).
 */
export function expandedKeys(expansion: Expansion, scope: ExpansionScope): BandExpansion {
  const decided = chosenKeys(expansion, scope);
  for (const target of expansion.reveals) if (inScope(scope, target)) for (const key of revealPath(scope, decided, target)) expandLatest(decided, key);
  return decided;
}

/** The children `key` has in the scope's component: a node's, or a badge's consumers there. */
function scopeChildren(scope: ExpansionScope, key: NodeKey): readonly NodeKey[] {
  const badge = scope.graph.badges.get(key);
  return (badge ? badge.consumers : scope.graph.dag.children.get(key) ?? []).filter((child) => scope.members.includes(child));
}

/**
 * Whether `key` reads expanded as the band shows it: it has children in the stack and all of them
 * are shown (a node without children there: whether it is expanded, its recorded intent).
 */
export function isOpen(expansion: Expansion, scope: ExpansionScope, key: NodeKey): boolean {
  const decided = expandedKeys(expansion, scope);
  const children = scopeChildren(scope, key);
  if (!children.length) return decided.get(key) === true;
  const visible = new Set(bandVisibleKeys(scope.graph, scope.members, decided));
  return children.every((child) => visible.has(child));
}

/**
 * Turns the pending reveals in this scope into explicit choices (their paths expanded), so a later
 * toggle starts from what is shown. Reveals in other scopes are left pending.
 */
export function settleReveal(expansion: Expansion, scope: ExpansionScope): Expansion {
  const here = expansion.reveals.filter((key) => inScope(scope, key));
  if (!here.length) return expansion;
  const decided = chosenKeys(expansion, scope), settled: NodeKey[] = [];
  for (const target of here) {
    // Outermost first, so the chain reads from the stack down in recency order.
    for (const key of revealPath(scope, decided, target).reverse()) { settled.push(key); expandLatest(decided, key); }
  }
  return { choices: choose(expansion.choices, settled, true), reveals: expansion.reveals.filter((key) => !inScope(scope, key)) };
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
 * A first click on an unselected tile: opens its children unless all of them are shown already.
 * It only ever shows things: `key` becomes the latest choice of each of its children, so they all
 * show, and nothing is collapsed. A node whose children are all shown returns `expansion` itself.
 * A leaf records the intent (it shows nothing and moves nothing: see `expansionAnchor`), so
 * children it gets later show.
 */
export function expandNode(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !inScope(scope, key) || isOpen(expansion, scope, key)) return expansion;
  if (!scopeChildren(scope, key).length) return { ...expansion, choices: choose(expansion.choices, key, true) };
  const settled = settleReveal(expansion, scope);
  return { ...settled, choices: choose(settled.choices, key, true) };
}

/**
 * A job started from the view on `key` (one of its inputs): `key` is revealed, as a selection
 * from outside the view would be, and becomes the latest expanded choice, so the job's
 * placeholder and output (whose latest decider it is then) show under it even when it sat in a
 * collapsed branch. A reference badge is never expanded: the output of badges alone is a root,
 * shown anyway, and expanding one would show its unrelated consumers. `expansion` itself when
 * `key` is shown and already the latest choice, expanded.
 */
export function expandForOutputs(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !scope.members.includes(key)) return expansion;
  const latest = [...expansion.choices].at(-1);
  if (latest?.[0] === key && latest[1] && revealPath(scope, expandedKeys(expansion, scope), key).length === 0) return expansion;
  const settled = settleReveal(revealNode(expansion, key), scope);
  return { ...settled, choices: choose(settled.choices, key, true) };
}

/**
 * The caret, or a second click on the selected tile: flips `key` from what is shown (`isOpen`).
 * Collapsing makes it the latest choice of each of its children, so every child nothing else
 * holds hides, even one another parent expanded earlier; expanding shows them all. A pending
 * reveal in the scope settles first, so collapsing an ancestor of a revealed selection hides it.
 * The cover's expansion is its stack's open state: callers close the stack instead.
 */
export function toggleNode(expansion: Expansion, scope: ExpansionScope, key: NodeKey): Expansion {
  if (!isKey(key) || !inScope(scope, key)) return expansion;
  const settled = settleReveal(expansion, scope);
  return { ...settled, choices: choose(settled.choices, key, !isOpen(settled, scope, key)) };
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

/** The same choices in the same order (the latest decides), and the same pending reveals. */
export function sameExpansion(a: Expansion, b: Expansion): boolean {
  if (a === b) return true;
  if (a.reveals.length !== b.reveals.length || a.reveals.some((key, index) => b.reveals[index] !== key) || a.choices.size !== b.choices.size) return false;
  const other = b.choices.entries();
  for (const [key, value] of a.choices) { const next = other.next().value; if (!next || next[0] !== key || next[1] !== value) return false; }
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
  return { choices: new Map(entries.slice(-MAX_CHOICES)), reveals: [...new Set(pending)].slice(-MAX_REVEALS) };
}
