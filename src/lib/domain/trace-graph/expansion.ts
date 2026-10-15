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
 * Defaults: in-folder roots (the cover among them) are expanded unless the user collapsed them,
 * older than any choice; every other node is collapsed until expanded. Opening a stack is a
 * choice too: it expands the cover as the latest choice (`openStack`), so the cover's children
 * show, and a later collapse of another of their parents still hides them.
 *
 * A reference badge's choice belongs to the stack it was made in (`badgeChoiceKey`): one style
 * image shared by many stacks opens its consumers only where it was pressed.
 *
 * Eviction never changes what is shown: choices of loaded nodes are always kept, and only
 * choices of nodes not loaded beyond `MAX_UNKNOWN_CHOICES` are forgotten (`pruneExpansion`).
 */
import type { NodeKey } from "./model";
import type { BadgeProjection } from "./projection";
import { bandVisibleKeys, componentRoots, type BandExpansion } from "./visibility";

export interface Expansion {
  /**
   * The user's explicit choices by node key (a reference badge's by `badgeChoiceKey`): true
   * expanded, false collapsed. Absent keys take the default. Insertion order is recency (latest
   * last).
   */
  readonly choices: ReadonlyMap<string, boolean>;
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
  /** The stack's cover: a stable key for the stack (component ids change when components merge). */
  readonly cover: NodeKey;
}

const BADGE_SEPARATOR = "\u001f";

/** The choice key of reference badge `badge` pressed in the stack whose cover is `cover`. */
export const badgeChoiceKey = (cover: NodeKey, badge: NodeKey): string => `${cover}${BADGE_SEPARATOR}${badge}`;

/** The node a choice key is about: itself, or a badge choice's badge. */
export function choiceNode(key: string): NodeKey {
  const at = key.indexOf(BADGE_SEPARATOR);
  return at < 0 ? key : key.slice(at + 1);
}

const memberSets = new WeakMap<readonly NodeKey[], ReadonlySet<NodeKey>>();
/** The scope's members as a set, built once per members array. */
function memberSet(scope: ExpansionScope): ReadonlySet<NodeKey> {
  let set = memberSets.get(scope.members);
  if (!set) memberSets.set(scope.members, set = new Set(scope.members));
  return set;
}

/** `choices` with each of `keys` set to `value`, in order, as the most recent. */
function choose(choices: ReadonlyMap<string, boolean>, keys: string | readonly string[], value: boolean): ReadonlyMap<string, boolean> {
  const next = new Map(choices);
  for (const key of typeof keys === "string" ? [keys] : keys) { next.delete(key); next.set(key, value); }
  return next;
}

const isKey = (value: unknown): value is NodeKey => typeof value === "string" && value.length > 0;

/** Whether `key` belongs to the scope: a member or one of its reference badges. */
const inScope = (scope: ExpansionScope, key: NodeKey): boolean => memberSet(scope).has(key) || scope.graph.badges.has(key);

/** The choice key of `key` (in the scope) in `Expansion.choices`. */
const choiceKey = (scope: ExpansionScope, key: NodeKey): string => scope.graph.badges.has(key) ? badgeChoiceKey(scope.cover, key) : key;

/** The scope key a choice is about, or null when it is not about this stack. */
function scopedKey(scope: ExpansionScope, key: string): NodeKey | null {
  const at = key.indexOf(BADGE_SEPARATOR);
  if (at < 0) return memberSet(scope).has(key) ? key : null;
  const badge = key.slice(at + 1);
  return key.slice(0, at) === scope.cover && scope.graph.badges.has(badge) ? badge : null;
}

/** The children `key` has in the scope's component: a node's, or a badge's consumers there. */
function scopeChildren(scope: ExpansionScope, key: NodeKey): readonly NodeKey[] {
  const badge = scope.graph.badges.get(key), members = memberSet(scope);
  return (badge ? badge.consumers : scope.graph.dag.children.get(key) ?? []).filter((child) => members.has(child));
}

/**
 * What the choices alone decide in the scope, oldest first: unchosen in-folder roots and the cover
 * (expanded), then the scope's choices in order.
 */
