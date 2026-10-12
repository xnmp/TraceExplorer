import type { NodeKey } from "$lib/domain/trace-graph/model";
import { unresolvedTargetComponents, type TargetIndex } from "./target-location";

/** Resolve stable hit keys using only the latest index's component identities. */
export function pendingMarqueeComponents(
  keys: readonly NodeKey[],
  listedPaths: ReadonlySet<string>,
  covers: ReadonlyMap<NodeKey, { readonly id: string; readonly cover?: { readonly path: string } | null }>,
  index: TargetIndex,
): string[] {
  return [...new Set(keys.flatMap((key) => {
    if (listedPaths.has(key)) return [];
    const summary = covers.get(key);
    // Listed covers can be resolved by the index; a different revision at
    // that path must never become an input of the drawn cover.
    if (summary?.cover && listedPaths.has(summary.cover.path)) return [];
    return unresolvedTargetComponents(key, summary?.id ?? "", index);
  }))];
}
