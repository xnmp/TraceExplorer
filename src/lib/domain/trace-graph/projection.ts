/**
 * Graph projection: turns recorded nodes into an immutable, acyclic DAG index.
 * Unknown parents are dropped and any edge closing a cycle is discarded
 * deterministically, so later stages can rely on a well-formed DAG.
 */
import type { NodeKey, TraceNode } from "./model";

export interface TraceDag {
  readonly nodes: ReadonlyMap<NodeKey, TraceNode>;
  readonly parents: ReadonlyMap<NodeKey, readonly NodeKey[]>;
  readonly children: ReadonlyMap<NodeKey, readonly NodeKey[]>;
  /** Keys in stable order (creation order, then key). */
  readonly order: readonly NodeKey[];
}

const byOrder = (a: TraceNode, b: TraceNode) => a.order - b.order || a.key.localeCompare(b.key);

export function projectDag(input: readonly TraceNode[]): TraceDag {
  const nodes = new Map<NodeKey, TraceNode>();
  for (const node of [...input].sort(byOrder)) if (!nodes.has(node.key)) nodes.set(node.key, node);
  const order = [...nodes.keys()];
  const parents = new Map<NodeKey, NodeKey[]>(order.map((key) => [key, []]));
  const children = new Map<NodeKey, NodeKey[]>(order.map((key) => [key, []]));
  const candidates = order.map((key) => [key, [...new Set(nodes.get(key)!.parents)].filter((parent) => parent !== key && nodes.has(parent))] as const);
  if (isAcyclic(order, candidates)) {
    for (const [key, list] of candidates) for (const parent of list) { parents.get(key)!.push(parent); children.get(parent)!.push(key); }
    return { nodes, parents, children, order };
  }
  // Malformed history: insert edges in stable order, keeping an edge only if
  // it cannot close a cycle with the edges accepted so far.
  const reaches = (from: NodeKey, to: NodeKey): boolean => {
    const seen = new Set<NodeKey>([from]);
    const pending = [from];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === to) return true;
      for (const next of children.get(id)!) if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
    return false;
  };
  for (const [key, list] of candidates) {
    for (const parent of list) {
      if (reaches(key, parent)) continue;
      parents.get(key)!.push(parent);
      children.get(parent)!.push(key);
    }
  }
  return { nodes, parents, children, order };
}

function isAcyclic(order: readonly NodeKey[], edges: readonly (readonly [NodeKey, readonly NodeKey[]])[]): boolean {
  const degree = new Map(edges.map(([key, list]) => [key, list.length]));
  const out = new Map<NodeKey, NodeKey[]>(order.map((key) => [key, []]));
  for (const [key, list] of edges) for (const parent of list) out.get(parent)!.push(key);
  const ready = order.filter((key) => degree.get(key) === 0);
  for (let index = 0; index < ready.length; index++) {
    for (const child of out.get(ready[index])!) {
      const next = degree.get(child)! - 1;
      degree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  return ready.length === order.length;
}

/** Connected components over the displayed relationships, in stable order. */
export function connectedComponents(dag: TraceDag): NodeKey[][] {
  const seen = new Set<NodeKey>();
  const result: NodeKey[][] = [];
  for (const start of dag.order) {
    if (seen.has(start)) continue;
    const members: NodeKey[] = [];
    const pending = [start];
    seen.add(start);
    while (pending.length) {
      const id = pending.pop()!;
      members.push(id);
      for (const next of [...dag.parents.get(id)!, ...dag.children.get(id)!]) {
        if (!seen.has(next)) { seen.add(next); pending.push(next); }
      }
    }
    const rank = new Map(dag.order.map((key, index) => [key, index]));
    result.push(members.sort((a, b) => rank.get(a)! - rank.get(b)!));
  }
  return result;
}