function chosenKeys(expansion: Expansion, scope: ExpansionScope): Map<NodeKey, boolean> {
  const { graph, members } = scope;
  const decided = new Map<NodeKey, boolean>();
  for (const root of [scope.cover, ...componentRoots(graph.dag, members, "in-folder")]) if (memberSet(scope).has(root) && !expansion.choices.has(root)) decided.set(root, true);
  for (const [key, value] of expansion.choices) {
    const scoped = scopedKey(scope, key);
    if (scoped !== null) { decided.delete(scoped); decided.set(scoped, value); }
  }
  return decided;
}

/** `decided` with `key` expanded as its latest entry. */
const expandLatest = (decided: Map<NodeKey, boolean>, key: NodeKey) => { decided.delete(key); decided.set(key, true); };

/** Older first, by creation order then key: so a path never depends on how parents were listed. */
const byAge = (scope: ExpansionScope) => (a: NodeKey, b: NodeKey) =>
  (scope.graph.dag.nodes.get(a)?.order ?? 0) - (scope.graph.dag.nodes.get(b)?.order ?? 0) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The keys to expand, as the latest entries of `expanded`, so that `target` is visible: one chain
 * from it up to a visible node or badge, through parents and the badges it carries, preferring a
 * visible parent, then a visible badge, then an in-folder parent, then the oldest. A reference
 * input without parents shows once one of its outputs does (each output keeps its inputs); a
 * reference badge, once one of its consumers does. Empty when `target` is visible already or is
 * not in the scope. Deterministic: independent of the order parents and members are listed in.
 */
export function revealPath(scope: ExpansionScope, expanded: BandExpansion, target: NodeKey): NodeKey[] {
  return revealPathIn(scope, new Set(bandVisibleKeys(scope.graph, scope.members, expanded)), target);
}

function revealPathIn(scope: ExpansionScope, visible: ReadonlySet<NodeKey>, target: NodeKey): NodeKey[] {
  const { graph } = scope, { dag } = graph, members = memberSet(scope), older = byAge(scope);
  const consumersOf = (badge: NodeKey) => (graph.badges.get(badge)?.consumers ?? []).filter((key) => members.has(key));
  let at = target;
  if (graph.badges.has(target)) {
    const consumers = consumersOf(target).sort(older);
    if (!consumers.length || consumers.some((key) => visible.has(key))) return [];
    at = consumers[0];
  }
  if (!members.has(at)) return [];
  const local = (key: NodeKey) => dag.nodes.get(key)?.scope === "current";
  const path: NodeKey[] = [], seen = new Set<NodeKey>();
  while (!visible.has(at) && !seen.has(at)) {
    seen.add(at);
    const parents = (dag.parents.get(at) ?? []).filter((key) => members.has(key)).sort(older);
    const shownParent = parents.find((key) => visible.has(key));
    const shownBadge = shownParent === undefined
      ? (graph.byConsumer.get(at) ?? []).map((badge) => badge.key).filter((badge) => consumersOf(badge).some((key) => visible.has(key))).sort()[0] : undefined;
    // A badge shown on another consumer: expanding it shows this one.
    if (shownBadge !== undefined) { path.push(shownBadge); break; }
    const parent = shownParent ?? parents.find(local) ?? parents[0];
    if (parent !== undefined) { path.push(parent); at = parent; continue; }
    // No parent here, but a badge: expand it, and reveal another of its consumers.
    const viaBadge = (graph.byConsumer.get(at) ?? []).map((badge) => badge.key).sort()
      .map((badge) => [badge, consumersOf(badge).filter((key) => !seen.has(key)).sort(older)] as const).find(([, others]) => others.length);
    if (viaBadge) { path.push(viaBadge[0]); at = viaBadge[1].find(local) ?? viaBadge[1][0]; continue; }
    // A parentless reference input: reveal an output of it instead.
    const children = (dag.children.get(at) ?? []).filter((key) => members.has(key) && !seen.has(key)).sort(older);
    const child = children.find(local) ?? children[0];
    if (child === undefined) break;
    at = child;
  }
  return path;
}

