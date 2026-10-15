/**
 * Two visibility rules. `bandVisibleKeys` is the Trace view's: explicit
 * expansion (see `expansion.ts`). `visibleKeys` is the legacy section view's
 * focus-derived context, kept for `planScene`:
 *
 * Limited context: roots and their immediate children, the focused node's
 * ancestry, direct children and nearest siblings, and every further parent
 * needed to explain a visible output. Visibility is a pure function of the
 * current focus, so earlier selections never accumulate expanded branches.
 *
 * Siblings are the other children of the focus's folder parents only. A
 * reference input (subfolder or external) such as a shared style image can
 * feed hundreds of unrelated outputs, which are not variations of the focus.
 * At most `SIBLING_LIMIT` siblings are shown, those nearest the focus in
 * their parent's child order; a parent with children left out shows its
 * hidden-edits hint as usual.
 */
import type { NodeKey } from "./model";
import type { BadgeProjection, TraceDag } from "./projection";

/** Roots are folder images without a parent in the folder itself. */
export function componentRoots(dag: TraceDag, members: readonly NodeKey[], policy: "legacy" | "in-folder" = "legacy"): NodeKey[] {
  const local = (key: NodeKey) => dag.nodes.get(key)?.scope === "current";
  const roots = members.filter((key) => local(key) && !dag.parents.get(key)!.some(local));
  // A component made only of references still needs an entry point.
  return roots.length || policy === "in-folder" ? roots : members.filter((key) => dag.parents.get(key)!.length === 0);
}

export interface VisibilityOptions {
  /** Bands seed only current-folder roots; legacy reference-only components keep their fallback. */
  readonly roots?: "in-folder";
  /** Extra visible outputs, e.g. direct consumers of a focused reference badge. */
  readonly include?: readonly NodeKey[];
}

export function visibleKeys(dag: TraceDag, members: readonly NodeKey[], focus: NodeKey | null, options: VisibilityOptions = {}): NodeKey[] {
  const inComponent = new Set(members);
  const visible = new Set<NodeKey>();
  const roots = componentRoots(dag, members, options.roots);
  for (const key of options.include ?? []) if (inComponent.has(key)) visible.add(key);
  for (const root of roots) {
    visible.add(root);
    for (const child of dag.children.get(root)!) visible.add(child);
  }
  if (focus !== null && inComponent.has(focus)) {
    visible.add(focus);
    for (const child of dag.children.get(focus)!) visible.add(child);
    for (const sibling of nearestSiblings(dag, focus)) visible.add(sibling);
  }
  // Parent closure: every visible output keeps all of its inputs.
  const pending = [...visible];
  while (pending.length) {
    for (const parent of dag.parents.get(pending.pop()!)!) {
      if (!visible.has(parent)) { visible.add(parent); pending.push(parent); }
    }
  }
  return members.filter((key) => visible.has(key) && inComponent.has(key));
}

/**
 * A band's expansion: whether each key (a member, or a reference badge key) is expanded, in
 * recency order, the latest last (`expandedKeys` in `expansion.ts`). Keys absent decide nothing.
 */
export type BandExpansion = ReadonlyMap<NodeKey, boolean>;

/**
 * Who decides each member's visibility under `expansion`. A node's deciders are its parents in the
 * component and the reference badges it carries; the latest of them in `expansion` decides. When
 * that is "expanded", the node's supporters are its deciders that are expanded: it is shown while
 * one of them is. Otherwise it has none.
 */
interface BandRules {
  readonly inComponent: ReadonlySet<NodeKey>;
  /** Each badge's consumers in this component: a badge shared by other components is never traversed beyond them. */
  readonly badgeConsumers: ReadonlyMap<NodeKey, readonly NodeKey[]>;
  readonly supporters: ReadonlyMap<NodeKey, readonly NodeKey[]>;
  readonly roots: readonly NodeKey[];
}

