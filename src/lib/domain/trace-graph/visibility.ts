/**
 * Limited context: roots and their immediate children, the focused node's
 * ancestry and direct children, and every further parent needed to explain a
 * visible output. Visibility is a pure function of the current focus, so
 * earlier selections never accumulate expanded branches.
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