/** The pending reveals' paths in the scope, expanding `decided` as it goes (newest entries). */
function revealAll(expansion: Expansion, scope: ExpansionScope, decided: Map<NodeKey, boolean>): NodeKey[] {
  const settled: NodeKey[] = [];
  let visible: ReadonlySet<NodeKey> | null = null;
  for (const target of expansion.reveals) {
    if (!inScope(scope, target)) continue;
    visible ??= new Set(bandVisibleKeys(scope.graph, scope.members, decided));
    const path = revealPathIn(scope, visible, target);
    if (!path.length) continue;
    // Outermost first, so the chain reads from the stack down in recency order.
    for (const key of path.reverse()) { settled.push(key); expandLatest(decided, key); }
    visible = null;
  }
  return settled;
}

/**
 * The scope's expansion, oldest first: the defaults, the choices, and the path each pending reveal
 * needs (expanded, newest). What the layout input carries for an open stack (`OpenStack.expanded`).
 */
export function expandedKeys(expansion: Expansion, scope: ExpansionScope): BandExpansion {
  const decided = chosenKeys(expansion, scope);
  revealAll(expansion, scope, decided);
  return decided;
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
  if (!expansion.reveals.some((key) => inScope(scope, key))) return expansion;
  const settled = revealAll(expansion, scope, chosenKeys(expansion, scope));
  return { choices: choose(expansion.choices, settled.map((key) => choiceKey(scope, key)), true), reveals: expansion.reveals.filter((key) => !inScope(scope, key)) };
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
 * The stack whose cover is the scope's opened: the cover's expansion becomes the latest choice, so
 * its children show (it only ever shows things). `expansion` itself when it is the latest already.
 */
export function openStack(expansion: Expansion, cover: NodeKey): Expansion {
  if (!isKey(cover)) return expansion;
  const latest = [...expansion.choices].at(-1);
  if (latest?.[0] === cover && latest[1]) return expansion;
  return { ...expansion, choices: choose(expansion.choices, cover, true) };
}

/**
 * The node the layout holds still in this scope: the one the user expanded or collapsed last
 * (the most recent choice in the scope of a node with children other than the cover, which is
 * pinned anyway: a leaf's recorded intent shows nothing, so it moves nothing), else the latest
 * pending reveal in it; null for none.
 */
export function expansionAnchor(expansion: Expansion, scope: ExpansionScope): NodeKey | null {
  const keys = [...expansion.choices.keys()];
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = scopedKey(scope, keys[index]);
    if (key !== null && key !== scope.cover && scopeChildren(scope, key).length > 0) return key;
  }
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
  if (!scopeChildren(scope, key).length) return { ...expansion, choices: choose(expansion.choices, choiceKey(scope, key), true) };
  const settled = settleReveal(expansion, scope);
  return { ...settled, choices: choose(settled.choices, choiceKey(scope, key), true) };
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
  if (!isKey(key) || !memberSet(scope).has(key)) return expansion;
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
  return { ...settled, choices: choose(settled.choices, choiceKey(scope, key), !isOpen(settled, scope, key)) };
}

/** Whether a chosen node still exists: in loaded data, gone from it, or not known (its stack is not loaded). */
export type ChoiceStatus = "present" | "gone" | "unknown";

/** Choices of nodes that are not loaded are kept, but only this many (the most recent). */
export const MAX_UNKNOWN_CHOICES = 256;

/**
 * Drops choices (and pending reveals) of nodes that are gone, and all but the most recent `limit`
 * choices of nodes not known. Choices of loaded nodes are always kept (the loaded data bounds
 * them), so forgetting one never changes what is shown. `status` is asked about each choice's
 * node (`choiceNode`). Returns `expansion` itself when nothing changes.
 */
export function pruneExpansion(expansion: Expansion, status: (key: NodeKey) => ChoiceStatus, limit = MAX_UNKNOWN_CHOICES): Expansion {
  const entries = [...expansion.choices].filter(([key, value]) => isKey(key) && isKey(choiceNode(key)) && typeof value === "boolean");
  const states = entries.map(([key]) => status(choiceNode(key)));
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
  const entries = choices instanceof Map ? [...choices].filter(([key, open]) => isKey(key) && typeof open === "boolean") as [string, boolean][] : [];
  // An older snapshot kept one pending reveal.
  const pending = Array.isArray(reveals) ? reveals.filter(isKey) : isKey(reveal) ? [reveal] : [];
  return { choices: new Map(entries), reveals: [...new Set(pending)].slice(-MAX_REVEALS) };
}