function bandRules(graph: BadgeProjection, members: readonly NodeKey[], expansion: BandExpansion): BandRules {
  const { dag } = graph;
  const inComponent = new Set(members);
  // Each entry's place in recency order, and its value.
  const rank = new Map<NodeKey, number>(), value = new Map<NodeKey, boolean>();
  for (const [key, expanded] of expansion) if (typeof expanded === "boolean") { rank.set(key, rank.size); value.set(key, expanded); }
  const badgeConsumers = new Map<NodeKey, NodeKey[]>();
  const supporters = new Map<NodeKey, NodeKey[]>();
  for (const key of inComponent) {
    const parents = dag.parents.get(key) ?? [], badges = graph.byConsumer.get(key) ?? [];
    let latest = -1, expanded = false;
    const consider = (decider: NodeKey) => { const at = rank.get(decider); if (at !== undefined && at > latest) { latest = at; expanded = value.get(decider)!; } };
    for (const parent of parents) if (inComponent.has(parent)) consider(parent);
    for (const badge of badges) {
      consider(badge.key);
      const list = badgeConsumers.get(badge.key);
      if (list) list.push(key); else badgeConsumers.set(badge.key, [key]);
    }
    if (!expanded) continue;
    const support: NodeKey[] = [];
    for (const parent of parents) if (inComponent.has(parent) && value.get(parent) === true) support.push(parent);
    for (const badge of badges) if (value.get(badge.key) === true) support.push(badge.key);
    supporters.set(key, support);
  }
  return { inComponent, badgeConsumers, supporters, roots: componentRoots(dag, members, "in-folder") };
}

/**
 * What an open stack's band shows under explicit expansion (docs/trace-view-layout.md, "Visible
 * nodes"): every in-folder root, every parent a shown node needs (each output keeps all of its
 * inputs), and every node whose latest decider (`BandRules`) expanded it while an expanded decider
 * of it is shown: a parent, or a badge some shown node carries. So the latest choice wins for a
 * child of two parents, and a parent hidden by an unrelated collapse never takes a child shown
 * through another one with it. Selection plays no part.
 *
 * The least fixpoint of a monotone rule, found by a worklist: linear in the component and
 * independent of order. Keys outside `members` are ignored; the result is in `members` order.
 */
export function bandVisibleKeys(graph: BadgeProjection, members: readonly NodeKey[], expansion: BandExpansion): NodeKey[] {
  const visible = bandVisibility(graph, bandRules(graph, members, expansion));
  return members.filter((key) => visible.has(key));
}

/** The shown members and the shown badges (those a shown member carries), as one set. */
function bandVisibility(graph: BadgeProjection, rules: BandRules): Set<NodeKey> {
  const { dag } = graph, { inComponent, badgeConsumers, supporters } = rules;
  const visible = new Set<NodeKey>(), pending: NodeKey[] = [];
  const show = (key: NodeKey) => { if (!visible.has(key)) { visible.add(key); pending.push(key); } };
  const offer = (from: NodeKey, child: NodeKey) => { if (supporters.get(child)?.includes(from)) show(child); };
  for (const root of rules.roots) show(root);
  while (pending.length) {
    const key = pending.pop()!;
    const consumers = badgeConsumers.get(key);
    if (consumers && !inComponent.has(key)) { for (const consumer of consumers) offer(key, consumer); continue; }
    for (const parent of dag.parents.get(key) ?? []) if (inComponent.has(parent)) show(parent);
    for (const badge of graph.byConsumer.get(key) ?? []) show(badge.key);
    for (const child of dag.children.get(key) ?? []) if (inComponent.has(child)) offer(key, child);
  }
  return visible;
}

/** The children a key has in the band: a member's children in the component, a badge's consumers in it. */
function bandChildren(graph: BadgeProjection, rules: BandRules, key: NodeKey): readonly NodeKey[] {
  return rules.inComponent.has(key) ? (graph.dag.children.get(key) ?? []).filter((child) => rules.inComponent.has(child)) : rules.badgeConsumers.get(key) ?? [];
}

/** What a band shows and how each shown key's caret reads: open when all of its children are shown. */
export interface BandCarets {
  /** What the band shows (`bandVisibleKeys`), in `members` order. */
  readonly visible: readonly NodeKey[];
  /** Shown keys (members and reference badges) whose caret changes what is shown: only these offer one. */
  readonly togglable: ReadonlySet<NodeKey>;
  /** Shown keys with children, all of them shown: the caret reads expanded, and pressing it collapses. */
  readonly open: ReadonlySet<NodeKey>;
}

