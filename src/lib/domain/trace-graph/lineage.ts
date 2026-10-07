/**
 * Focus and lineage classification. Only the focused node, its direct parents
 * and its direct children are large. Ancestors and descendants are related;
 * everything else is unrelated (dimmed, still interactive). Without a focus
 * nothing is large and nothing is dimmed.
 */
import type { NodeKey } from "./model";
import type { TraceDag } from "./projection";

export interface Lineage {
  readonly focus: NodeKey | null;
  readonly large: ReadonlySet<NodeKey>;
  readonly related: ReadonlySet<NodeKey>;
}

export type NodeTone = "focus" | "related" | "unrelated" | "neutral";

const walk = (start: NodeKey, next: (key: NodeKey) => readonly NodeKey[]): Set<NodeKey> => {
  const seen = new Set<NodeKey>([start]);
  const pending = [start];
  while (pending.length) for (const id of next(pending.pop()!)) if (!seen.has(id)) { seen.add(id); pending.push(id); }
  return seen;
};

export function lineage(dag: TraceDag, focus: NodeKey | null): Lineage {
  if (focus === null || !dag.nodes.has(focus)) return { focus: null, large: new Set(), related: new Set() };
  const parents = dag.parents.get(focus)!;
  const children = dag.children.get(focus)!;
  const ancestors = walk(focus, (key) => dag.parents.get(key) ?? []);
  const descendants = walk(focus, (key) => dag.children.get(key) ?? []);
  return {
    focus,
    large: new Set([focus, ...parents, ...children]),
    related: new Set([...ancestors, ...descendants]),
  };
}

export function toneOf(context: Lineage, key: NodeKey): NodeTone {
  if (context.focus === null) return "neutral";
  if (key === context.focus) return "focus";
  return context.related.has(key) ? "related" : "unrelated";
}
