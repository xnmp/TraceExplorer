/**
 * Focus and lineage classification. Ancestors and descendants of the focused
 * node are related; everything else is unrelated (dimmed, still interactive).
 * Without a focus nothing is dimmed. Lineage changes styling only, never tile
 * sizes.
 */
import type { NodeKey } from "./model";
import type { BadgeProjection, TraceDag } from "./projection";

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

/**
 * Badges are virtual parents for highlighting, but never acquire routes or
 * tiles. Optional members restrict traversal to one drawable component: a
 * shared badge must not make planning every band traverse the whole folder.
 */
export function lineageWithBadges(graph: BadgeProjection, focus: NodeKey | null, members?: ReadonlySet<NodeKey>): Lineage {
  const { dag, badges, byConsumer } = graph;
  if (focus === null || (!dag.nodes.has(focus) && !badges.has(focus))) return { focus: null, related: new Set() };
  const consumers = badges.has(focus) && members
    ? [...members].filter((key) => byConsumer.get(key)?.some((badge) => badge.key === focus))
    : badges.get(focus)?.consumers;
  const ancestors = walk(focus, (key) => [
    ...(dag.parents.get(key) ?? []).filter((parent) => !members || members.has(parent)),
    ...(byConsumer.get(key) ?? []).map((badge) => badge.key),
  ]);
  const descendants = walk(focus, (key) => key === focus && consumers ? consumers
    : (dag.children.get(key) ?? []).filter((child) => !members || members.has(child)));
  return { focus, related: new Set([...ancestors, ...descendants]) };
}

export function toneOf(context: Lineage, key: NodeKey): NodeTone {
  if (context.focus === null) return "neutral";
  if (key === context.focus) return "focus";
  return context.related.has(key) ? "related" : "unrelated";
}
