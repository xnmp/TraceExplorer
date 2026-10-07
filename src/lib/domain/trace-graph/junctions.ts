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

const isKeyList = (value: unknown): value is readonly NodeKey[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

/** Rejects malformed input and conflicting or cyclic parent sets. */
export function normalizeRelationships(rows: readonly Relationship[]): Relationship[] {
  if (!Array.isArray(rows)) throw new TypeError("Relationships must be an array");
  const normalized = new Map<NodeKey, NodeKey[]>();
  for (const row of rows) {
    const input: unknown = row?.parents;
    if (!row || typeof row.child !== "string" || !row.child || !isKeyList(input)) {
      throw new TypeError("Each relationship needs a child ID and parent IDs");
    }
    const parents = [...new Set(input)].sort();
    const previous = normalized.get(row.child);
    if (previous && setKey(previous) !== setKey(parents)) throw new Error("A child cannot have conflicting parent sets");
    normalized.set(row.child, parents);
  }
  const nodes = new Set([...normalized.keys(), ...[...normalized.values()].flat()]);
  const degree = new Map([...nodes].map((id) => [id, normalized.get(id)?.length ?? 0]));
  const children = new Map([...nodes].map((id) => [id, [] as NodeKey[]]));
  normalized.forEach((parents, child) => parents.forEach((parent) => children.get(parent)!.push(child)));
  const ready = [...nodes].filter((id) => degree.get(id) === 0);
  for (let index = 0; index < ready.length; index++) {
    for (const child of children.get(ready[index])!) {
      const next = degree.get(child)! - 1;
      degree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (ready.length !== nodes.size) throw new Error("Provenance must be acyclic");
  return [...normalized].sort(([a], [b]) => a.localeCompare(b)).map(([child, parents]) => ({ child, parents }));
}

/** Upper bound on optional shared-subset junctions; complete sets are never capped. */
const MAX_SHARED_SUBSETS = 128;

export function buildInputJunctions(relationships: readonly Relationship[]): JunctionPlan {
  const rows = normalizeRelationships(relationships);
  const fullSets = new Map(rows.filter((row) => row.parents.length > 1).map((row) => [setKey(row.parents), row.parents]));
  const sets = [...fullSets.values()];
  const supportCache = new Map<string, number>();
  const support = (ids: readonly NodeKey[]) => {
    const key = setKey(ids);
    let value = supportCache.get(key);
    if (value === undefined) {
      value = rows.filter((row) => ids.every((id) => row.parents.includes(id))).length;
      supportCache.set(key, value);
    }
    return value;
  };
  const intersections = new Map<string, readonly NodeKey[]>();
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const other = new Set(sets[j]);
      const shared = sets[i].filter((parent) => other.has(parent));
      if (shared.length > 1 && !fullSets.has(setKey(shared))) intersections.set(setKey(shared), shared);
    }
  }
  const useful = [...intersections.values()]
    .sort((a, b) => (b.length - 1) * support(b) - (a.length - 1) * support(a) || setKey(a).localeCompare(setKey(b)))
    .slice(0, MAX_SHARED_SUBSETS);
  const allSets = [...new Map([...fullSets, ...useful.map((ids) => [setKey(ids), ids] as const)]).values()]
    .sort((a, b) => a.length - b.length || setKey(a).localeCompare(setKey(b)));

  const joins: Junction[] = [];
  const bySet = new Map<string, Junction>();
  for (const parents of allSets) {
    const remaining = new Set(parents);
    const inputs: Endpoint[] = [];
    // Disjoint smaller groups partition this set. Overlapping alternatives are
    // never both reused within one join, avoiding duplicate or false paths.
    const candidates = joins
      .filter((join) => join.parents.length < parents.length && join.parents.every((parent) => remaining.has(parent)))
      .sort((a, b) => b.parents.length - a.parents.length || support(b.parents) - support(a.parents) || setKey(a.parents).localeCompare(setKey(b.parents)));
    for (const candidate of candidates) {
      if (!candidate.parents.every((parent) => remaining.has(parent))) continue;
      inputs.push({ kind: "junction", id: candidate.id });
      candidate.parents.forEach((parent) => remaining.delete(parent));
    }
    inputs.push(...[...remaining].map((id) => ({ kind: "node", id }) as const));
    const join: Junction = { id: junctionId(parents), parents, inputs };
    joins.push(join);
    bySet.set(setKey(parents), join);
  }

  const byId = new Map(joins.map((join) => [join.id, join]));
  const routes = new Map<string, { from: Endpoint; to: Endpoint; consumers: Map<string, Consumer> }>();
  const used = new Set<string>();
  const visit = (input: Endpoint, child: NodeKey, downstream: readonly { from: Endpoint; to: Endpoint }[]): void => {
    if (input.kind === "node") {
      for (const edge of downstream) {
        const id = `${endpointKey(edge.from)}>${endpointKey(edge.to)}`;
        const route = routes.get(id) ?? { ...edge, consumers: new Map() };
        route.consumers.set(`${input.id}>${child}`, { parent: input.id, child });
        routes.set(id, route);
      }
      return;
    }
    used.add(input.id);
    for (const source of byId.get(input.id)!.inputs) visit(source, child, [{ from: source, to: input }, ...downstream]);
  };
  for (const row of rows) {
    if (!row.parents.length) continue;
    const input: Endpoint = row.parents.length === 1
      ? { kind: "node", id: row.parents[0] }
      : { kind: "junction", id: bySet.get(setKey(row.parents))!.id };
    visit(input, row.child, [{ from: input, to: { kind: "node", id: row.child } }]);
  }
  return {
    joins: joins.filter((join) => used.has(join.id)),
    routes: [...routes.values()].map((route) => ({ from: route.from, to: route.to, consumers: [...route.consumers.values()] })),
  };
}
