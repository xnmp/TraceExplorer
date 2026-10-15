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
 * What an open stack's band shows under explicit expansion (docs/trace-view-layout.md, "Visible
 * nodes"): every in-folder root; the children of every visible node in `expanded`; the consumers
 * of every expanded reference badge a visible node carries; and every parent a visible node
 * needs, so each output keeps all of its inputs. A node's children are visible exactly when it is
 * expanded and visible itself. Selection plays no part. Linear in the component, keys outside
 * `members` are ignored, and the result is in `members` order.
 */
export function bandVisibleKeys(graph: BadgeProjection, members: readonly NodeKey[], expanded: ReadonlySet<NodeKey>): NodeKey[] {
  const { dag } = graph;
  const inComponent = new Set(members);
  // An expanded badge's consumers in this component, found from the members: a badge shared by
  // other components (one style image used across a folder) is never traversed beyond them.
  const badgeConsumers = new Map<NodeKey, NodeKey[]>();
  for (const key of inComponent) for (const badge of graph.byConsumer.get(key) ?? []) if (expanded.has(badge.key)) {
    const list = badgeConsumers.get(badge.key);
    if (list) list.push(key); else badgeConsumers.set(badge.key, [key]);
  }
  const visible = new Set<NodeKey>(), pending: NodeKey[] = [];
  const show = (key: NodeKey) => { if (inComponent.has(key) && !visible.has(key)) { visible.add(key); pending.push(key); } };
  for (const root of componentRoots(dag, members, "in-folder")) show(root);
  while (pending.length) {
    const key = pending.pop()!;
    for (const parent of dag.parents.get(key) ?? []) show(parent);
    if (expanded.has(key)) for (const child of dag.children.get(key) ?? []) show(child);
    for (const badge of graph.byConsumer.get(key) ?? []) {
      const consumers = badgeConsumers.get(badge.key);
      if (consumers) { badgeConsumers.delete(badge.key); for (const consumer of consumers) show(consumer); }
    }
  }
  return members.filter((key) => visible.has(key));
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
 * The visible members whose caret changes what the band shows (`bandVisibleKeys`), so that no
 * control ever does nothing visible: a collapsed node with a child not shown, and an expanded
 * node with a child that no other expansion keeps shown. A child shown through another open
 * parent (an edit with two inputs), or as an input a shown output needs, is kept by that.
 *
 * Exact and near-linear: `bandVisibleKeys` is reachability from the roots in a graph whose edges
 * are "x shows its parents", "an expanded x shows its children" (through a node standing for x's
 * expansion) and "a shown consumer shows its expanded badge's consumers". Collapsing x hides
 * something exactly when its expansion node dominates another node: the immediate dominator of
 * some node (Cooper, Harvey and Kennedy's iterative algorithm, "A Simple, Fast Dominance
 * Algorithm", 2001).
 */
export function togglableKeys(graph: BadgeProjection, members: readonly NodeKey[], expanded: ReadonlySet<NodeKey>): ReadonlySet<NodeKey> {
  const { dag } = graph;
  const inComponent = new Set(members);
  const visible = new Set(bandVisibleKeys(graph, members, expanded));
  const result = new Set<NodeKey>();
  // Collapsed: expanding shows something exactly when a child is hidden.
  for (const key of visible) if (!expanded.has(key) && (dag.children.get(key) ?? []).some((child) => inComponent.has(child) && !visible.has(child))) result.add(key);
  // Expanded: build the derivation graph over what is shown. Index 0 is the source.
  const ids = new Map<string, number>();
  const id = (name: string) => { let at = ids.get(name); if (at === undefined) ids.set(name, at = ids.size + 1); return at; };
  const edges: number[][] = [[]];
  const edge = (from: number, to: number) => { (edges[from] ??= []).push(to); edges[to] ??= []; };
  const node = (key: NodeKey) => id(`n:${key}`), opened = (key: NodeKey) => id(`e:${key}`), badge = (key: NodeKey) => id(`b:${key}`);
  for (const root of componentRoots(dag, members, "in-folder")) edge(0, node(root));
  const consumers = new Map<NodeKey, NodeKey[]>();
  for (const key of members) for (const reference of graph.byConsumer.get(key) ?? []) if (expanded.has(reference.key)) {
    const list = consumers.get(reference.key);
    if (list) list.push(key); else consumers.set(reference.key, [key]);
  }
  for (const key of visible) {
    for (const parent of dag.parents.get(key) ?? []) if (inComponent.has(parent)) edge(node(key), node(parent));
    const children = (dag.children.get(key) ?? []).filter((child) => inComponent.has(child));
    if (expanded.has(key) && children.length) { edge(node(key), opened(key)); for (const child of children) edge(opened(key), node(child)); }
    for (const reference of graph.byConsumer.get(key) ?? []) if (consumers.has(reference.key)) edge(node(key), badge(reference.key));
  }
  for (const [key, list] of consumers) if (ids.has(`b:${key}`)) for (const consumer of list) edge(badge(key), node(consumer));
  const idom = dominators(edges);
  const owner = new Map<number, NodeKey>();
  for (const key of visible) if (ids.has(`e:${key}`)) owner.set(ids.get(`e:${key}`)!, key);
  for (let at = 1; at < idom.length; at++) { const key = owner.get(idom[at]); if (key !== undefined) result.add(key); }
  return result;
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
