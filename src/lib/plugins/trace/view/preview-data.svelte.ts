/**
 * Backend data shown by Trace's Preview info, cached per key and revision
 * (see revision-cache) so switching between images never clears it to empty.
 */
import { traceForImage, traceRevisionStatus, traceRunDetails, type TraceGraph, type TraceRevisionStatus, type TraceRun } from "$lib/api/trace";
import { createRevisionCache } from "./revision-cache.svelte";

async function runDetails(id: number) {
  const result = await traceRunDetails([id]);
  return result.ok ? { ok: true as const, data: result.data.find((run) => run.id === id) ?? null } : result;
}

export const previewData = {
  runs: createRevisionCache<number, TraceRun | null>(runDetails),
  revisionStatus: createRevisionCache<number, TraceRevisionStatus>(traceRevisionStatus),
  /** Per-image traces, for views without a Trace session. */
  graphs: createRevisionCache<string, TraceGraph | null>(traceForImage),
  clear(): void {
    this.runs.clear();
    this.revisionStatus.clear();
    this.graphs.clear();
  },
};
