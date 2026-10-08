/**
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
import type { TraceDag } from "./projection";

/** Roots are folder images without a parent in the folder itself. */
export function componentRoots(dag: TraceDag, members: readonly NodeKey[]): NodeKey[] {
  const local = (key: NodeKey) => dag.nodes.get(key)?.scope === "current";
  const roots = members.filter((key) => local(key) && !dag.parents.get(key)!.some(local));
  // A component made only of references still needs an entry point.
  return roots.length ? roots : members.filter((key) => dag.parents.get(key)!.length === 0);
}

export function visibleKeys(dag: TraceDag, members: readonly NodeKey[], focus: NodeKey | null): NodeKey[] {
  const inComponent = new Set(members);
  const visible = new Set<NodeKey>();
  const roots = componentRoots(dag, members);
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
