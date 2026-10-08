/**
 * Focus and lineage classification. Ancestors and descendants of the focused
 * node are related; everything else is unrelated (dimmed, still interactive).
 * Without a focus nothing is dimmed. Lineage changes styling only, never tile
 * sizes.
 */
import type { NodeKey } from "./model";
import type { TraceDag } from "./projection";

export interface Lineage {
  readonly focus: NodeKey | null;
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
  if (focus === null || !dag.nodes.has(focus)) return { focus: null, related: new Set() };
  const ancestors = walk(focus, (key) => dag.parents.get(key) ?? []);
  const descendants = walk(focus, (key) => dag.children.get(key) ?? []);
  return { focus, related: new Set([...ancestors, ...descendants]) };
}

export function toneOf(context: Lineage, key: NodeKey): NodeTone {
  if (context.focus === null) return "neutral";
  if (key === context.focus) return "focus";
  return context.related.has(key) ? "related" : "unrelated";
}
