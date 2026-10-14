/**
 * Graph projection: turns recorded nodes into an immutable, acyclic DAG index.
 * Unknown parents are dropped and any edge closing a cycle is discarded
 * deterministically, so later stages can rely on a well-formed DAG.
 */
import type { NodeKey, NodeScope, TraceNode } from "./model";

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
  // Built once: rebuilding it per component made this quadratic in folder size.
  const rank = new Map(dag.order.map((key, index) => [key, index]));
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
    result.push(members.sort((a, b) => rank.get(a)! - rank.get(b)!));
  }
  return result;
}

export interface ReferenceBadge {
  /** Provenance identity, retained for selection and lineage highlighting. */
  readonly key: NodeKey;
  readonly path: string;
  readonly scope: Exclude<NodeScope, "current">;
  /** Direct consumers in stable creation order, across all supplied lineages. */
  readonly consumers: readonly NodeKey[];
}

export interface BadgeProjection {
  /** Drawable DAG: references and their outgoing edges are removed, never reparented. */
  readonly dag: TraceDag;
  readonly badges: ReadonlyMap<NodeKey, ReferenceBadge>;
  /** Each consumer keeps all badges; the renderer shows up to three and a +n overflow. */
  readonly byConsumer: ReadonlyMap<NodeKey, readonly ReferenceBadge[]>;
}

/**
 * Opt-in projection for grid bands. Supply a complete, projected lineage (or
 * folder graph), before visibility filtering, with backend-classified scope.
 * TraceNode represents images; path-null placeholders stay drawable. A foreign
 * image with no accepted parent in this DAG is a badge, even if missing on disk.
 * Foreign images with parents stay tiles. Partial graphs cannot establish that
 * an omitted parent is absent: finish component paging before this transform.
 * Sharing only a badge no longer joins drawable components. The source DAG
 * and its TraceNodes are untouched; the new node.parents also match its index.
 */
export function projectReferenceBadges(source: TraceDag): BadgeProjection {
  const badges = new Map<NodeKey, ReferenceBadge>();
  const byConsumer = new Map<NodeKey, ReferenceBadge[]>();
  for (const key of source.order) {
    const node = source.nodes.get(key)!;
    if (node.scope === "current" || !node.path || source.parents.get(key)!.length) continue;
    const badge: ReferenceBadge = { key, path: node.path, scope: node.scope, consumers: [...source.children.get(key)!] };
    badges.set(key, badge);
    for (const child of badge.consumers) {
      const list = byConsumer.get(child);
      if (list) list.push(badge); else byConsumer.set(child, [badge]);
    }
  }
  const order = source.order.filter((key) => !badges.has(key));
  const nodes = new Map<NodeKey, TraceNode>();
  const parents = new Map<NodeKey, readonly NodeKey[]>();
  const children = new Map<NodeKey, readonly NodeKey[]>();
  for (const key of order) {
    const keptParents = source.parents.get(key)!.filter((parent) => !badges.has(parent));
    nodes.set(key, { ...source.nodes.get(key)!, parents: keptParents });
    parents.set(key, keptParents);
    children.set(key, source.children.get(key)!.filter((child) => !badges.has(child)));
  }
  return { dag: { nodes, parents, children, order }, badges, byConsumer };
}