/**
 * The carets of a band, so that no control ever does nothing visible. A shown key with children
 * offers one when pressing it changes what is shown: when some child is hidden (expanding makes
 * it the latest decider of every child, so all of them show), or when collapsing hides something.
 * Collapsing makes it the latest decider of every child, so each child loses the support of its
 * rule (`BandRules`), and stays only if something else holds it: a root, or an input a shown
 * output needs. A child shown through a parent that is not otherwise shown goes with it.
 *
 * Exact and near-linear: visibility is reachability from the roots in a graph whose edges are
 * "x shows its parents and badges" and "a supporter shows a node's rule, which shows the node".
 * Collapsing removes the rules of all the node's children. It hides child c when c's rule
 * dominates c: its immediate dominator (Cooper, Harvey and Kennedy, "A Simple, Fast Dominance
 * Algorithm", 2001). Otherwise, with several children held by rules that may hold each other (each
 * an input of an edit the other decides), a search without them decides, within a budget of a
 * few passes over the graph; past it (only in dense lattices of edits) such a caret is left out.
 * A caret offered always changes something.
 */
export function bandCarets(graph: BadgeProjection, members: readonly NodeKey[], expansion: BandExpansion): BandCarets {
  // The view asks for the carets it has just drawn (a click reads them): the last answer per graph is kept.
  const signature = expansionSignature(expansion), last = lastCarets.get(graph);
  if (last && last.signature === signature && sameKeys(last.members, members)) return last.carets;
  const carets = computeCarets(graph, members, expansion);
  lastCarets.set(graph, { members, signature, carets });
  return carets;
}

const lastCarets = new WeakMap<BadgeProjection, { readonly members: readonly NodeKey[]; readonly signature: string; readonly carets: BandCarets }>();

function expansionSignature(expansion: BandExpansion): string {
  let signature = "";
  for (const [key, value] of expansion) signature += (value ? "+" : "-") + key + "\u0000";
  return signature;
}

const sameKeys = (a: readonly NodeKey[], b: readonly NodeKey[]) => a === b || (a.length === b.length && a.every((key, index) => b[index] === key));

function computeCarets(graph: BadgeProjection, members: readonly NodeKey[], expansion: BandExpansion): BandCarets {
  const { dag } = graph;
  const rules = bandRules(graph, members, expansion);
  const visible = bandVisibility(graph, rules);
  // Vertex 0 is the source; then one per shown key, and one per shown node's rule.
  const vertexOf = new Map<NodeKey, number>(), ruleOf = new Map<NodeKey, number>();
  let count = 1;
  for (const key of visible) vertexOf.set(key, count++);
  for (const key of visible) if (rules.inComponent.has(key) && rules.supporters.has(key)) ruleOf.set(key, count++);
  const edges: number[][] = Array.from({ length: count }, () => []);
  let size = count;
  for (const root of rules.roots) edges[0].push(vertexOf.get(root)!);
  for (const key of visible) {
    if (!rules.inComponent.has(key)) continue;
    const at = vertexOf.get(key)!, out = edges[at];
    for (const parent of dag.parents.get(key) ?? []) { const to = rules.inComponent.has(parent) ? vertexOf.get(parent) : undefined; if (to !== undefined) out.push(to); }
    for (const badge of graph.byConsumer.get(key) ?? []) out.push(vertexOf.get(badge.key)!);
    const via = ruleOf.get(key);
    if (via !== undefined) {
      for (const from of rules.supporters.get(key)!) { const supporter = vertexOf.get(from); if (supporter !== undefined) edges[supporter].push(via); }
      edges[via].push(at);
    }
    size += out.length;
  }
  const idom = dominators(edges);
  // Searching without several rules at once is exact but linear per node: a budget of a few
  // passes over the graph keeps the whole linear, after which a caret it would decide is left out.
  let budget = 2 * size + 1000;
  const togglable = new Set<NodeKey>(), open = new Set<NodeKey>();
  for (const key of visible) {
    const children = bandChildren(graph, rules, key);
    if (!children.length) continue;
    if (children.some((child) => !visible.has(child))) { togglable.add(key); continue; }
    open.add(key);
    const held = children.flatMap((child) => { const via = ruleOf.get(child); return via === undefined ? [] : [[vertexOf.get(child)!, via] as const]; });
    if (held.some(([child, via]) => idom[child] === via)) { togglable.add(key); continue; }
    // No single rule holds a child alone; several may hold each other: search without them.
    if (held.length > 1 && budget > 0) {
      const search = reachesAll(edges, new Set(held.map(([, via]) => via)), held.map(([child]) => child), budget);
      budget -= search.visited;
      if (search.reached === false) togglable.add(key);
    }
  }
  return { visible: members.filter((key) => visible.has(key)), togglable, open };
}

