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
