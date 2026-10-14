/**
 * Input grouping for multi-parent outputs. Incoming connections combine at a
 * junction before the child, leaving one terminal arrow per output. Identical
 * input sets reuse one junction, and shared subsets are combined first:
 * `(a,b)` can feed `e` and then join `c` to feed `d`. Partially overlapping
 * sets stay distinct and never imply an extra parent.
 *
 * Junctions are routing geometry, not selectable nodes. Their IDs derive from
 * their parent set, so they stay stable across relayouts and animations.
 */
import type { NodeKey } from "./model";

export interface Relationship { readonly child: NodeKey; readonly parents: readonly NodeKey[] }

export type Endpoint =
  | { readonly kind: "node"; readonly id: NodeKey }
  | { readonly kind: "junction"; readonly id: string };

export interface Junction {
  readonly id: string;
  /** Every parent combined by this junction, sorted. */
  readonly parents: readonly NodeKey[];
  /** Direct inputs: nested junctions and remaining individual parents. */
  readonly inputs: readonly Endpoint[];
}

/** The underlying parent→child relationships a route segment carries. */
export interface Consumer { readonly parent: NodeKey; readonly child: NodeKey }

export interface Route {
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly consumers: readonly Consumer[];
}

export interface JunctionPlan {
  readonly joins: readonly Junction[];
  readonly routes: readonly Route[];
}

const setKey = (ids: readonly NodeKey[]) => JSON.stringify(ids);
export const junctionId = (parents: readonly NodeKey[]) => `j:${setKey(parents)}`;
export const endpointKey = (end: Endpoint) => `${end.kind}:${end.id}`;

const isKeyList = (value: unknown): value is readonly NodeKey[] => {
  if (!Array.isArray(value)) return false;
  // `every` skips holes, so a hole is not a key and not a failure either.
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) continue;
    const item: unknown = value[i];
    if (typeof item !== "string" || item.length === 0) return false;
  }
  return true;
};

/** Rejects malformed input and conflicting or cyclic parent sets. */
export function normalizeRelationships(rows: readonly Relationship[]): Relationship[] {
  if (!Array.isArray(rows)) throw new TypeError("Relationships must be an array");
  const normalized = new Map<NodeKey, NodeKey[]>();
  for (const row of rows) {
    const input: unknown = row?.parents;
    if (!row || typeof row.child !== "string" || !row.child || !isKeyList(input)) {
      throw new TypeError("Each relationship needs a child ID and parent IDs");
    }
    // A lone parent needs no deduplication or sort.
    const parents = input.length < 2 ? [...input] : [...new Set(input)].sort();
    const previous = normalized.get(row.child);
    if (previous && setKey(previous) !== setKey(parents)) throw new Error("A child cannot have conflicting parent sets");
    normalized.set(row.child, parents);
  }
  if (!acyclic(normalized)) throw new Error("Provenance must be acyclic");
  const result: Relationship[] = [];
  for (const [child, parents] of normalized) result.push({ child, parents });
  return result.sort((a, b) => a.child.localeCompare(b.child));
}

/**
 * Whether every node can be ordered after its parents (Kahn's algorithm, which
 * empties the graph exactly when it has no cycle). Nodes are indexed by first
 * appearance, children first.
 */
function acyclic(parentsOf: ReadonlyMap<NodeKey, readonly NodeKey[]>): boolean {
  const index = new Map<NodeKey, number>();
  for (const child of parentsOf.keys()) index.set(child, index.size);
  for (const parents of parentsOf.values()) for (const parent of parents) if (!index.has(parent)) index.set(parent, index.size);
  const degree = new Array<number>(index.size).fill(0), children: number[][] = [];
  for (let i = 0; i < index.size; i++) children.push([]);
  let at = 0;
  for (const parents of parentsOf.values()) {
    degree[at] = parents.length;
    for (const parent of parents) children[index.get(parent)!].push(at);
    at++;
  }
  const ready: number[] = [];
  for (let i = 0; i < degree.length; i++) if (degree[i] === 0) ready.push(i);
  for (let r = 0; r < ready.length; r++) for (const child of children[ready[r]]) if (--degree[child] === 0) ready.push(child);
  return ready.length === index.size;
}

/** Upper bound on optional shared-subset junctions; complete sets are never capped. */
const MAX_SHARED_SUBSETS = 128;