/** Siblings shown around a focus; enough for a batch or two of variations. */
export const SIBLING_LIMIT = 12;

/**
 * The focus's siblings through its folder parents, nearest first by distance
 * in the parent's child order (creation order), at most `SIBLING_LIMIT`.
 */
function nearestSiblings(dag: TraceDag, focus: NodeKey): NodeKey[] {
  const distance = new Map<NodeKey, number>();
  for (const parent of dag.parents.get(focus)!) {
    if (dag.nodes.get(parent)?.scope !== "current") continue;
    const children = dag.children.get(parent)!;
    const at = children.indexOf(focus);
    children.forEach((child, index) => {
      if (child === focus) return;
      const gap = Math.abs(index - at);
      if (gap < (distance.get(child) ?? Infinity)) distance.set(child, gap);
    });
  }
  const rank = (key: NodeKey) => dag.nodes.get(key)!.order;
  return [...distance].sort((a, b) => a[1] - b[1] || rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).slice(0, SIBLING_LIMIT).map(([key]) => key);
}

/** Hint counts stop here; the label reads as "999+" territory anyway. */
export const HIDDEN_COUNT_CAP = 999;

/**
 * Edits hidden beneath a visible node, for its "n further edits" hint: the
 * descendants reached through hidden nodes only. Descendants below another
 * visible node belong to that node's hint, so nothing is counted twice and the
 * work stays proportional to the hidden region (capped).
 */
export function hiddenDescendantCount(dag: TraceDag, key: NodeKey, visible: ReadonlySet<NodeKey>): number {
  const seen = new Set<NodeKey>();
  const pending = (dag.children.get(key) ?? []).filter((id) => !visible.has(id));
  while (pending.length && seen.size < HIDDEN_COUNT_CAP) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of dag.children.get(id) ?? []) if (!visible.has(child) && !seen.has(child)) pending.push(child);
  }
  return seen.size;
}

/**
 * Whether every one of `targets` is reachable from vertex 0 without passing through `removed`;
 * null when the search would visit more than `budget` vertices.
 */
function reachesAll(edges: readonly (readonly number[])[], removed: ReadonlySet<number>, targets: readonly number[], budget: number): { reached: boolean | null; visited: number } {
  const wanted = new Set(targets), seen = new Uint8Array(edges.length), stack = [0];
  seen[0] = 1;
  let visited = 0;
  while (stack.length && wanted.size) {
    if (++visited > budget) return { reached: null, visited };
    const at = stack.pop()!;
    wanted.delete(at);
    for (const to of edges[at]) if (!seen[to] && !removed.has(to)) { seen[to] = 1; stack.push(to); }
  }
  return { reached: wanted.size === 0, visited };
}

/** Immediate dominators from node 0 (-1 for unreachable nodes and for 0 itself), iteratively. */
function dominators(edges: readonly (readonly number[] | undefined)[]): number[] {
  const count = edges.length, order: number[] = [], rank = new Array<number>(count).fill(-1);
  // Postorder by an explicit stack.
  const stack: [number, number][] = [[0, 0]], seen = new Uint8Array(count);
  seen[0] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1], next = edges[top[0]] ?? [];
    if (top[1] < next.length) {
      const to = next[top[1]++];
      if (!seen[to]) { seen[to] = 1; stack.push([to, 0]); }
    } else { rank[top[0]] = order.length; order.push(top[0]); stack.pop(); }
  }
  const predecessors: number[][] = Array.from({ length: count }, () => []);
  for (let from = 0; from < count; from++) if (seen[from]) for (const to of edges[from] ?? []) predecessors[to].push(from);
  const idom = new Array<number>(count).fill(-1);
  idom[0] = 0;
  const intersect = (a: number, b: number) => {
    while (a !== b) { while (rank[a] < rank[b]) a = idom[a]; while (rank[b] < rank[a]) b = idom[b]; }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let i = order.length - 2; i >= 0; i--) {
      const at = order[i];
      let dom = -1;
      for (const from of predecessors[at]) if (idom[from] !== -1) dom = dom === -1 ? from : intersect(from, dom);
      if (dom !== idom[at]) { idom[at] = dom; changed = true; }
    }
  }
  idom[0] = -1;
  return idom;
}
