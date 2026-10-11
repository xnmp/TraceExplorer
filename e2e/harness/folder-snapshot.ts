import type { TraceNode } from "$lib/domain/trace-graph/model";

const isPresentRevision = (node: TraceNode): boolean => node.artifactId !== null
  && node.state === "present" && !node.discarded && !node.earlierRevision;

/** Only direct seeds are folder members; historical parents stay unlisted. */
export const isDirectFolderSeed = (node: TraceNode): boolean => isPresentRevision(node)
  && node.scope === "current" && !node.temporary && !!node.path;

/** Mirrors native load_snapshot/resolve_facts: current files and unsaved
 * outputs seed the graph only while present, newest and non-discarded.
 * Active placeholders also seed it. Other artifacts appear only as direct
 * parents of a seed, including unavailable and superseded revisions.
 */
export function displayedNodes(nodes: readonly TraceNode[], dismissedRuns: ReadonlySet<number>): TraceNode[] {
  const seeds = nodes.filter((node) => node.artifactId === null
    ? (node.state === "running" || (node.state === "uncertain" && !dismissedRuns.has(node.runId!)))
    : (node.scope === "current" || node.temporary) && isPresentRevision(node));
  const displayed = new Set(seeds.flatMap((node) => [node.key, ...node.parents]));
  return nodes.filter((node) => displayed.has(node.key));
}