export function buildInputJunctions(relationships: readonly Relationship[]): JunctionPlan {
  const rows = normalizeRelationships(relationships);
  // No output with several parents (a tree or forest): no junctions, and one
  // route per parent edge, in row order, carrying just that edge. Route ids
  // (`node:parent>node:child`) are then distinct since children are, unless a
  // key contains ">"; such keys take the general path, which merges equal ids.
  if (rows.every((row) => row.parents.length < 2 && !row.child.includes(">") && !(typeof row.parents[0] === "string" && row.parents[0].includes(">")))) {
    const routes: Route[] = [];
    for (const { child, parents } of rows) {
      if (!parents.length) continue;
      const parent = parents[0];
      routes.push({ from: { kind: "node", id: parent }, to: { kind: "node", id: child }, consumers: [{ parent, child }] });
    }
    return { joins: [], routes };
  }
  const fullSets = new Map(rows.filter((row) => row.parents.length > 1).map((row) => [setKey(row.parents), row.parents]));
  const sets = [...fullSets.values()];
  // Parent lists are never mutated, so each one's key is computed once.
  const keyCache = new Map<readonly NodeKey[], string>();
  const keyOf = (ids: readonly NodeKey[]) => {
    let key = keyCache.get(ids);
    if (key === undefined) keyCache.set(ids, key = setKey(ids));
    return key;
  };
  const supportCache = new Map<string, number>();
  const support = (ids: readonly NodeKey[]) => {
    const key = keyOf(ids);
    let value = supportCache.get(key);
    if (value === undefined) {
      value = rows.filter((row) => ids.every((id) => row.parents.includes(id))).length;
      supportCache.set(key, value);
    }
    return value;
  };
  const intersections = new Map<string, readonly NodeKey[]>();
  const memberSets = sets.map((set) => new Set(set));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const other = memberSets[j];
      const shared = sets[i].filter((parent) => other.has(parent));
      if (shared.length > 1) {
        const key = setKey(shared);
        if (!fullSets.has(key)) intersections.set(key, shared);
      }
    }
  }
  const useful = [...intersections.values()]
    .sort((a, b) => (b.length - 1) * support(b) - (a.length - 1) * support(a) || keyOf(a).localeCompare(keyOf(b)))
    .slice(0, MAX_SHARED_SUBSETS);
  const allSets = [...new Map([...fullSets, ...useful.map((ids) => [keyOf(ids), ids] as const)]).values()]
    .sort((a, b) => a.length - b.length || keyOf(a).localeCompare(keyOf(b)));

  const joins: Junction[] = [];
  const bySet = new Map<string, Junction>();
  for (const parents of allSets) {
    const remaining = new Set(parents);
    const inputs: Endpoint[] = [];
    // Disjoint smaller groups partition this set. Overlapping alternatives are
    // never both reused within one join, avoiding duplicate or false paths.
    const candidates = joins
      .filter((join) => join.parents.length < parents.length && join.parents.every((parent) => remaining.has(parent)))
      .sort((a, b) => b.parents.length - a.parents.length || support(b.parents) - support(a.parents) || keyOf(a.parents).localeCompare(keyOf(b.parents)));
    for (const candidate of candidates) {
      if (!candidate.parents.every((parent) => remaining.has(parent))) continue;
      inputs.push({ kind: "junction", id: candidate.id });
      candidate.parents.forEach((parent) => remaining.delete(parent));
    }
    inputs.push(...[...remaining].map((id) => ({ kind: "node", id }) as const));
    const join: Junction = { id: junctionId(parents), parents, inputs };
    joins.push(join);
    bySet.set(keyOf(parents), join);
  }

  const byId = new Map(joins.map((join) => [join.id, join]));
  const routes = new Map<string, { from: Endpoint; to: Endpoint; consumers: Map<string, Consumer> }>();
  const used = new Set<string>();
  // A route segment, keyed by its ends.
  type Edge = { readonly from: Endpoint; readonly to: Endpoint; readonly id: string };
  const edge = (from: Endpoint, to: Endpoint): Edge => ({ from, to, id: `${endpointKey(from)}>${endpointKey(to)}` });
  const edgesInto = new Map<string, Edge[]>();
  const visit = (input: Endpoint, child: NodeKey, downstream: readonly Edge[]): void => {
    if (input.kind === "node") {
      const consumer = `${input.id}>${child}`;
      for (const { from, to, id } of downstream) {
        let route = routes.get(id);
        if (!route) routes.set(id, route = { from, to, consumers: new Map() });
        route.consumers.set(consumer, { parent: input.id, child });
      }
      return;
    }
    used.add(input.id);
    const { inputs } = byId.get(input.id)!;
    // The segments into a junction are the same for every child it feeds.
    let into = edgesInto.get(input.id);
    if (!into) edgesInto.set(input.id, into = inputs.map((source) => edge(source, input)));
    inputs.forEach((source, index) => visit(source, child, [into[index], ...downstream]));
  };
  for (const row of rows) {
    if (!row.parents.length) continue;
    const input: Endpoint = row.parents.length === 1
      ? { kind: "node", id: row.parents[0] }
      : { kind: "junction", id: bySet.get(keyOf(row.parents))!.id };
    visit(input, row.child, [edge(input, { kind: "node", id: row.child })]);
  }
  return {
    joins: joins.filter((join) => used.has(join.id)),
    routes: [...routes.values()].map((route) => ({ from: route.from, to: route.to, consumers: [...route.consumers.values()] })),
  };
}
